/**
 * TUI entry point — launched via `grove tui`.
 *
 * Initializes the data provider, sets up the OpenTUI renderer,
 * and renders the root App component.
 */

import { parseArgs } from "node:util";
import type { TuiDataProvider } from "./provider.js";

/** Default polling interval: 5 seconds. */
const DEFAULT_INTERVAL_MS = 5_000;

/** Parse TUI command-line arguments. */
function parseTuiArgs(args: readonly string[]): {
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
  -n, --nexus <url>         Nexus zone URL (enables VFS browsing)
  -g, --grove <path>        Path to grove directory
  -h, --help                Show this help message

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

/** Create a data provider based on CLI arguments. */
async function createProvider(
  url: string | undefined,
  nexus: string | undefined,
  groveOverride: string | undefined,
): Promise<TuiDataProvider> {
  if (url) {
    const { RemoteDataProvider } = await import("./remote-provider.js");
    return new RemoteDataProvider(url);
  }

  if (nexus) {
    const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
    const { NexusDataProvider } = await import("./nexus-provider.js");
    const client = new NexusHttpClient({ url: nexus });
    return new NexusDataProvider({
      nexusConfig: { client, zoneId: "default" },
    });
  }

  // Local provider
  const { initCliDeps } = await import("../cli/context.js");
  const { createSqliteStores } = await import("../local/sqlite-store.js");
  const { LocalDataProvider } = await import("./local-provider.js");

  const deps = initCliDeps(process.cwd(), groveOverride);

  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dbPath = join(deps.groveRoot, ".grove", "grove.db");

  // Read grove name from the .grove directory
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
  });
}

/** Main TUI entry point. */
export async function handleTui(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  const provider = await createProvider(opts.url, opts.nexus, effectiveGrove);

  // Create TmuxManager for local agent management (only in local mode)
  let tmux: import("./agents/tmux-manager.js").TmuxManager | undefined;
  if (!opts.url) {
    const { ShellTmuxManager } = await import("./agents/tmux-manager.js");
    const mgr = new ShellTmuxManager();
    const available = await mgr.isAvailable();
    tmux = available ? mgr : undefined;
  }

  // Read agent topology from GROVE.md contract (if available)
  let topology: import("../core/topology.js").AgentTopology | undefined;
  if (opts.url) {
    // Remote mode: fetch topology from the grove-server API
    try {
      const resp = await fetch(`${opts.url}/api/grove/topology`);
      if (resp.ok) {
        topology = (await resp.json()) as import("../core/topology.js").AgentTopology;
      }
    } catch {
      // Topology not available on remote
    }
  } else if (opts.nexus) {
    // Nexus mode: try to fetch topology from the Nexus topology endpoint
    try {
      const resp = await fetch(`${opts.nexus}/api/grove/topology`);
      if (resp.ok) {
        topology = (await resp.json()) as import("../core/topology.js").AgentTopology;
      }
    } catch {
      // Topology not available on Nexus
    }
  } else {
    // Local mode: read from GROVE.md contract
    try {
      const { existsSync: fsExists } = await import("node:fs");
      const { join: pathJoin } = await import("node:path");
      const { parseGroveContract } = await import("../core/contract.js");
      const { resolveGroveDir } = await import("../cli/utils/grove-dir.js");
      const { groveDir } = resolveGroveDir(effectiveGrove);
      // GROVE.md lives in the parent of the .grove directory
      const grovemdPath = pathJoin(groveDir, "..", "GROVE.md");
      if (fsExists(grovemdPath)) {
        const raw = await Bun.file(grovemdPath).text();
        const contract = parseGroveContract(raw);
        topology = contract.topology;
      }
    } catch {
      // Ignore — topology is optional
    }
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
  provider.close();
}
