/**
 * TUI entry point — launched via `grove tui`.
 *
 * Initializes the data provider, sets up stdin for Bun compatibility,
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
  readonly groveOverride: string | undefined;
} {
  const { values } = parseArgs({
    args: [...args],
    options: {
      interval: { type: "string", short: "i" },
      url: { type: "string", short: "u" },
      grove: { type: "string", short: "g" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    console.log(`grove tui — operator dashboard for swarm visibility

Usage:
  grove tui [options]

Options:
  -i, --interval <seconds>  Polling interval (default: 5)
  -u, --url <url>           Remote grove-server URL
  -g, --grove <path>        Path to grove directory
  -h, --help                Show this help message

Keybindings:
  1-4       Switch tabs (Dashboard, DAG, Claims, Activity)
  j/k ↑/↓   Navigate list
  Enter     View contribution detail
  Esc       Back to list
  n/p       Next/previous page
  r         Refresh
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
    groveOverride: values.grove as string | undefined,
  };
}

/** Create a data provider based on CLI arguments. */
async function createProvider(
  url: string | undefined,
  groveOverride: string | undefined,
): Promise<TuiDataProvider> {
  if (url) {
    const { RemoteDataProvider } = await import("./remote-provider.js");
    return new RemoteDataProvider(url);
  }

  // Local provider
  const { initCliDeps } = await import("../cli/context.js");
  const { createSqliteStores } = await import("../local/sqlite-store.js");
  const { LocalDataProvider } = await import("./local-provider.js");

  const deps = initCliDeps(process.cwd(), groveOverride);

  // We need a ClaimStore — initCliDeps doesn't provide one, so open it separately
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
  });
}

/** Main TUI entry point. */
export async function handleTui(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseTuiArgs(args);
  const effectiveGrove = opts.groveOverride ?? groveOverride;

  const provider = await createProvider(opts.url, effectiveGrove);

  // Bun compatibility: ensure stdin is in raw mode for keyboard input
  process.stdin.resume();

  // Dynamic import of React/Ink — only loaded when TUI is actually used
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./app.js");

  const { waitUntilExit } = render(
    React.createElement(App, {
      provider,
      intervalMs: opts.intervalMs,
    }),
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  provider.close();
}
