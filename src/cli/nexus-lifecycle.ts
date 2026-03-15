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
import { join } from "node:path";
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

/**
 * Run `nexus up` in the project root.
 *
 * Starts Nexus via Docker Compose. Expects `nexus.yaml` to exist.
 * Passes `--timeout` so `nexus up` waits for health checks.
 *
 * Falls back to `nexus up` without `--timeout` if the installed
 * CLI doesn't support the flag (nexus-ai-fs < 0.9.0).
 */
export async function nexusUp(
  projectRoot: string,
  timeoutSeconds: number = NEXUS_UP_TIMEOUT_S,
): Promise<void> {
  const proc = Bun.spawn(["nexus", "up", "--timeout", String(timeoutSeconds)], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Retry without --timeout if the flag is unsupported
    if (stderr.includes("no such option") || stderr.includes("unrecognized arguments")) {
      const fallback = Bun.spawn(["nexus", "up"], {
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

/**
 * Ensure Nexus is running for a managed-nexus grove.
 *
 * Called by `grove up` before spawning grove services:
 * 1. Check nexus CLI availability
 * 2. Auto-init nexus.yaml if missing
 * 3. Run `nexus up`
 * 4. Discover actual URL from nexus.yaml (handles port-conflict resolution)
 * 5. Wait for health check
 *
 * Returns the resolved Nexus URL (may differ from config.nexusUrl if
 * Nexus resolved a port conflict during startup).
 */
export async function ensureNexusRunning(
  projectRoot: string,
  config: GroveConfig,
): Promise<string> {
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
  process.stderr.write("Starting Nexus...\n");
  await nexusUp(projectRoot);

  // Discover actual URL — nexus.yaml may have been updated with a
  // different port if the default was already in use (nexus#2918).
  const nexusUrl = config.nexusUrl ?? readNexusUrl(projectRoot);
  process.stderr.write(`Waiting for Nexus at ${nexusUrl}...\n`);
  await waitForNexusHealth(nexusUrl);
  process.stderr.write("Nexus is ready.\n");

  return nexusUrl;
}
