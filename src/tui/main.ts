/**
 * TUI entry point — launched via `grove tui` or bare `grove`.
 *
 * Always renders the setup screen first so the user can choose what to do
 * (resume existing grove, create new, or connect to remote Nexus).
 * Services start inside the TUI with progress feedback — no raw stderr
 * output before the TUI renders.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunningServices } from "../shared/service-lifecycle.js";
import type { SessionRecord, TuiDataProvider } from "./provider.js";
import {
  backendLabel,
  checkNexusHealth,
  loadTopology,
  type ResolvedBackend,
  resolveBackend,
} from "./resolve-backend.js";

/** Default polling interval: 5 seconds. */
const DEFAULT_INTERVAL_MS = 5_000;

/** Parse TUI command-line arguments. */
export function parseTuiArgs(args: readonly string[]): {
  readonly intervalMs: number;
  readonly url: string | undefined;
  readonly nexus: string | undefined;
  readonly groveOverride: string | undefined;
} {
  const { values } = parseArgs({
    args: [...args],
    options: {
      interval: { type: "string", short: "i" },
      url: { type: "string", short: "u" },
      nexus: { type: "string", short: "n" },
      grove: { type: "string", short: "g" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove tui — agent command center for swarm visibility

Usage:
  grove tui [options]

Options:
  -i, --interval <seconds>  Polling interval (default: 5)
  -u, --url <url>           Remote grove-server URL
  -n, --nexus <url>         Override Nexus URL (bypasses auto-detection)
  -g, --grove <path>        Path to .grove directory (not the repo root)
  -h, --help                Show this help message

Backend auto-detection:
  Nexus is auto-selected when configured via GROVE_NEXUS_URL env var
  or nexusUrl in .grove/grove.json. Use --nexus to override explicitly.

Environment:
  GROVE_NEXUS_URL            Nexus zone URL (auto-detected as backend)

Keybindings:
  1-4       Focus protocol core panel (DAG, Detail, Frontier, Claims)
  5-8       Toggle operator panels on/off
  Tab       Cycle focus between visible panels
  j/k \u2191/\u2193   Navigate within focused panel
  Enter     Drill-down / select
  Esc       Back / close overlay
  r         Refresh
  Ctrl+P    Command palette
  q         Quit`);
    process.exit(0);
  }

  const intervalSeconds = values.interval ? Number(values.interval) : undefined;
  const intervalMs =
    intervalSeconds !== undefined && !Number.isNaN(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds * 1000
      : DEFAULT_INTERVAL_MS;

  return {
    intervalMs,
    url: values.url as string | undefined,
    nexus: values.nexus as string | undefined,
    groveOverride: values.grove as string | undefined,
  };
}

/** Create a data provider from a resolved backend (delegates to shared factory). */
async function createProviderForTui(
  backend: ResolvedBackend,
  label: string,
): Promise<TuiDataProvider> {
  const { createProvider } = await import("../shared/provider-factory.js");
  return createProvider(backend, label);
}

// ---------------------------------------------------------------------------
// Grove directory detection
// ---------------------------------------------------------------------------

/**
 * Check whether a .grove/grove.json file exists in the current working tree.
 *
 * Walks up from cwd (or the explicit groveOverride path) looking for the
 * directory. Returns the resolved groveDir path if found, undefined otherwise.
 */
function findGroveDir(groveOverride?: string): string | undefined {
  // If an explicit override was provided, check it directly
  if (groveOverride) {
    const configPath = join(groveOverride, "grove.json");
    return existsSync(configPath) ? groveOverride : undefined;
  }

  // Check GROVE_DIR env
  const envDir = process.env.GROVE_DIR;
  if (envDir) {
    const configPath = join(envDir, "grove.json");
    return existsSync(configPath) ? envDir : undefined;
  }

  // Walk up from cwd looking for .grove/grove.json
  const { dirname } = require("node:path") as typeof import("node:path");
  const { resolve } = require("node:path") as typeof import("node:path");
  let current = resolve(process.cwd());

  while (true) {
    const candidate = join(current, ".grove");
    const configPath = join(candidate, "grove.json");
    if (existsSync(configPath)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Welcome mode helpers
// ---------------------------------------------------------------------------

/** Build extended details string from a preset config for the welcome overlay. */
function buildPresetDetails(preset: {
  readonly mode: string;
  readonly backend: string;
  readonly topology?: { readonly roles: readonly { readonly name: string }[] } | undefined;
  readonly metrics?: readonly { readonly name: string; readonly direction: string }[] | undefined;
  readonly gates?: readonly { readonly type: string }[] | undefined;
  readonly stopConditions?: object | undefined;
  readonly services: { readonly server: boolean; readonly mcp: boolean };
}): string {
  const lines: string[] = [];
  lines.push(`Mode: ${preset.mode}`);
  lines.push(`Backend: ${preset.backend}`);
  if (preset.topology) {
    const roleNames = preset.topology.roles.map((r) => r.name).join(", ");
    lines.push(`Roles: ${roleNames}`);
  }
  if (preset.metrics && preset.metrics.length > 0) {
    const metricStrs = preset.metrics.map((m) => `${m.name} (${m.direction})`);
    lines.push(`Metrics: ${metricStrs.join(", ")}`);
  } else {
    lines.push("Metrics: none (exploration mode)");
  }
  if (preset.gates && preset.gates.length > 0) {
    lines.push(`Gates: ${preset.gates.map((g) => g.type).join(", ")}`);
  }
  if (preset.stopConditions) {
    const stops = Object.entries(preset.stopConditions as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`);
    if (stops.length > 0) lines.push(`Stop: ${stops.join(", ")}`);
  }
  const services: string[] = [];
  if (preset.services.server) services.push("HTTP server");
  if (preset.services.mcp) services.push("MCP server");
  if (services.length > 0) lines.push(`Services: ${services.join(", ")}`);
  return lines.join("\n");
}

/** Load all preset names and descriptions for the welcome screen. */
async function loadPresetList(): Promise<
  readonly { name: string; description: string; details?: string | undefined }[]
> {
  const { getPresetRegistry } = await import("../cli/presets/index.js");
  const registry = getPresetRegistry();
  return Object.entries(registry).map(([name, preset]) => ({
    name,
    description: preset.description,
    details: buildPresetDetails(preset),
  }));
}

/**
 * Build boardroom AppProps from a resolved backend.
 *
 * Shared between the direct boardroom path and the post-init transition.
 */
async function buildAppProps(
  effectiveGrove: string | undefined,
  opts: { intervalMs: number; url?: string | undefined; nexus?: string | undefined },
  presetName?: string,
): Promise<{
  appProps: import("./app.js").AppProps;
  provider: TuiDataProvider;
  stopGc?: (() => void) | undefined;
}> {
  let backend = resolveBackend({
    url: opts.url,
    nexus: opts.nexus,
    groveOverride: effectiveGrove,
  });

  // Health check for nexus backends
  if (backend.mode === "nexus") {
    const health = await checkNexusHealth(backend.url);
    if (health !== "ok") {
      if (backend.source === "flag") {
        if (health === "auth_required") {
          throw new Error(
            `Nexus at ${backend.url} requires authentication (HTTP 401/403). No credential path is configured.`,
          );
        }
        throw new Error(`Nexus at ${backend.url} is unreachable (${health})`);
      }
      // Suppress stderr in TUI mode — the fallback is silent.
      // The warning would corrupt the alternate screen.
      backend = { mode: "local", groveOverride: effectiveGrove, source: "default" };
    }
  }

  const label = backendLabel(backend);

  const [provider, topology] = await Promise.all([
    createProviderForTui(backend, label),
    loadTopology(backend),
  ]);

  // Create TmuxManager for agent management
  let tmux: import("./agents/tmux-manager.js").TmuxManager | undefined;
  {
    const { ShellTmuxManager } = await import("./agents/tmux-manager.js");
    const mgr = new ShellTmuxManager();
    const available = await mgr.isAvailable();
    tmux = available ? mgr : undefined;
  }

  // Create AcpxRuntime for agent spawning (preferred over tmux)
  let agentRuntime: import("../core/agent-runtime.js").AgentRuntime | undefined;
  {
    const { AcpxRuntime } = await import("../core/acpx-runtime.js");
    const runtime = new AcpxRuntime({ agent: "codex" });
    const available = await runtime.isAvailable();
    agentRuntime = available ? runtime : undefined;
  }

  // Start workspace GC for modes that have lifecycle support
  const stopCallbacks: Array<() => void> = [];
  if (provider.cleanWorkspace) {
    const { startWorkspaceGc } = await import("./workspace-gc.js");
    stopCallbacks.push(startWorkspaceGc(provider));
  }

  // Start periodic claim cleanup + artifact GC for local backends
  const groveDir =
    backend.mode === "local" || backend.mode === "nexus"
      ? (backend.groveOverride ?? findGroveDir(effectiveGrove))
      : undefined;
  if (groveDir) {
    const { createLocalRuntime } = await import("../local/runtime.js");
    const { runCleanup, runArtifactGc } = await import("../local/cleanup.js");
    const cleanupRuntime = createLocalRuntime({
      groveDir,
      frontierCacheTtlMs: 0,
      workspace: false,
      parseContract: false,
    });

    const claimTimer = setInterval(async () => {
      try {
        const result = await runCleanup({ claimStore: cleanupRuntime.claimStore });
        if (result.expiredClaims > 0 || result.cleanedClaims > 0) {
          process.stderr.write(
            `[cleanup] expired ${result.expiredClaims} stale claim(s), cleaned ${result.cleanedClaims} old claim(s)\n`,
          );
        }
      } catch {
        // Cleanup errors are non-fatal
      }
    }, 60_000);

    const gcTimer = setInterval(async () => {
      try {
        const result = await runArtifactGc({
          contributionStore: cleanupRuntime.contributionStore,
          cas: cleanupRuntime.cas,
        });
        if (result.deletedBlobs > 0) {
          process.stderr.write(
            `[cleanup] garbage-collected ${result.deletedBlobs} unreferenced blob(s)\n`,
          );
        }
      } catch {
        // GC errors are non-fatal
      }
    }, 10 * 60_000);

    stopCallbacks.push(() => {
      clearInterval(claimTimer);
      clearInterval(gcTimer);
      cleanupRuntime.close();
    });
  }

  const stopGc =
    stopCallbacks.length > 0
      ? () => {
          for (const fn of stopCallbacks) fn();
        }
      : undefined;

  // Create EventBus for Nexus mode — enables event-driven data instead of polling
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  if (backend.mode === "nexus") {
    const nexusUrl = process.env.GROVE_NEXUS_URL ?? (backend as { url?: string }).url;
    const apiKey = process.env.NEXUS_API_KEY;
    if (nexusUrl) {
      const { NexusEventBus } = await import("../nexus/nexus-event-bus.js");
      const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
      const nexusClient = new NexusHttpClient({
        url: nexusUrl,
        ...(apiKey ? { apiKey } : {}),
      });
      eventBus = new NexusEventBus(nexusClient, "default");
      stopCallbacks.push(() => eventBus?.close());
    }
  }

  return {
    appProps: {
      provider,
      intervalMs: opts.intervalMs,
      tmux,
      topology,
      presetName,
      groveDir,
      eventBus,
      agentRuntime,
    },
    provider,
    stopGc,
  };
}

// ---------------------------------------------------------------------------
// Post-startup skill update
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget update of SKILL.md with actual server URLs.
 *
 * Called after services start so that AI agent skill files point at
 * the running grove server and MCP endpoints.
 */
function updateSkillAfterStartup(): void {
  const serverPort = process.env.PORT ?? "4515";
  const mcpPort = process.env.MCP_PORT ?? "4015";
  void import("../cli/commands/skill.js")
    .then(({ handleSkillInstall }) =>
      handleSkillInstall({
        serverUrl: `http://localhost:${serverPort}`,
        mcpUrl: `http://localhost:${mcpPort}`,
      }),
    )
    .catch(() => {
      /* skill update is best-effort */
    });
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Main TUI entry point.
 *
 * Always shows the setup screen first so the user can choose what to do,
 * then starts services inside the TUI with progress feedback.
 *
 * @param args - CLI arguments for the TUI
 * @param groveOverride - Explicit .grove path override
 * @param serviceOpts - Service start options forwarded from `grove up` (build, nexusSource)
 */
export async function handleTui(
  args: readonly string[],
  groveOverride?: string,
  serviceOpts?: { build?: boolean | undefined; nexusSource?: string | undefined },
): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  // Check if grove is initialized
  const groveDir = findGroveDir(effectiveGrove);
  const groveExists = groveDir !== undefined;

  // Load grove info if it exists (name + preset for the setup screen)
  let groveInfo: { name: string; preset: string } | undefined;
  if (groveDir) {
    try {
      const raw = readFileSync(join(groveDir, "grove.json"), "utf-8");
      const parsed = JSON.parse(raw);
      groveInfo = { name: parsed.name ?? "unnamed", preset: parsed.preset ?? "unknown" };
    } catch {
      // grove.json unreadable — treat as no grove info
    }
  }

  // Pre-flight: ensure Nexus is healthy BEFORE starting the TUI.
  // This avoids blocking the TUI render with Nexus init/startup.
  try {
    const { ensureNexusRunning, checkNexusCli } = await import("../cli/nexus-lifecycle.js");
    const hasNexus = await checkNexusCli();
    if (hasNexus) {
      // Minimal config — just need Nexus running, don't care about grove mode yet
      const minConfig = { name: "preflight", mode: "nexus" as const, nexusManaged: true };
      const nexusInfo = await ensureNexusRunning(process.cwd(), minConfig, {
        onProgress: (step) => process.stderr.write(`${step}\n`),
      });
      process.env.GROVE_NEXUS_URL = nexusInfo.url;
      if (nexusInfo.apiKey) process.env.NEXUS_API_KEY = nexusInfo.apiKey;
    }
  } catch {
    // Non-fatal — TUI can still work in local mode
  }

  // Load past sessions for the welcome screen (informational context)
  let sessions: SessionRecord[] = [];
  if (groveDir) {
    try {
      const { createSqliteStores } = await import("../local/sqlite-store.js");
      const dbPath = join(groveDir, "grove.db");
      if (existsSync(dbPath)) {
        const stores = createSqliteStores(dbPath);
        sessions = [...(await stores.goalSessionStore.listSessions())];
        stores.close();
      }
    } catch {
      // Sessions are optional context — don't block startup
    }
  }

  // Bun compatibility: ensure stdin is in raw mode for keyboard input
  process.stdin.resume();

  // Dynamic import of React/OpenTUI — only loaded when TUI is actually used
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const React = await import("react");

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: !process.env.GROVE_NO_ALT_SCREEN,
  });

  const root = createRoot(renderer);

  // Track services + cleanup references
  let runningServices: RunningServices | undefined;
  let activeProvider: TuiDataProvider | undefined;
  let activeStopGc: (() => void) | undefined;

  /** Shutdown handler — stops services, GC, and provider. */
  const cleanup = async () => {
    activeStopGc?.();
    activeProvider?.close();
    if (runningServices) {
      const { stopServices } = await import("../shared/service-lifecycle.js");
      await stopServices(runningServices);
    }
  };

  // Register signal handlers for graceful shutdown
  const onSignal = () => {
    cleanup().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // --url flag: legacy direct boardroom mode (no interactive screens)
    if (opts.url && !opts.nexus) {
      if (groveDir) {
        const { startServices } = await import("../shared/service-lifecycle.js");
        runningServices = await startServices({
          groveDir,
          build: serviceOpts?.build,
          nexusSource: serviceOpts?.nexusSource,
        });
      }
      const result = await buildAppProps(effectiveGrove, opts, groveInfo?.preset);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;
      updateSkillAfterStartup();
      const { App } = await import("./app.js");
      root.render(React.createElement(App, result.appProps));
      renderer.start();
      await renderer.idle();
      return;
    }

    // --nexus flag: Nexus is the default backend. Go through interactive
    // ScreenManager flow (goal → prompts → run) with Nexus pre-configured.
    // Falls through to the TuiApp below which handles the full flow.

    const presets = await loadPresetList();

    // onInit: handles "New grove" path — run init then start services
    const onInit = async (
      presetName: string,
      groveName: string,
      onProgress?: (step: string) => void,
    ): Promise<import("./app.js").AppProps> => {
      const { executeInit } = await import("../cli/commands/init.js");
      await executeInit({
        name: groveName,
        mode: "evaluation",
        seed: [],
        metric: [],
        force: true,
        agentOverrides: {},
        cwd: process.cwd(),
        preset: presetName,
      });

      const newGroveDir = join(process.cwd(), ".grove");
      const { startServices } = await import("../shared/service-lifecycle.js");
      runningServices = await startServices({
        groveDir: newGroveDir,
        build: serviceOpts?.build,
        nexusSource: serviceOpts?.nexusSource,
        onProgress,
        force: true,
      });

      // Pass the newly created .grove dir so buildAppProps can find GROVE.md
      const result = await buildAppProps(newGroveDir, opts, presetName);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;

      // Post-startup: update agent skill SKILL.md (non-blocking)
      updateSkillAfterStartup();

      return result.appProps;
    };

    // onStart: handles "Resume" path — start services for existing grove
    const onStart = async (
      onProgress?: (step: string) => void,
    ): Promise<import("./app.js").AppProps> => {
      const resolvedGrove = groveDir ?? join(process.cwd(), ".grove");
      const { startServices } = await import("../shared/service-lifecycle.js");
      runningServices = await startServices({
        groveDir: resolvedGrove,
        build: serviceOpts?.build,
        nexusSource: serviceOpts?.nexusSource,
        onProgress,
      });

      const result = await buildAppProps(effectiveGrove, opts, groveInfo?.preset);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;

      // Post-startup: update agent skill SKILL.md (non-blocking)
      updateSkillAfterStartup();

      return result.appProps;
    };

    // onConnect: handles "Connect to remote Nexus" path — no local services
    const onConnect = async (nexusUrl: string): Promise<import("./app.js").AppProps> => {
      const result = await buildAppProps(effectiveGrove, { ...opts, nexus: nexusUrl });
      activeProvider = result.provider;
      activeStopGc = result.stopGc;
      return result.appProps;
    };

    const { TuiApp } = await import("./tui-app.js");

    root.render(
      React.createElement(TuiApp, {
        groveExists,
        groveInfo,
        presets,
        sessions,
        onInit,
        onStart,
        onConnect,
        autoConnectNexus: opts.nexus,
      }),
    );

    renderer.start();
    await renderer.idle();
  } finally {
    // TUI exited — clean up everything
    await cleanup();
  }
}

/**
 * Direct TUI entry point for the CLI dispatcher.
 *
 * Called when `grove` is run with no subcommand. Delegates to handleTui
 * which internally handles both initialized and uninitialized states.
 */
export async function handleTuiDirect(groveOverride?: string): Promise<void> {
  await handleTui([], groveOverride);
}
