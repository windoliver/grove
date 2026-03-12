/**
 * TUI entry point — launched via `grove tui`.
 *
 * Initializes the data provider, sets up the OpenTUI renderer,
 * and renders the root App component.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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

/** Create a data provider from a resolved backend. */
async function createProvider(backend: ResolvedBackend, label: string): Promise<TuiDataProvider> {
  if (backend.mode === "remote") {
    const { RemoteDataProvider } = await import("./remote-provider.js");
    return new RemoteDataProvider(backend.url, label);
  }

  if (backend.mode === "nexus") {
    const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
    const { NexusDataProvider } = await import("./nexus-provider.js");
    const { LocalWorkspaceManager } = await import("../local/workspace.js");
    const { mkdirSync } = await import("node:fs");
    const { initSqliteDb } = await import("../local/sqlite-store.js");
    const { FsCas } = await import("../local/fs-cas.js");

    const client = new NexusHttpClient({ url: backend.url });

    // Create workspace root for Nexus-spawned agents.
    // groveRoot is the parent — LocalWorkspaceManager appends "workspaces".
    const homeDir = process.env.HOME ?? "/tmp";
    const groveRoot = join(homeDir, ".grove", "nexus-workspaces");
    mkdirSync(groveRoot, { recursive: true });

    // SQLite DB for workspace tracking (claims live in Nexus, not local SQLite)
    const dbPath = join(groveRoot, "nexus.db");
    const db = initSqliteDb(dbPath);

    // Stub contribution store — bare workspace creation doesn't fetch artifacts
    const stubContributionStore = {
      get: async () => undefined,
      put: async () => {},
      putMany: async () => {},
      list: async () => [],
      ancestors: async () => [],
      children: async () => [],
      count: async () => 0,
      thread: async () => [],
      hotThreads: async () => [],
      search: async () => [],
      relationsOf: async () => [],
      relatedTo: async () => [],
      findExisting: async () => undefined,
      replyCounts: async () => new Map(),
      close: () => {},
      storeIdentity: "nexus-workspace-stub",
    } as unknown as import("../core/store.js").ContributionStore;

    // Stub CAS — bare workspaces don't materialize artifacts
    const casRoot = join(groveRoot, "cas");
    mkdirSync(casRoot, { recursive: true });
    const cas = new FsCas(casRoot);

    const workspaceManager = new LocalWorkspaceManager({
      groveRoot,
      db,
      contributionStore: stubContributionStore,
      cas,
    });

    return new NexusDataProvider({
      nexusConfig: { client, zoneId: "default" },
      workspaceManager,
      backendLabel: label,
    });
  }

  // Local provider
  const { initCliDeps } = await import("../cli/context.js");
  const { createSqliteStores } = await import("../local/sqlite-store.js");
  const { LocalDataProvider } = await import("./local-provider.js");

  const deps = initCliDeps(process.cwd(), backend.groveOverride);
  const dbPath = join(deps.groveRoot, ".grove", "grove.db");

  // Read grove name from .grove/grove.json
  let groveName = "grove";
  try {
    const metaPath = join(deps.groveRoot, ".grove", "grove.json");
    if (existsSync(metaPath)) {
      const raw = await Bun.file(metaPath).text();
      const meta = JSON.parse(raw) as { name?: string };
      groveName = meta.name ?? "grove";
    }
  } catch {
    // Ignore — use default name
  }

  const stores = createSqliteStores(dbPath);

  return new LocalDataProvider({
    contributionStore: deps.store,
    claimStore: stores.claimStore,
    frontier: deps.frontier,
    groveName,
    outcomeStore: stores.outcomeStore,
    cas: deps.cas,
    workspace: deps.workspace,
    backendLabel: label,
  });
}

/** Main TUI entry point. */
export async function handleTui(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

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
        // Explicit --nexus: give a specific error
        if (health === "auth_required") {
          throw new Error(
            `Nexus at ${backend.url} requires authentication (HTTP 401/403). No credential path is configured.`,
          );
        }
        throw new Error(`Nexus at ${backend.url} is unreachable (${health})`);
      }
      // Auto-detected nexus not usable — fallback to local
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

  // Load provider and topology in parallel (except when nexus fallback just happened)
  const [provider, topology] = await Promise.all([
    createProvider(backend, label),
    loadTopology(backend),
  ]);

  // Create TmuxManager for local agent management (only in local mode)
  let tmux: import("./agents/tmux-manager.js").TmuxManager | undefined;
  if (backend.mode === "local") {
    const { ShellTmuxManager } = await import("./agents/tmux-manager.js");
    const mgr = new ShellTmuxManager();
    const available = await mgr.isAvailable();
    tmux = available ? mgr : undefined;
  }

  // Bun compatibility: ensure stdin is in raw mode for keyboard input
  process.stdin.resume();

  // Dynamic import of React/OpenTUI — only loaded when TUI is actually used
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const React = await import("react");
  const { App } = await import("./app.js");

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const root = createRoot(renderer);

  // Start workspace GC for modes that have lifecycle support
  let stopGc: (() => void) | undefined;
  if (provider.cleanWorkspace) {
    const { startWorkspaceGc } = await import("./workspace-gc.js");
    stopGc = startWorkspaceGc(provider);
  }

  root.render(
    React.createElement(App, {
      provider,
      intervalMs: opts.intervalMs,
      tmux,
      topology,
    }),
  );

  renderer.start();

  // Wait for renderer to be stopped (e.g., by quit action)
  await renderer.idle();
  stopGc?.();
  provider.close();
}
