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

import { existsSync, readFileSync } from "node:fs";
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
const HEALTH_TIMEOUT_MS = 30_000;

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
  const nexusYaml = join(projectRoot, "nexus.yaml");
  if (existsSync(nexusYaml)) return;

  const opts: NexusInitOptions =
    typeof presetOrOptions === "string" ? { preset: presetOrOptions } : presetOrOptions;

  const channel = opts.channel ?? DEFAULT_NEXUS_CHANNEL;

  const proc = Bun.spawn(["nexus", "init", "--preset", opts.preset, "--channel", channel], {
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
export async function nexusUp(projectRoot: string, opts: NexusUpOptions = {}): Promise<void> {
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
        `nexus-stack.yml not found in ${sourceDir}. ` + "Is this a nexus source checkout?",
      );
    }
  }

  const args = ["nexus", "up", "--timeout", String(timeout)];
  if (wantsBuild && sourceDir) {
    args.push("--build");
    args.push("--compose-file", join(sourceDir, "nexus-stack.yml"));
  }

  const proc = Bun.spawn(args, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Retry without --timeout if the flag is unsupported
    if (stderr.includes("no such option") || stderr.includes("unrecognized arguments")) {
      const fallbackArgs = ["nexus", "up"];
      if (wantsBuild && sourceDir) {
        fallbackArgs.push("--build");
        fallbackArgs.push("--compose-file", join(sourceDir, "nexus-stack.yml"));
      }
      const fallback = Bun.spawn(fallbackArgs, {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const fallbackCode = await fallback.exited;
      if (fallbackCode !== 0) {
        const fallbackStderr = await new Response(fallback.stderr).text();
        throw new Error(`nexus up failed (exit ${fallbackCode}): ${fallbackStderr.trim()}`);
      }
      return;
    }
    throw new Error(`nexus up failed (exit ${code}): ${stderr.trim()}`);
  }
}

/**
 * Run `nexus down` in the project root.
 *
 * Stops Nexus Docker containers. Idempotent — safe to call even if
 * Nexus is not running.
 */
export async function nexusDown(projectRoot: string): Promise<void> {
  try {
    const proc = Bun.spawn(["nexus", "down"], {
      cwd: projectRoot,
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
 * Uses regex-based parsing (no YAML parser dependency). Falls back to
 * DEFAULT_NEXUS_URL if the file is missing or the port can't be
 * determined.
 */
export function readNexusUrl(projectRoot: string): string {
  try {
    const yamlPath = join(projectRoot, "nexus.yaml");
    if (!existsSync(yamlPath)) return DEFAULT_NEXUS_URL;

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
    // Fall through to default
  }
  return DEFAULT_NEXUS_URL;
}

// ---------------------------------------------------------------------------
// API key discovery
// ---------------------------------------------------------------------------

/**
 * Read the Nexus API key from `nexus.yaml`.
 *
 * `nexus init --preset shared|demo` generates an `api_key: sk-<token>`
 * field in `nexus.yaml`. The `local` preset sets `auth: none` and
 * omits the key.
 *
 * Priority:
 * 1. `NEXUS_API_KEY` environment variable (explicit override)
 * 2. `api_key` field in `nexus.yaml`
 * 3. `undefined` (no auth — local preset or unauthenticated server)
 */
export function readNexusApiKey(projectRoot: string): string | undefined {
  // 1. Env var override
  const envKey = process.env.NEXUS_API_KEY;
  if (envKey) return envKey;

  // 2. Read from nexus.yaml
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
 * Polls `GET /health` with exponential backoff up to the timeout.
 * Throws if the server doesn't respond within the deadline.
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
      if (resp.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 4_000);
  }

  throw new Error(`Nexus health check timed out after ${timeoutMs}ms at ${url}`);
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
  const hasNexus = await checkNexusCli();
  if (!hasNexus) {
    throw new Error(
      "nexus CLI not found. Install it with: pip install nexus-ai-fs\n" +
        "Or provide an external Nexus URL with: grove init --nexus-url <url>",
    );
  }

  // Auto-init if nexus.yaml is missing
  const nexusYaml = join(projectRoot, "nexus.yaml");
  if (!existsSync(nexusYaml)) {
    const preset = inferNexusPreset(config);
    const channel = config.nexusChannel ?? DEFAULT_NEXUS_CHANNEL;
    process.stderr.write(`Initializing Nexus (preset: ${preset}, channel: ${channel})...\n`);
    await nexusInit(projectRoot, { preset, channel });
  }

  // Start Nexus
  const buildLabel = upOpts?.nexusSource
    ? ` (source build from ${upOpts.nexusSource})`
    : upOpts?.build
      ? " (--build)"
      : "";
  process.stderr.write(`Starting Nexus${buildLabel}...\n`);
  await nexusUp(projectRoot, upOpts);

  // Discover actual URL — nexus.yaml may have been updated with a
  // different port if the default was already in use (nexus#2918).
  const nexusUrl = config.nexusUrl ?? readNexusUrl(projectRoot);
  process.stderr.write(`Waiting for Nexus at ${nexusUrl}...\n`);
  await waitForNexusHealth(nexusUrl);

  // Read API key (auto-provisioned by nexus init for shared/demo presets)
  const apiKey = readNexusApiKey(projectRoot);
  if (apiKey) {
    process.stderr.write(`Nexus is ready. API key: ${apiKey}\n`);
  } else {
    process.stderr.write("Nexus is ready (auth: none).\n");
  }

  return { url: nexusUrl, apiKey };
}
