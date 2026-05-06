/**
 * Nexus CLI lifecycle integration.
 *
 * Centralizes all `nexus` CLI subprocess calls (up, down)
 * so that `grove init`, `grove up`, and `grove down` can orchestrate
 * the Nexus backend as a managed dependency.
 *
 * Grove generates nexus.yaml directly (no `nexus init` shell-out) and
 * derives a stable per-worktree port from the workspace path so each
 * worktree gets an isolated Nexus instance.
 */

import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
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
// Port derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable per-worktree port from the absolute workspace path.
 *
 * Uses FNV-1a 32-bit hash mapped to [10000, 59999]. Same cwd always
 * produces the same port — stable across restarts, unique per worktree.
 * Collision probability per worktree pair: ~1 in 50 000.
 */
export function derivePort(cwd: string): number {
  let hash = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < cwd.length; i++) {
    hash ^= cwd.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0; // FNV prime, keep 32-bit unsigned
  }
  return 10000 + (hash % 50000); // [10000, 59999]
}

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
// State file
// ---------------------------------------------------------------------------

/** Shape of nexus-data/.state.json (written by `nexus up`). */
export interface NexusState {
  readonly ports?: { readonly http?: number; readonly grpc?: number };
  readonly project_name?: string;
  readonly api_key?: string;
}

/**
 * Read and parse nexus-data/.state.json.
 *
 * Single source of truth for all state.json reads — replaces the three
 * duplicated read+parse blocks that previously existed across this file.
 * Returns undefined if the file is missing or cannot be parsed.
 */
export function readNexusState(projectRoot: string): NexusState | undefined {
  try {
    const statePath = join(projectRoot, "nexus-data", ".state.json");
    if (!existsSync(statePath)) return undefined;
    return JSON.parse(readFileSync(statePath, "utf-8")) as NexusState;
  } catch {
    return undefined;
  }
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
// YAML generation
// ---------------------------------------------------------------------------

/** Options for generateNexusYaml. */
export interface GenerateNexusYamlOptions {
  readonly preset: "local" | "shared" | "demo";
  readonly channel?: string | undefined;
  /**
   * HTTP port for this Nexus instance.
   * Defaults to derivePort(projectRoot) — stable per-worktree port.
   */
  readonly port?: number | undefined;
  /**
   * Directory for Nexus data (SQLite, state, logs).
   * Defaults to join(projectRoot, "nexus-data").
   */
  readonly dataDir?: string | undefined;
}

/**
 * Generate nexus.yaml directly in the project root.
 *
 * Replaces `nexus init` for YAML generation — eliminates the external CLI
 * dependency on cold start. No-ops if nexus.yaml already exists (caller
 * must delete it first for force re-init).
 *
 * Derives port from the workspace path (FNV-1a hash) so each worktree gets
 * a stable, unique port. Generates an API key for presets that require auth.
 */
export function generateNexusYaml(projectRoot: string, opts: GenerateNexusYamlOptions): void {
  const yamlPath = join(projectRoot, "nexus.yaml");
  if (existsSync(yamlPath)) return;

  if (!existsSync(projectRoot)) {
    mkdirSync(projectRoot, { recursive: true });
  }

  const port = opts.port ?? derivePort(projectRoot);
  const dataDir = opts.dataDir ?? join(projectRoot, "nexus-data");
  const isShared = opts.preset !== "local";
  const apiKey = isShared ? `sk-${randomBytes(16).toString("hex")}` : undefined;

  // Port layout matches nexus init output: http, http+1, http+2, http+3, http+4
  const ports: Record<string, number> = { http: port, grpc: port + 1 };
  if (isShared) {
    ports.postgres = port + 2;
    ports.dragonfly = port + 3;
    ports.zoekt = port + 4;
  }

  const config: Record<string, unknown> = {
    preset: opts.preset,
    data_dir: dataDir,
    auth: isShared ? "static" : "none",
    tls: false,
    services: isShared ? ["nexus", "postgres", "dragonfly", "zoekt"] : ["nexus"],
    ports,
    compose_profiles: isShared ? ["core", "cache", "search"] : ["core"],
  };

  if (apiKey) config.api_key = apiKey;

  writeFileSync(yamlPath, `# Generated by grove\n${yamlStringify(config)}`, "utf-8");
}

// ---------------------------------------------------------------------------
// Compose file provisioning
// ---------------------------------------------------------------------------

/**
 * Ensure `nexus-stack.yml` (and `001-enable-pgvector.sql`) exist in projectRoot.
 *
 * `nexus up` runs `docker compose` from the project root and requires
 * `nexus-stack.yml` to be present there. Grove's `generateNexusYaml` creates
 * `nexus.yaml` but not the compose file — this function fills that gap,
 * replacing the `nexus init` copy step we eliminated.
 *
 * Resolution order for the source file:
 * 1. Already present in projectRoot → no-op
 * 2. nexus Python package bundled data (via importlib.resources)
 * 3. ~/.grove/nexus-stack.yml (copied there by a prior `nexus init`)
 *
 * Also copies `001-enable-pgvector.sql` alongside it when available, since
 * the compose file references it as an init script for the postgres service.
 */
export async function ensureNexusComposeFile(projectRoot: string): Promise<void> {
  const destCompose = join(projectRoot, "nexus-stack.yml");
  if (existsSync(destCompose)) {
    patchNexusComposeFile(destCompose);
    return;
  }

  // 1. Try the nexus Python package bundled data directory.
  let sourceDir: string | undefined;
  try {
    const proc = Bun.spawn(
      [
        "python3",
        "-c",
        "import importlib.resources; p = importlib.resources.files('nexus.cli.data'); print(p)",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code === 0) {
      const candidate = out.trim();
      if (candidate && existsSync(join(candidate, "nexus-stack.yml"))) {
        sourceDir = candidate;
      }
    }
  } catch {
    // Python not available or nexus package not installed
  }

  // 2. Fall back to ~/.grove/nexus-stack.yml (left by a prior `nexus init`).
  if (!sourceDir) {
    const groveHome = join(homedir(), ".grove");
    if (existsSync(join(groveHome, "nexus-stack.yml"))) {
      sourceDir = groveHome;
    }
  }

  if (!sourceDir) {
    throw new Error(
      "nexus-stack.yml not found.\n" +
        "Install the nexus Python package (pip install nexus-ai-fs) or\n" +
        "run `nexus init` once in this project directory to provision the compose file.",
    );
  }

  copyFileSync(join(sourceDir, "nexus-stack.yml"), destCompose);
  patchNexusComposeFile(destCompose);

  // Also copy the pgvector init SQL if present (postgres init script).
  const sqlFile = "001-enable-pgvector.sql";
  const srcSql = join(sourceDir, sqlFile);
  if (existsSync(srcSql)) {
    const destSql = join(projectRoot, sqlFile);
    if (!existsSync(destSql)) copyFileSync(srcSql, destSql);
  }
}

export function normalizeNexusComposeForGrove(content: string): string {
  return content.replace(
    /NEXUS_SEARCH_DAEMON:\s*"true"/g,
    `NEXUS_SEARCH_DAEMON: "\${NEXUS_SEARCH_DAEMON:-true}"`,
  );
}

function patchNexusComposeFile(path: string): void {
  try {
    const current = readFileSync(path, "utf-8");
    const next = normalizeNexusComposeForGrove(current);
    if (next !== current) writeFileSync(path, next, "utf-8");
  } catch {
    // Best-effort: nexus up will surface real compose errors.
  }
}

// ---------------------------------------------------------------------------
// Lifecycle commands
// ---------------------------------------------------------------------------

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
 * Build the arg list for `nexus up`.
 *
 * Centralised so the primary call and the `--timeout`-fallback both get
 * the same flags, preventing silent divergence (e.g. missing --port-strategy).
 */
function buildNexusUpArgs(opts: {
  wantsBuild: boolean;
  sourceDir?: string | undefined;
  timeout?: number | undefined;
}): string[] {
  const args = ["nexus", "up", "--port-strategy", "auto"];
  if (opts.timeout != null) args.push("--timeout", String(opts.timeout));
  if (opts.wantsBuild && opts.sourceDir) {
    args.push("--build", "--compose-file", join(opts.sourceDir, "nexus-stack.yml"));
  }
  return args;
}

function readConfiguredHttpPort(projectRoot: string): number | undefined {
  try {
    const yamlPath = join(projectRoot, "nexus.yaml");
    if (!existsSync(yamlPath)) return undefined;
    const parsed = yamlParse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown> | null;
    const http = (parsed?.ports as Record<string, unknown> | undefined)?.http;
    if (typeof http === "number" && http > 0 && http <= 65530) return http;
  } catch {
    // Fall through to derived port.
  }
  return undefined;
}

function buildNexusUpEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!env.NEXUS_SEARCH_DAEMON) {
    env.NEXUS_SEARCH_DAEMON = "false";
  }
  if (!env.NEXUS_APPROVALS_GRPC_PORT) {
    const httpPort = readConfiguredHttpPort(projectRoot) ?? derivePort(projectRoot);
    env.NEXUS_APPROVALS_GRPC_PORT = String(httpPort + 5);
  }
  return env;
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
  const projectRoot = _projectRoot;
  const report = opts.onProgress ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  report(`[nexusUp] cwd=${projectRoot}`);

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

  const args = buildNexusUpArgs({ wantsBuild, sourceDir, timeout });
  const env = buildNexusUpEnv(projectRoot);

  const proc = Bun.spawn(args, {
    cwd: projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Ring buffer: keep only the last MAX_STDERR_LINES lines.
  // During a Docker pull, nexus up streams verbose progress output to stderr
  // (potentially MBs). We only need the tail for error reporting and the
  // "no such option" fallback check — discard older lines to bound memory.
  const MAX_STDERR_LINES = 50;
  // Chunk-safe partial-line carry-over: a read() boundary can split the
  // "no such option: --timeout" substring across two chunks, causing the
  // substring check to miss. Carry the incomplete final line into the next
  // read so substring checks always operate on complete lines.
  // Cap at MAX_PARTIAL_BYTES so a single chunk with no newlines can't grow unboundedly
  // (e.g. Docker pull CR-delimited progress that fills an entire read buffer).
  const MAX_PARTIAL_BYTES = 4_096;
  const stderrLines: string[] = [];
  let partialLine = "";
  const stderrPromise = (async () => {
    if (!proc.stderr) return "";
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const combined = partialLine + text;
        // Split on \r\n, \n, or bare \r (Docker pull uses \r for in-place progress lines)
        const lines = combined.split(/\r\n|\n|\r/);
        // Last element is the incomplete carry-over (empty string if text ended with a newline)
        partialLine = (lines.pop() ?? "").slice(-MAX_PARTIAL_BYTES);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            report(`  ${trimmed}`);
            stderrLines.push(trimmed);
            if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
          }
        }
      }
    } catch {
      // Stream closed
    }
    // Flush any remaining partial line at EOF
    if (partialLine.trim()) {
      stderrLines.push(partialLine.trim());
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
    }
    return stderrLines.join("\n");
  })();

  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const stderr = await stderrPromise;
  if (code !== 0) {
    // Retry without --timeout if the flag is unsupported (nexus-ai-fs < 0.9.0).
    // Both primary and fallback use buildNexusUpArgs — no flag divergence.
    if (stderr.includes("no such option") || stderr.includes("unrecognized arguments")) {
      const fallbackArgs = buildNexusUpArgs({ wantsBuild, sourceDir, timeout: undefined });
      const fallback = Bun.spawn(fallbackArgs, {
        cwd: projectRoot,
        env,
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
 * Returns undefined if the file is missing or the port can't be
 * determined — callers should not fall back to a hardcoded default
 * to avoid accidentally connecting to another user's Nexus instance.
 */
export function readNexusUrl(projectRoot: string): string | undefined {
  const yamlPath = join(projectRoot, "nexus.yaml");
  try {
    if (!existsSync(yamlPath)) return undefined;
    const parsed = yamlParse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown> | null;
    const http = (parsed?.ports as Record<string, unknown> | undefined)?.http;
    if (typeof http === "number" && http > 0 && http <= 65535) {
      return `http://localhost:${http}`;
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

  // 2. Read from .state.json via unified helper
  const state = readNexusState(projectRoot);
  if (state?.api_key) return state.api_key;

  // 3. Read from nexus.yaml
  try {
    const yamlPath = join(projectRoot, "nexus.yaml");
    if (!existsSync(yamlPath)) return undefined;
    const parsed = yamlParse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown> | null;
    const apiKey = parsed?.api_key;
    if (typeof apiKey === "string" && apiKey) return apiKey;
  } catch {
    // Fall through
  }
  return undefined;
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
 * When `projectRoot` is provided, only returns a URL if it belongs to
 * this worktree (verified by port matching against `derivePort(projectRoot)`).
 * This prevents cross-worktree session leakage when multiple Nexus instances
 * are running on different ports.
 *
 * First checks host-bound port mappings (0.0.0.0:PORT->2026/tcp).
 * Then falls back to container internal IPs (for containers started without
 * host port bindings, e.g. via docker compose without ports: section).
 */
/**
 * Parse the host-bound port for Nexus's internal port 2026 from a `docker ps` ports string.
 *
 * Returns the host port number when a host→2026 mapping exists and the port is valid (> 0).
 * Returns undefined for unbound internal ports, non-2026 mappings, or invalid input.
 *
 * Exported as a pure function so it can be unit-tested without Docker.
 *
 * Examples:
 *   "0.0.0.0:27960->2026/tcp"  → 27960
 *   ":::27960->2026/tcp"        → 27960   (IPv6)
 *   "2026/tcp"                  → undefined (no host binding)
 *   "0.0.0.0:8080->8080/tcp"   → undefined (not port 2026)
 *   "0.0.0.0:5432->5432/tcp, 0.0.0.0:33219->2026/tcp" → 33219 (multi-port)
 */
export function parseNexusPortFromDockerPs(ports: string): number | undefined {
  // Match "0.0.0.0:<port>->2026/tcp" or ":::<port>->2026/tcp" (IPv6).
  // The colon is part of each alternative so the captured group is just digits.
  const m = ports.match(/(?:0\.0\.0\.0:|:::)(\d+)->2026\/tcp/);
  if (!m?.[1]) return undefined;
  const port = Number(m[1]);
  return port > 0 ? port : undefined;
}

export async function discoverRunningNexus(projectRoot?: string): Promise<string | undefined> {
  const ownedPort = projectRoot ? derivePort(projectRoot) : undefined;

  try {
    // Get all running containers with their ports.
    // We filter by port ->2026/tcp in the parsing step rather than using
    // --filter ancestor= because the nexus image tag varies (:edge, :latest,
    // :stable) across installations. Port 2026 is Nexus's well-known internal
    // port — every nexus container exposes it.
    const proc = Bun.spawn(["docker", "ps", "--format", "{{.ID}}|{{.Ports}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code !== 0 || !stdout.trim()) return undefined;

    const candidateUrls: string[] = [];

    for (const line of stdout.trim().split("\n")) {
      const [id, ports] = line.split("|");
      if (!id || !ports) continue;

      // Only process containers that expose Nexus's internal port 2026.
      // This skips postgres/dragonfly/zoekt sidecars in the same compose project.
      if (!ports.includes("2026")) continue;

      // 1. Prefer host-bound port via pure parse function (testable without Docker).
      const hostPort = parseNexusPortFromDockerPs(ports);
      if (hostPort) {
        candidateUrls.push(`http://localhost:${hostPort}`);
        continue;
      }

      // 2. Fall back: inspect container for internal IP + use Nexus default port 2026
      try {
        const inspectProc = Bun.spawn(
          [
            "docker",
            "inspect",
            id.trim(),
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
          if (ip && ip !== "") candidateUrls.push(`http://${ip}:2026`);
        }
      } catch {
        // Docker inspect failed — skip
      }
    }

    for (const url of candidateUrls) {
      // Ownership check: if we have a projectRoot, only accept URLs on our derived port.
      if (ownedPort !== undefined) {
        try {
          const urlPort = new URL(url).port ? Number(new URL(url).port) : 80;
          if (urlPort !== ownedPort) continue;
        } catch {
          continue;
        }
      }

      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        // Accept both healthy and starting (starting = Raft election, will become healthy)
        if (body.status === "healthy" || body.status === "starting") return url;
      } catch {
        // Not reachable — try next candidate
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
 * 1. Probe all candidate URLs in parallel — reuse any healthy instance
 * 2. Generate nexus.yaml directly if missing (no `nexus init` shell-out)
 * 3. Run `nexus up` (with optional `--build` / source path)
 * 4. Discover actual URL from nexus.yaml (handles port-conflict resolution)
 * 5. Read API key from nexus.yaml (auto-provisioned by generateNexusYaml)
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
  const groveHomeDir = projectRoot;

  report(
    `[ensureNexus] projectRoot=${projectRoot} mode=${config.mode ?? "none"} nexusManaged=${String(config.nexusManaged)}`,
  );

  // -----------------------------------------------------------------------
  // 1. Fast path: probe all known URLs in parallel — reuse any healthy Nexus.
  //    All probes fire simultaneously; first healthy response wins.
  // -----------------------------------------------------------------------

  // Derive our stable per-worktree port upfront — used both for discovery
  // and for YAML generation on cold start.
  const derivedPort = derivePort(projectRoot);

  // Read state once; used for port and project_name below.
  const state = readNexusState(groveHomeDir);
  const stateFileUrl = state?.ports?.http ? `http://localhost:${state.ports.http}` : undefined;

  report(`[ensureNexus] derived port=${derivedPort} state url=${stateFileUrl ?? "none"}`);

  // Discover any running container belonging to this worktree.
  let containerUrl: string | undefined;
  try {
    containerUrl = await discoverRunningNexus(projectRoot);
  } catch {
    // best-effort
  }

  // Only probe URLs we can verify belong to this worktree.
  // DEFAULT_NEXUS_URL is intentionally excluded — it could match any running
  // Nexus instance (e.g. another project via OrbStack port forwarding) and
  // would cause cross-worktree session leakage.
  const candidateUrls = [
    process.env.GROVE_NEXUS_URL, // explicit user override (highest priority)
    containerUrl, // docker container on our derived port
    config.nexusUrl, // persisted from a previous successful start
    readNexusUrl(projectRoot), // our nexus.yaml (has our derived port)
    stateFileUrl, // our state.json
    // DEFAULT_NEXUS_URL intentionally excluded — it could match any running
    // Nexus instance (e.g. another project via OrbStack port forwarding)
    // and would cause cross-worktree session leakage.
  ].filter((u): u is string => !!u);

  const urlsToTry = [...new Set(candidateUrls)];
  report(`[ensureNexus] checking URLs in parallel: ${urlsToTry.join(", ")}`);

  // Probe all candidates simultaneously — first healthy URL wins.
  let foundUrl: string | undefined;
  try {
    foundUrl = await Promise.any(
      urlsToTry.map(async (url) => {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        if (body.status === "healthy") return url;
        if (body.status === "starting") {
          report("Nexus is starting (waiting for Raft election)...");
          await waitForNexusHealth(url);
          return url;
        }
        throw new Error(`not healthy: ${body.status}`);
      }),
    );
  } catch {
    // AggregateError — all candidates rejected or unreachable
  }

  if (foundUrl) {
    const apiKey = readNexusApiKey(projectRoot);
    report("Nexus is ready (already running)");
    return { url: foundUrl, apiKey };
  }

  // -----------------------------------------------------------------------
  // 2. No running Nexus found — need CLI to start one.
  //    YAML generation is in-process (no CLI dependency); `nexus up` still
  //    shells out to start Docker Compose.
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
  // 3. Quick restart: if state.json has a known compose project, try
  //    `docker compose restart` before falling back to `nexus up` (which pulls).
  // -----------------------------------------------------------------------
  const nexusYaml = join(groveHomeDir, "nexus.yaml");
  const hasYaml = existsSync(nexusYaml);
  report(`[ensureNexus] nexus.yaml exists=${String(hasYaml)}`);

  if (hasYaml && !upOpts?.force) {
    let quickRestartUrl: string | undefined;
    try {
      const projectName = state?.project_name;
      const httpPort = state?.ports?.http;
      if (projectName && httpPort) {
        report(`[ensureNexus] quick restart: project=${projectName} port=${httpPort}`);
        const restart = Bun.spawn(["docker", "compose", "-p", projectName, "restart", "nexus"], {
          cwd: groveHomeDir,
          stdout: "pipe",
          stderr: "pipe",
        });
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
    } catch {
      // best-effort — fall through to nexus up
    }

    report("[ensureNexus] warm start: nexus.yaml found, ensuring compose file...");
    await ensureNexusComposeFile(groveHomeDir);
    report("[ensureNexus] warm start: running nexus up...");
    const upStdout = await nexusUp(groveHomeDir, upOpts);
    const nexusUrl =
      readNexusUrl(groveHomeDir) ??
      parseNexusUrlFromOutput(upStdout) ??
      `http://localhost:${derivedPort}`;
    report(`[ensureNexus] nexus up url=${nexusUrl}, waiting for health...`);
    await waitForNexusHealth(nexusUrl);
    const apiKey = readNexusApiKey(groveHomeDir);
    report("Nexus is ready");
    return { url: nexusUrl, apiKey };
  }

  // -----------------------------------------------------------------------
  // 4. Cold start: generate nexus.yaml in-process, then run `nexus up`.
  //    No `nexus init` shell-out — YAML is built directly from known fields.
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
      `[ensureNexus] cold start: generating nexus.yaml (preset: ${preset}${channelLabel}, port: ${derivedPort})...`,
    );
    generateNexusYaml(groveHomeDir, { preset, channel, port: derivedPort });
  }

  report("[ensureNexus] cold start: ensuring compose file...");
  await ensureNexusComposeFile(groveHomeDir);

  const buildLabel = upOpts?.nexusSource
    ? ` (source build from ${upOpts.nexusSource})`
    : upOpts?.build
      ? " (--build)"
      : "";
  report(`[ensureNexus] starting Nexus${buildLabel}...`);
  const upStdout = await nexusUp(groveHomeDir, upOpts);

  const nexusUrl =
    readNexusUrl(groveHomeDir) ??
    parseNexusUrlFromOutput(upStdout) ??
    `http://localhost:${derivedPort}`;
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
