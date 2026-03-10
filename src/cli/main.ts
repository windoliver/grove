/**
 * Grove CLI — command-line interface for the contribution graph.
 *
 * Dispatches subcommands to dedicated handlers. Each command parses
 * its own arguments via `parseArgs` from `node:util`.
 *
 * Global flags (--help, --version, --verbose, --grove) are handled
 * before dispatch.
 *
 * Commands:
 *   grove init          — Create a new grove
 *   grove contribute    — Submit a contribution
 *   grove claim         — Claim work
 *   grove release       — Release a claim
 *   grove claims        — List claims
 *   grove checkout      — Materialize contribution artifacts
 *   grove frontier      — Show current frontier
 *   grove search        — Search contributions
 *   grove log           — Recent contributions
 *   grove tree          — DAG visualization
 */

import { createSqliteStores } from "../local/sqlite-store.js";
import { parseCheckoutArgs, runCheckout } from "./commands/checkout.js";
import { runClaim } from "./commands/claim.js";
import { runClaims } from "./commands/claims.js";
import { parseFrontierArgs, runFrontier } from "./commands/frontier.js";
import { parseLogArgs, runLog } from "./commands/log.js";
import { runRelease } from "./commands/release.js";
import { parseSearchArgs, runSearch } from "./commands/search.js";
import { parseTreeArgs, runTree } from "./commands/tree.js";
import { initCliDeps } from "./context.js";
import { resolveGroveDir } from "./utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into claim-based commands. */
interface CommandDeps {
  readonly claimStore: import("../core/store.js").ClaimStore;
  readonly stdout: (msg: string) => void;
  readonly stderr: (msg: string) => void;
}

/**
 * A registered CLI command.
 *
 * "standalone" commands (init, contribute, navigation commands) manage their
 * own store lifecycle and use dynamic imports for fast --help/--version startup.
 *
 * "store" commands (claim, release, claims) receive an injected ClaimStore
 * via CommandDeps, opened by the dispatcher.
 */
type Command =
  | {
      readonly name: string;
      readonly description: string;
      readonly needsStore: false;
      readonly handler: (args: readonly string[]) => Promise<void>;
    }
  | {
      readonly name: string;
      readonly description: string;
      readonly needsStore: true;
      readonly handler: (args: readonly string[], deps: CommandDeps) => Promise<void>;
    };

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

/**
 * Build the command registry.
 *
 * Navigation commands (checkout, frontier, search, log, tree) are standalone:
 * each handler creates full CliDeps internally via initCliDeps, supporting
 * the --grove override passed through `groveOverride`.
 */
function buildCommands(groveOverride: string | undefined): readonly Command[] {
  /** Helper: run a navigation command with full CliDeps. */
  async function withCliDeps(
    fn: (args: readonly string[], deps: import("./context.js").CliDeps) => Promise<void>,
    args: readonly string[],
  ): Promise<void> {
    const deps = initCliDeps(process.cwd(), groveOverride);
    try {
      await fn(args, deps);
    } finally {
      deps.close();
    }
  }

  return [
    {
      name: "init",
      description: "Create a new grove",
      needsStore: false,
      handler: async (args) => {
        const { handleInit } = await import("./commands/init.js");
        await handleInit(args);
      },
    },
    {
      name: "contribute",
      description: "Submit a contribution",
      needsStore: false,
      handler: async (args) => {
        const { handleContribute } = await import("./commands/contribute.js");
        await handleContribute(args);
      },
    },
    {
      name: "claim",
      description: "Claim work to prevent duplication",
      needsStore: true,
      handler: runClaim,
    },
    {
      name: "release",
      description: "Release a claim",
      needsStore: true,
      handler: runRelease,
    },
    {
      name: "claims",
      description: "List claims",
      needsStore: true,
      handler: runClaims,
    },
    {
      name: "checkout",
      description: "Materialize contribution artifacts",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runCheckout(parseCheckoutArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "frontier",
      description: "Show current frontier",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runFrontier(parseFrontierArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "search",
      description: "Search contributions",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runSearch(parseSearchArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "log",
      description: "Recent contributions",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runLog(parseLogArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "tree",
      description: "DAG visualization",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runTree(parseTreeArgs([...a]), deps);
        }, args);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Extract global --grove option before subcommand
  let groveOverride: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--grove" && i + 1 < rawArgs.length) {
      groveOverride = rawArgs[i + 1];
      i++; // skip value
    } else {
      args.push(rawArgs[i] ?? "");
    }
  }

  const first = args[0];

  // Global flags — handled before dispatch
  if (!first || first === "--help" || first === "-h") {
    printUsage();
    return;
  }

  if (first === "--version" || first === "-v") {
    console.log("grove 0.1.0");
    return;
  }

  // Find command
  const commands = buildCommands(groveOverride);
  const command = commands.find((c) => c.name === first);
  if (!command) {
    console.error(`grove: unknown command '${first}'. Run 'grove --help' for usage.`);
    process.exitCode = 1;
    return;
  }

  // Dispatch
  const subArgs = args.slice(1);

  if (command.needsStore) {
    const { dbPath } = resolveGroveDir(groveOverride);
    const stores = createSqliteStores(dbPath);
    try {
      await command.handler(subArgs, {
        claimStore: stores.claimStore,
        stdout: (msg) => console.log(msg),
        stderr: (msg) => console.error(msg),
      });
    } finally {
      stores.close();
    }
  } else {
    await command.handler(subArgs);
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`grove — asynchronous multi-agent contribution graph

Usage:
  grove init [name]           Create a new grove
  grove contribute            Submit a contribution
  grove claim <target>        Claim work to prevent duplication
  grove release <claim-id>    Release a claim
  grove claims                List claims

  grove checkout <cid> --to <dir>   Materialize contribution artifacts
  grove frontier [--metric <name>]  Show current frontier
  grove search [--query <text>]     Search contributions
  grove log [-n <count>]            Recent contributions
  grove tree [--from <cid>]         DAG visualization

Global options:
  --grove <path>              Path to grove directory (or set GROVE_DIR)
  --help, -h                  Show this help message
  --version, -v               Show version
  --verbose                   Show stack traces on error`);
}

// ---------------------------------------------------------------------------
// Centralized error handling
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  // Check for --verbose in original args for stack trace display
  const verbose = process.argv.includes("--verbose");

  if (err instanceof Error) {
    console.error(`grove: ${err.message}`);
    if (verbose && err.stack) {
      console.error(err.stack);
    }
  } else {
    console.error(`grove: unexpected error: ${String(err)}`);
  }

  process.exitCode = 1;
});
