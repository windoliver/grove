/**
 * TUI entry point — launched via `grove tui` or bare `grove`.
 *
 * Initializes the data provider, sets up the OpenTUI renderer,
 * and renders the root App component. When no .grove/ directory
 * exists, shows the welcome screen for guided initialization.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunningServices } from "../shared/service-lifecycle.js";
import type { TuiDataProvider } from "./provider.js";
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
  j/k ↑/↓   Navigate within focused panel
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
      const reason =
        health === "auth_required"
          ? "requires authentication"
          : health === "not_nexus"
            ? "endpoint not found (not a Nexus server?)"
            : health === "server_error"
              ? "server error"
              : "unreachable";
      process.stderr.write(
        `Warning: Nexus at ${backend.url} ${reason}, falling back to local mode\n`,
      );
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

  // Start workspace GC for modes that have lifecycle support
  let stopGc: (() => void) | undefined;
  if (provider.cleanWorkspace) {
    const { startWorkspaceGc } = await import("./workspace-gc.js");
    stopGc = startWorkspaceGc(provider);
  }

  return {
    appProps: { provider, intervalMs: opts.intervalMs, tmux, topology },
    provider,
    stopGc,
  };
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Main TUI entry point.
 *
 * @param args - CLI arguments for the TUI
 * @param groveOverride - Explicit .grove path override
 * @param skipServices - If true, skip service startup (caller already started them, e.g. grove up)
 */
export async function handleTui(
  args: readonly string[],
  groveOverride?: string,
  skipServices?: boolean,
): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  // Check if grove is initialized
  const groveDir = findGroveDir(effectiveGrove);
  const isInitialized = groveDir !== undefined;

  // Bun compatibility: ensure stdin is in raw mode for keyboard input
  process.stdin.resume();

  // Dynamic import of React/OpenTUI — only loaded when TUI is actually used
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const React = await import("react");

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const root = createRoot(renderer);

  // Track services + cleanup references for both paths
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
    if (isInitialized) {
      // Start services unless caller already did (e.g. grove up)
      if (!skipServices) {
        const resolvedGrove = groveDir ?? join(process.cwd(), ".grove");
        const { startServices } = await import("../shared/service-lifecycle.js");
        runningServices = await startServices({ groveDir: resolvedGrove });
      }

      // Build boardroom props (provider, topology, tmux)
      const result = await buildAppProps(effectiveGrove, opts);
      activeProvider = result.provider;
      activeStopGc = result.stopGc;

      const { App } = await import("./app.js");
      root.render(React.createElement(App, result.appProps));
    } else {
      // Welcome mode — no .grove/ found, guide through init then start services
      const presets = await loadPresetList();
      const { TuiApp } = await import("./tui-app.js");

      const onInit = async (
        presetName: string,
        groveName: string,
      ): Promise<import("./app.js").AppProps> => {
        // Run grove init
        const { executeInit } = await import("../cli/commands/init.js");
        await executeInit({
          name: groveName,
          mode: "evaluation",
          seed: [],
          metric: [],
          force: false,
          agentOverrides: {},
          cwd: process.cwd(),
          preset: presetName,
        });

        // Start services after init (same as `grove up`)
        const newGroveDir = join(process.cwd(), ".grove");
        const { startServices } = await import("../shared/service-lifecycle.js");
        runningServices = await startServices({ groveDir: newGroveDir });

        // Build boardroom props
        const result = await buildAppProps(effectiveGrove, opts);
        activeProvider = result.provider;
        activeStopGc = result.stopGc;
        return result.appProps;
      };

      root.render(
        React.createElement(TuiApp, {
          welcomeMode: true,
          presets,
          onInit,
        }),
      );
    }

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
