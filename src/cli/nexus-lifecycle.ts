/**
 * Nexus CLI lifecycle integration.
 *
 * Centralizes all `nexus` CLI subprocess calls (init, up, down)
 * so that `grove init`, `grove up`, and `grove down` can orchestrate
 * the Nexus backend as a managed dependency.
 *
 * Grove shells out to the `nexus` CLI rather than managing Docker
 * containers directly — Nexus owns its own lifecycle and dependency chain.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GroveConfig } from "../core/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Nexus server URL when managed by Grove. */
export const DEFAULT_NEXUS_URL = "http://localhost:2026";

/** Default Nexus image channel. Edge tracks latest develop builds. */
export const DEFAULT_NEXUS_CHANNEL = "edge";

/** Default health-check timeout (ms). */
const HEALTH_TIMEOUT_MS = 120_000;

/** Health-check poll interval (ms). */
const HEALTH_POLL_MS = 1_000;

/** Default `nexus up` timeout (seconds). */
const NEXUS_UP_TIMEOUT_S = 180;

// ---------------------------------------------------------------------------
// Preset inference
// ---------------------------------------------------------------------------

/**
 * Infer the Nexus preset from the grove config.
 *
 * This is a pure mapping — Nexus preset concepts stay out of PresetConfig.
 */
export function inferNexusPreset(config: GroveConfig): "local" | "shared" {
  // Any config that needs a running Nexus server (mode=nexus, nexusManaged,
  // or backend=nexus in the grove preset) requires the "shared" Docker preset.
  // The "local" preset is embedded-only (no Docker, no ports, no compose).
  if (config.mode === "nexus" || config.nexusManaged) return "shared";
  if (config.preset === "swarm-ops") return "shared";
  return "local";
}

// ---------------------------------------------------------------------------
// CLI detection
// ---------------------------------------------------------------------------

/** Check whether the `nexus` CLI is available on PATH. */
export async function checkNexusCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["nexus", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle commands
// ---------------------------------------------------------------------------

/** Options for `nexusInit`. */
export interface NexusInitOptions {
  readonly preset: "local" | "shared" | "demo";
  readonly channel?: string | undefined;
}

/**
 * Run `nexus init --preset <preset> --channel <channel>` in the project root.
 *
 * Generates `nexus.yaml` alongside `GROVE.md` and `.grove/`.
 * No-ops if `nexus.yaml` already exists.
 */
export async function nexusInit(
  _projectRoot: string,
  presetOrOptions: "local" | "shared" | "demo" | NexusInitOptions,
): Promise<void> {
  const opts: NexusInitOptions =
    typeof presetOrOptions === "string" ? { preset: presetOrOptions } : presetOrOptions;

  // Use shared global data_dir so all worktrees reuse the same Nexus Docker stack.
  // nexus uses data_dir as the identity anchor — same data_dir = same compose project.
  const globalDataDir = join(getGroveHome(), "nexus-data");

  const args = ["nexus", "init", "--preset", opts.preset, "--data-dir", globalDataDir];
  if (opts.channel) {
    args.push("--channel", opts.channel);
  }
  // Run nexus init from the global grove directory so nexus.yaml lives there
  const groveHome = getGroveHome();
  if (!existsSync(groveHome)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(groveHome, { recursive: true });
  }

  const proc = Bun.spawn(args, {
    cwd: groveHome,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`nexus init failed (exit ${code}): ${stderr.trim()}`);
  }
}

/**
 * Get the global grove home directory where nexus.yaml lives.
 * All worktrees share one Nexus stack via this shared location.
 */
function getGroveHome(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".grove");
}

/** Options for `nexusUp`. */
export interface NexusUpOptions {
  /** Timeout in seconds for health checks (default: 180). */
  readonly timeoutSeconds?: number | undefined;
  /**
   * Build Nexus from source instead of pulling a pre-built image.
   *
   * Requires a nexus source checkout — resolved via:
   * 1. `nexusSource` option (explicit path)
   * 2. `NEXUS_SOURCE` environment variable
   *
   * The repo-checkout `nexus-stack.yml` has a `build:` directive
   * that points at the local Dockerfile. The pip-installed bundled
   * compose file does NOT — so `--build` without a source path
   * will be silently ignored by `nexus up`.
   */
  readonly build?: boolean | undefined;
  /**
   * Path to a local nexus source checkout (e.g., `~/nexus`).
   * When set, `nexus up --build` runs with `--compose-file` pointing
   * at the repo's `nexus-stack.yml` so Docker Compose uses the local
   * build context (Dockerfile + maturin Rust extensions). Implies `--build`.
   */
  readonly nexusSource?: string | undefined;
  /** Optional progress callback — replaces stderr writes when provided (e.g. TUI context). */
  readonly onProgress?: ((step: string) => void) | undefined;
  /** Force re-init nexus.yaml even if it exists (e.g. "New grove" flow). */
  readonly force?: boolean | undefined;
}

/**
 * Resolve the nexus source directory for `--build`.
 *
 * Priority:
 * 1. Explicit `nexusSource` option
 * 2. `NEXUS_SOURCE` environment variable
 * 3. `undefined` (no source — `--build` will be rejected)
 */
function resolveNexusSource(explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  const envSource = process.env.NEXUS_SOURCE;
  if (envSource) return resolve(envSource);
  return undefined;
}

/**
 * Run `nexus up` in the project root.
 *
 * Starts Nexus via Docker Compose. Expects `nexus.yaml` to exist.
 * Passes `--timeout` so `nexus up` waits for health checks.
 *
 * When `build` is true (or `nexusSource` is set), passes `--build`
 * and `--compose-file` pointing at the source repo's `nexus-stack.yml`
 * so Docker Compose uses the local build context instead of pulling
 * from GHCR.
 *
 * Falls back to `nexus up` without `--timeout` if the installed
 * CLI doesn't support the flag (nexus-ai-fs < 0.9.0).
 */
export async function nexusUp(_projectRoot: string, opts: NexusUpOptions = {}): Promise<string> {
  // Always run from global grove home — all projects share one Nexus stack
  const projectRoot = getGroveHome();
  const timeout = opts.timeoutSeconds ?? NEXUS_UP_TIMEOUT_S;
  const wantsBuild = opts.build || !!opts.nexusSource;

  // Resolve source directory for --build
  let sourceDir: string | undefined;
  if (wantsBuild) {
    sourceDir = resolveNexusSource(opts.nexusSource);
    if (!sourceDir) {
      throw new Error(
        "--build requires a nexus source checkout.\n" +
          "Provide one with: grove up --nexus-source ~/nexus\n" +
          "Or set: export NEXUS_SOURCE=~/nexus",
      );
    }
    if (!existsSync(sourceDir)) {
      throw new Error(`Nexus source directory not found: ${sourceDir}`);
    }
    const composeFile = join(sourceDir, "nexus-stack.yml");
    if (!existsSync(composeFile)) {
      throw new Error(
        `nexus-stack.yml not found in ${sourceDir}. Is this a nexus source checkout?`,
      );
    }
  }

  const args = ["nexus", "up", "--timeout", String(timeout), "--port-strategy", "auto"];
  if (wantsBuild && sourceDir) {
    args.push("--build");
    args.push("--compose-file", join(sourceDir, "nexus-stack.yml"));
  }

  const report = opts.onProgress;

  const proc = Bun.spawn(args, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Collect stderr while optionally streaming to progress callback
  const stderrChunks: string[] = [];
  const stderrPromise = (async () => {
    if (!proc.stderr) return "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stderrChunks.push(text);
        if (report) {
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) report(`  ${trimmed}`);
          }
        }
      }
    } catch {
      // Stream closed
    }
    return stderrChunks.join("");
  })();

  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const stderr = await stderrPromise;
  if (code !== 0) {
    // Retry without --timeout if the flag is unsupported
    if (stderr.includes("no such option") || stderr.includes("unrecognized arguments")) {
      const fallbackArgs = ["nexus", "up", "--port-strategy", "auto"];
      if (wantsBuild && sourceDir) {
        fallbackArgs.push("--build");
        fallbackArgs.push("--compose-file", join(sourceDir, "nexus-stack.yml"));
      }
      const fallback = Bun.spawn(fallbackArgs, {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [fallbackCode, fallbackStdout] = await Promise.all([
        fallback.exited,
        new Response(fallback.stdout).text(),
      ]);
      if (fallbackCode !== 0) {
        const fallbackStderr = await new Response(fallback.stderr).text();
        throw new Error(`nexus up failed (exit ${fallbackCode}): ${fallbackStderr.trim()}`);
      }
      return fallbackStdout;
    }
    throw new Error(`nexus up failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Run `nexus down` in the project root.
 *
 * Stops Nexus Docker containers. Idempotent — safe to call even if
 * Nexus is not running.
 */
export async function nexusDown(_projectRoot: string): Promise<void> {
  // Always run from global grove home
  const cwd = getGroveHome();
  try {
    const proc = Bun.spawn(["nexus", "down"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    // Ignore exit code — nexus down is idempotent
  } catch {
    // nexus CLI not available — nothing to stop
  }
}

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

/**
 * Read the Nexus HTTP server URL from `nexus.yaml` after `nexus up`.
 *
 * nexus#2918 materializes ports under `ports.http` / `ports.grpc` in
 * nexus.yaml (see `init_cmd.py:_build_config`). The HTTP port is the
 * one grove cares about for health checks and API calls.
 *
 * Uses regex-based parsing (no YAML parser dependency). Returns
 * undefined if the file is missing or the port can't be determined
 * — callers should not fall back to a hardcoded default to avoid
 * accidentally connecting to another user's Nexus instance.
 */
export function readNexusUrl(projectRoot: string): string | undefined {
  // Read from nexus.yaml (configured ports). Check project-local first, then global.
  const localYaml = join(projectRoot, "nexus.yaml");
  const globalYaml = join(getGroveHome(), "nexus.yaml");
  const yamlPath = existsSync(localYaml) ? localYaml : globalYaml;
  try {
    if (!existsSync(yamlPath)) return undefined;

    const content = readFileSync(yamlPath, "utf-8");

    // nexus.yaml shape (from nexus#2918 init_cmd.py):
    //   ports:
    //     http: 2026
    //     grpc: 2028
    //     postgres: 5432
    //
    // Match the `http:` key inside a `ports:` block.
    // The regex finds `ports:` then scans for `http: <number>` on a
    // subsequent indented line.
    const portsBlock = content.match(/^ports:\s*\n((?:[ \t]+\S.*\n?)*)/m);
    if (portsBlock?.[1]) {
      const httpMatch = portsBlock[1].match(/http:\s*['"]?(\d+)/);
      if (httpMatch?.[1]) {
        const port = Number.parseInt(httpMatch[1], 10);
        if (port > 0 && port <= 65535) {
          return `http://localhost:${port}`;
        }
      }
    }
  } catch {
    // Fall through
  }
  return undefined;
}

/**
 * Parse the Nexus HTTP URL from `nexus up` stdout.
 *
 * `nexus up` prints a service table like:
 *   nexus       http://localhost:2122
 *
 * We extract the URL from the line matching "nexus" + "http://".
 */
function parseNexusUrlFromOutput(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = line.match(/nexus\s+(https?:\/\/\S+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// API key discovery
// ---------------------------------------------------------------------------

/**
 * Read the Nexus API key.
 *
 * Priority:
 * 1. `NEXUS_API_KEY` environment variable (explicit override)
 * 2. `.state.json` in data_dir (authoritative — written by `nexus up`)
 * 3. `api_key` field in `nexus.yaml`
 * 4. `undefined` (no auth — local preset or unauthenticated server)
 */
export function readNexusApiKey(projectRoot: string): string | undefined {
  // 1. Env var override
  const envKey = process.env.NEXUS_API_KEY;
  if (envKey) return envKey;

  // 2. Read from .state.json (authoritative — written by nexus up with resolved state)
  try {
    const globalDataDir = join(getGroveHome(), "nexus-data");
    const stateFile = join(globalDataDir, ".state.json");
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (typeof state.api_key === "string" && state.api_key) {
        return state.api_key;
      }
    }
  } catch {
    // Fall through to nexus.yaml
  }

  // 3. Read from nexus.yaml (global shared — all worktrees use same Nexus)
  try {
    const globalYaml = join(getGroveHome(), "nexus.yaml");
    const localYaml = join(projectRoot, ".grove", "nexus.yaml");
    const yamlPath = existsSync(localYaml) ? localYaml : globalYaml;
    if (!existsSync(yamlPath)) return undefined;

    const content = readFileSync(yamlPath, "utf-8");

    // Match top-level `api_key: <value>` (not inside a nested block).
    // Nexus init_cmd.py writes: api_key: sk-<32-char-hex>
    const match = content.match(/^api_key:\s*['"]?(\S+?)['"]?\s*$/m);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Wait for the Nexus server to become healthy.
 *
 * Polls `GET /health` and checks the JSON body for `status: "healthy"`.
 * Nexus returns 200 OK with `status: "starting"` during Raft leader election,
 * so checking HTTP status alone is insufficient.
 */
export async function waitForNexusHealth(
  url: string = DEFAULT_NEXUS_URL,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = HEALTH_POLL_MS;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string };
        if (body.status === "healthy") return;
        // "starting" — Raft election in progress, keep polling
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 4_000);
  }

  throw new Error(`Nexus health check timed out after ${timeoutMs}ms at ${url}`);
}

// ---------------------------------------------------------------------------
// Container discovery
// ---------------------------------------------------------------------------

/**
 * Discover a running Nexus container via Docker and return its URL.
 *
 * Scans `docker ps` for containers matching the Nexus image, extracts
 * the mapped host port for 2026/tcp, and health-checks it.
 * This lets Grove reuse a Nexus stack started from any directory.
 */
export async function discoverRunningNexus(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(
      [
        "docker",
        "ps",
        "--filter",
        "ancestor=ghcr.io/nexi-lab/nexus:edge",
        "--format",
        "{{.Ports}}",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code !== 0 || !stdout.trim()) return undefined;

    // Parse port mappings like "0.0.0.0:27960->2026/tcp"
    for (const line of stdout.trim().split("\n")) {
      const match = line.match(/(?:0\.0\.0\.0|:::):(\d+)->2026\/tcp/);
      if (match?.[1]) {
        const port = match[1];
        const url = `http://localhost:${port}`;
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
          const body = (await res.json().catch(() => ({}))) as { status?: string };
          // Accept both healthy and starting (starting = Raft election, will become healthy)
          if (body.status === "healthy" || body.status === "starting") return url;
        } catch {
          // Not reachable despite container running
        }
      }
    }
  } catch {
    // Docker not available or command failed
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Composite helpers
// ---------------------------------------------------------------------------

/** Result from `ensureNexusRunning`. */
export interface NexusRunningInfo {
  /** Resolved Nexus HTTP URL (may differ from config if port conflict resolved). */
  readonly url: string;
  /** API key from nexus.yaml or NEXUS_API_KEY env var (undefined for auth: none). */
  readonly apiKey: string | undefined;
}

/**
 * Ensure Nexus is running for a managed-nexus grove.
 *
 * Called by `grove up` before spawning grove services:
 * 1. Check nexus CLI availability
 * 2. Auto-init nexus.yaml if missing
 * 3. Run `nexus up` (with optional `--build` / source path)
 * 4. Discover actual URL from nexus.yaml (handles port-conflict resolution)
 * 5. Read API key from nexus.yaml (auto-provisioned by `nexus init`)
 * 6. Wait for health check
 *
 * Returns the resolved Nexus URL and API key. The URL may differ from
 * config.nexusUrl if Nexus resolved a port conflict during startup.
 */
export async function ensureNexusRunning(
  projectRoot: string,
  config: GroveConfig,
  upOpts?: NexusUpOptions,
): Promise<NexusRunningInfo> {
  const report = upOpts?.onProgress ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const hasNexus = await checkNexusCli();
  if (!hasNexus) {
    throw new Error(
      "nexus CLI not found. Install it with: pip install nexus-ai-fs\n" +
        "Or provide an external Nexus URL with: grove init --nexus-url <url>",
    );
  }

  // -----------------------------------------------------------------------
  // 1. Fast path: check known URLs for a healthy Nexus (any existing stack)
  // -----------------------------------------------------------------------
  const candidateUrls = [
    config.nexusUrl,
    readNexusUrl(projectRoot),
    process.env.GROVE_NEXUS_URL,
  ].filter((u): u is string => !!u);

  const urlsToTry = [...new Set(candidateUrls)];

  for (const url of urlsToTry) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json().catch(() => ({}))) as { status?: string };
      if (body.status === "healthy") {
        const apiKey = readNexusApiKey(projectRoot);
        report("Nexus is ready (already running)");
        return { url, apiKey };
      }
      if (body.status === "starting") {
        report("Nexus is starting (waiting for Raft election)...");
        await waitForNexusHealth(url);
        const apiKey = readNexusApiKey(projectRoot);
        report("Nexus is ready");
        return { url, apiKey };
      }
    } catch {
      // Not reachable — try next
    }
  }

  // Also try discovering a running Nexus container via Docker directly.
  const discoveredUrl = await discoverRunningNexus();
  if (discoveredUrl) {
    report(`Discovered Nexus at ${discoveredUrl}, waiting for healthy...`);
    await waitForNexusHealth(discoveredUrl);
    const apiKey = readNexusApiKey(projectRoot);
    report("Nexus is ready");
    return { url: discoveredUrl, apiKey };
  }

  // -----------------------------------------------------------------------
  // 2. Check for stopped containers we can restart (seconds, not minutes)
  // -----------------------------------------------------------------------
  const groveHome = getGroveHome();
  const nexusYaml = join(groveHome, "nexus.yaml");
  const hasYaml = existsSync(nexusYaml);

  if (hasYaml && !upOpts?.force) {
    // nexus.yaml exists — try `nexus up` which restarts stopped containers
    report("Starting Nexus...");
    const upStdout = await nexusUp(projectRoot, upOpts);
    const nexusUrl =
      config.nexusUrl ??
      readNexusUrl(projectRoot) ??
      parseNexusUrlFromOutput(upStdout) ??
      DEFAULT_NEXUS_URL;
    report(`Waiting for Nexus at ${nexusUrl}...`);
    await waitForNexusHealth(nexusUrl);
    const apiKey = readNexusApiKey(projectRoot);
    report("Nexus is ready");
    return { url: nexusUrl, apiKey };
  }

  // -----------------------------------------------------------------------
  // 3. Cold start: init + up (first time only, or force reinit)
  // -----------------------------------------------------------------------
  if (upOpts?.force && hasYaml) {
    report("Stopping existing Nexus...");
    await nexusDown(projectRoot);
    try {
      unlinkSync(nexusYaml);
    } catch {
      /* didn't exist */
    }
  }

  if (!existsSync(nexusYaml)) {
    const preset = inferNexusPreset(config);
    const isBuildingFromSource = upOpts?.build || !!upOpts?.nexusSource;
    const channel = isBuildingFromSource
      ? undefined
      : (config.nexusChannel ?? DEFAULT_NEXUS_CHANNEL);
    const channelLabel = channel ? `, channel: ${channel}` : ", source build";
    report(`Initializing Nexus (preset: ${preset}${channelLabel})...`);
    await nexusInit(projectRoot, { preset, channel });
  }

  const buildLabel = upOpts?.nexusSource
    ? ` (source build from ${upOpts.nexusSource})`
    : upOpts?.build
      ? " (--build)"
      : "";
  report(`Starting Nexus${buildLabel}...`);
  const upStdout = await nexusUp(projectRoot, upOpts);

  const nexusUrl =
    config.nexusUrl ??
    readNexusUrl(projectRoot) ??
    parseNexusUrlFromOutput(upStdout) ??
    DEFAULT_NEXUS_URL;
  report(`Waiting for Nexus at ${nexusUrl}...`);
  await waitForNexusHealth(nexusUrl);

  const apiKey = readNexusApiKey(projectRoot);
  report(apiKey ? "Nexus is ready" : "Nexus is ready (auth: none)");
  return { url: nexusUrl, apiKey };
}
