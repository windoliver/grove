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
  projectRoot: string,
  presetOrOptions: "local" | "shared" | "demo" | NexusInitOptions,
): Promise<void> {
  const opts: NexusInitOptions =
    typeof presetOrOptions === "string" ? { preset: presetOrOptions } : presetOrOptions;

  // Data lives under the project's .grove/ dir — each project gets its own Nexus stack.
  const dataDir = join(projectRoot, "nexus-data");

  const args = ["nexus", "init", "--preset", opts.preset, "--data-dir", dataDir];
  if (opts.channel) {
    args.push("--channel", opts.channel);
  }
  if (!existsSync(projectRoot)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(projectRoot, { recursive: true });
  }

  const proc = Bun.spawn(args, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`nexus init failed (exit ${code}): ${stderr.trim()}`);
  }
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
  // Run from the project root where nexus.yaml lives (written by nexusInit in the same dir).
  const projectRoot = _projectRoot;
  process.stderr.write(`[nexusUp] cwd=${projectRoot}\n`);
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

  // Issue 6A: build args from a shared base so the --timeout fallback path
  // never diverges (previously the --build / --compose-file block was copy-pasted).
  const buildArgs =
    wantsBuild && sourceDir
      ? ["--build", "--compose-file", join(sourceDir, "nexus-stack.yml")]
      : [];
  const args = ["nexus", "up", "--timeout", String(timeout), "--port-strategy", "auto", ...buildArgs];

  const report = opts.onProgress;

  const proc = Bun.spawn(args, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Issue 16A: ring buffer — keep only the last MAX_STDERR_LINES lines.
  // During a Docker pull, nexus up streams verbose progress to stderr (potentially MBs).
  // We only need the tail for error reporting; the head is discarded to bound memory usage.
  const MAX_STDERR_LINES = 50;
  const stderrLines: string[] = [];
  const stderrPromise = (async () => {
    if (!proc.stderr) return "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          stderrLines.push(line);
          if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
        }
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
    return stderrLines.join("\n");
  })();

  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const stderr = await stderrPromise;
  if (code !== 0) {
    // Retry without --timeout if the flag is unsupported
    if (stderr.includes("no such option") || stderr.includes("unrecognized arguments")) {
      // Issue 6A: reuse buildArgs — no duplication of --build / --compose-file logic.
      const fallbackArgs = ["nexus", "up", "--port-strategy", "auto", ...buildArgs];
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
  const cwd = _projectRoot;
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
  // Read from nexus.yaml in the project root (written by nexusInit there).
  const yamlPath = join(projectRoot, "nexus.yaml");
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

/**
 * Parse the host-bound port for Nexus (2026/tcp) from a `docker ps` Ports field.
 *
 * Matches both IPv4 (`0.0.0.0:PORT->2026/tcp`) and IPv6 (`:::PORT->2026/tcp`) formats.
 * Returns the host port number, or undefined if no host binding for port 2026 is found.
 *
 * Extracted as a pure function for testability.
 */
export function parseNexusPortFromDockerPs(portsField: string): number | undefined {
  // IPv4: "0.0.0.0:PORT->2026/tcp"  — the colon is part of "0.0.0.0:"
  // IPv6: ":::PORT->2026/tcp"        — three colons immediately precede PORT (no extra colon)
  const match = portsField.match(/(?:0\.0\.0\.0:|:::)(\d+)->2026\/tcp/);
  if (!match?.[1]) return undefined;
  const port = Number.parseInt(match[1], 10);
  return port > 0 && port <= 65535 ? port : undefined;
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

  // 2. Read from .state.json in the project's nexus-data dir (authoritative)
  try {
    const stateFile = join(projectRoot, "nexus-data", ".state.json");
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (typeof state.api_key === "string" && state.api_key) {
        return state.api_key;
      }
    }
  } catch {
    // Fall through to nexus.yaml
  }

  // 3. Read from nexus.yaml in the project root
  try {
    const yamlPath = join(projectRoot, "nexus.yaml");
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
 * Issue 1A: no image-ancestor filter — works for any channel (edge, stable, nightly)
 * and source builds. Port 2026 presence in the docker ps output identifies candidates.
 *
 * Issue 13A: batch-inspects all containers needing an IP lookup in a single subprocess
 * call, then probes all candidate URLs in parallel via Promise.any().
 */
export async function discoverRunningNexus(): Promise<string | undefined> {
  try {
    // Query all running containers with their port mappings.
    // No image filter — port 2026 presence is the selector.
    const proc = Bun.spawn(["docker", "ps", "--format", "{{.ID}}|{{.Ports}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code !== 0 || !stdout.trim()) return undefined;

    const hostUrls: string[] = [];
    const containerIdsForInspect: string[] = [];

    for (const line of stdout.trim().split("\n")) {
      const [id, ports] = line.split("|");
      if (!id || !ports) continue;

      // 1. Host-bound port: "0.0.0.0:PORT->2026/tcp" or ":::PORT->2026/tcp"
      const port = parseNexusPortFromDockerPs(ports);
      if (port !== undefined) {
        hostUrls.push(`http://localhost:${port}`);
        continue;
      }

      // 2. Unbound internal port: "2026/tcp" without a host mapping — need container IP.
      //    Only inspect containers that explicitly reference port 2026.
      if (ports.includes("2026")) {
        containerIdsForInspect.push(id.trim());
      }
    }

    // Issue 13A: batch-inspect all containers in one subprocess call instead of N sequential ones.
    const containerUrls: string[] = [];
    if (containerIdsForInspect.length > 0) {
      try {
        const inspectProc = Bun.spawn(
          [
            "docker",
            "inspect",
            ...containerIdsForInspect,
            "--format",
            "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [, inspectOut] = await Promise.all([
          inspectProc.exited,
          new Response(inspectProc.stdout).text(),
        ]);
        for (const ip of inspectOut.trim().split(/\s+/)) {
          if (ip && ip !== "") containerUrls.push(`http://${ip}:2026`);
        }
      } catch {
        // Docker inspect failed — skip container IP fallback
      }
    }

    const candidateUrls = [...hostUrls, ...containerUrls];
    if (candidateUrls.length === 0) return undefined;

    // Issue 13A: parallel health probes — first healthy/starting wins.
    try {
      return await Promise.any(
        candidateUrls.map(async (url) => {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
          const body = (await res.json().catch(() => ({}))) as { status?: string };
          if (body.status === "healthy" || body.status === "starting") return url;
          throw new Error(`not healthy: ${body.status}`);
        }),
      );
    } catch {
      // All probes failed — no reachable Nexus found
      return undefined;
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
  // Use the project root as the working directory for nexus CLI commands.
  // The nexus CLI derives the compose project name from CWD — running from
  // .grove/ creates a different project than running from the project root.
  // nexus.yaml can live in either location; the nexus CLI searches upward.
  const groveHomeDir = projectRoot;
  report(
    `[ensureNexus] projectRoot=${projectRoot} groveDir=${groveHomeDir} mode=${config.mode ?? "none"} nexusManaged=${String(config.nexusManaged)}`,
  );

  // -----------------------------------------------------------------------
  // 1. Fast path: check known URLs for a healthy Nexus BEFORE requiring CLI.
  // -----------------------------------------------------------------------
  // Read last-known port from this project's .grove/nexus-data/.state.json.
  let stateFileUrl: string | undefined;
  try {
    const statePath = join(groveHomeDir, "nexus-data", ".state.json");
    report(
      `[ensureNexus] checking state.json at ${statePath} exists=${String(existsSync(statePath))}`,
    );
    if (existsSync(statePath)) {
      const stateData = JSON.parse(readFileSync(statePath, "utf-8")) as {
        ports?: { http?: number };
      };
      if (stateData.ports?.http) {
        stateFileUrl = `http://localhost:${stateData.ports.http}`;
        report(`[ensureNexus] state.json → port=${stateData.ports.http} url=${stateFileUrl}`);
      }
    }
  } catch {
    // best-effort
  }

  // Also probe container IPs directly — works even when Nexus has no host port binding
  // (Docker Desktop on Mac routes container IPs from the host). Forward-compatible:
  // when Nexus fixes NEXUS_ADVERTISE_HOST, localhost:PORT will work too.
  let containerUrl: string | undefined;
  try {
    containerUrl = await discoverRunningNexus();
  } catch {
    // best-effort
  }

  const candidateUrls = [
    process.env.GROVE_NEXUS_URL, // explicit env override takes highest priority
    containerUrl, // container IP (works without port binding)
    config.nexusUrl,
    readNexusUrl(projectRoot),
    stateFileUrl,
    DEFAULT_NEXUS_URL,
  ].filter((u): u is string => !!u);

  const urlsToTry = [...new Set(candidateUrls)];

  // Issue 2A: probe all candidate URLs concurrently — first healthy/starting wins.
  // Worst-case latency drops from N×3s (sequential) to 3s (parallel).
  report(`[nexus] checking URLs: ${urlsToTry.join(", ")}`);
  let fastResult: { url: string; starting: boolean } | undefined;
  try {
    fastResult = await Promise.any(
      urlsToTry.map(async (url) => {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) throw new Error("not ok");
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        report(`[nexus] ${url} → status=${body.status}`);
        if (body.status === "healthy") return { url, starting: false };
        if (body.status === "starting") return { url, starting: true };
        throw new Error(`not healthy: ${body.status}`);
      }),
    );
  } catch {
    // All probes failed (AggregateError from Promise.any) — fall through to restart/start
    fastResult = undefined;
  }

  if (fastResult) {
    if (fastResult.starting) {
      report("Nexus is starting (waiting for Raft election)...");
      await waitForNexusHealth(fastResult.url);
    }
    // Issue 14A: read apiKey once, scoped to this return path — avoids repeated disk reads.
    const apiKey = readNexusApiKey(projectRoot);
    report("Nexus is ready (already running)");
    return { url: fastResult.url, apiKey };
  }

  // -----------------------------------------------------------------------
  // 2. No running Nexus found — need CLI to start one.
  // -----------------------------------------------------------------------
  const hasNexus = await checkNexusCli();
  if (!hasNexus) {
    throw new Error(
      "nexus CLI not found and no running Nexus instance detected.\n" +
        "Install it with: pip install nexus-ai-fs\n" +
        "Or start Nexus manually with Docker: docker compose -f nexus-stack.yml up -d\n" +
        "Or provide an external Nexus URL with: grove init --nexus-url <url>",
    );
  }

  // -----------------------------------------------------------------------
  // 2. Quick restart: if known compose project exists in state.json, try
  //    `docker compose restart` before falling back to `nexus up` (which pulls).
  //    This handles transient crashes (OOM, signal) without a slow image pull.
  // -----------------------------------------------------------------------
  const nexusYaml = join(groveHomeDir, "nexus.yaml");
  const hasYaml = existsSync(nexusYaml);
  report(`[ensureNexus] nexus.yaml at ${nexusYaml} exists=${String(hasYaml)}`);

  if (hasYaml && !upOpts?.force) {
    // Try a quick `docker compose restart` using the compose project from state.json.
    // This avoids an image pull when the container merely crashed (vs. never started).
    let quickRestartUrl: string | undefined;
    try {
      const statePath = join(groveHomeDir, "nexus-data", ".state.json");
      if (existsSync(statePath)) {
        const stateData = JSON.parse(readFileSync(statePath, "utf-8")) as {
          project_name?: string;
          ports?: { http?: number };
        };
        const projectName = stateData.project_name;
        const httpPort = stateData.ports?.http;
        if (projectName && httpPort) {
          report(`[ensureNexus] quick restart: project=${projectName} port=${httpPort}`);
          // Issue 4A: "up --no-pull -d" handles both stopped and running containers without
          // triggering a Docker pull. "restart" only works on already-running containers and
          // is a no-op when containers are stopped (e.g. after machine reboot).
          const restart = Bun.spawn(
            ["docker", "compose", "-p", projectName, "up", "--no-pull", "-d", "nexus"],
            {
              cwd: groveHomeDir,
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const restartCode = await restart.exited;
          if (restartCode === 0) {
            quickRestartUrl = `http://localhost:${httpPort}`;
            report(`[ensureNexus] quick restart done, checking health at ${quickRestartUrl}...`);
            try {
              await waitForNexusHealth(quickRestartUrl, 30_000);
              const apiKey = readNexusApiKey(groveHomeDir);
              report("Nexus is ready (quick restart)");
              return { url: quickRestartUrl, apiKey };
            } catch {
              report("[ensureNexus] quick restart unhealthy, falling through to nexus up...");
            }
          }
        }
      }
    } catch {
      // best-effort — fall through to nexus up
    }

    // nexus.yaml exists — run `nexus up` (full restart, may pull updated image)
    report(
      "[ensureNexus] warm start: nexus.yaml found, running nexus up to restart stopped containers...",
    );
    const upStdout = await nexusUp(groveHomeDir, upOpts);
    const nexusUrl =
      config.nexusUrl ??
      readNexusUrl(groveHomeDir) ??
      parseNexusUrlFromOutput(upStdout) ??
      DEFAULT_NEXUS_URL;
    report(
      `[ensureNexus] nexus up stdout url: ${parseNexusUrlFromOutput(upStdout) ?? "none"}, using ${nexusUrl}`,
    );
    report(`Waiting for Nexus at ${nexusUrl}...`);
    await waitForNexusHealth(nexusUrl);
    const apiKey = readNexusApiKey(groveHomeDir);
    report(`[ensureNexus] ready, apiKey=${apiKey ? "yes" : "none"}`);
    report("Nexus is ready");
    return { url: nexusUrl, apiKey };
  }

  // -----------------------------------------------------------------------
  // 3. Cold start: init + up (first time only, or force reinit)
  // -----------------------------------------------------------------------
  if (upOpts?.force && hasYaml) {
    report("[ensureNexus] force reinit: stopping existing Nexus...");
    await nexusDown(groveHomeDir);
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
    report(
      `[ensureNexus] cold start: no nexus.yaml, initializing (preset: ${preset}${channelLabel})...`,
    );
    await nexusInit(groveHomeDir, { preset, channel });
  }

  const buildLabel = upOpts?.nexusSource
    ? ` (source build from ${upOpts.nexusSource})`
    : upOpts?.build
      ? " (--build)"
      : "";
  report(`[ensureNexus] starting Nexus${buildLabel}...`);
  const upStdout = await nexusUp(groveHomeDir, upOpts);

  const nexusUrl =
    config.nexusUrl ??
    readNexusUrl(groveHomeDir) ??
    parseNexusUrlFromOutput(upStdout) ??
    DEFAULT_NEXUS_URL;
  report(`[ensureNexus] cold start url=${nexusUrl}, waiting for health...`);
  await waitForNexusHealth(nexusUrl);

  const apiKey = readNexusApiKey(groveHomeDir);
  report(
    apiKey
      ? "[ensureNexus] Nexus is ready, apiKey=yes"
      : "[ensureNexus] Nexus is ready (auth: none)",
  );
  return { url: nexusUrl, apiKey };
}
