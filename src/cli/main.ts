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
 *   grove gossip        — Gossip protocol commands
 *   grove outcome       — Manage outcome annotations
 *   grove tui           — Operator TUI dashboard
 */

import { createSqliteStores } from "../local/sqlite-store.js";
import { runBounty } from "./commands/bounty.js";
import { parseCheckoutArgs, runCheckout } from "./commands/checkout.js";
import { runClaim } from "./commands/claim.js";
import { runClaims } from "./commands/claims.js";
import { parseFrontierArgs, runFrontier } from "./commands/frontier.js";
import { parseLogArgs, runLog } from "./commands/log.js";
import { runRelease } from "./commands/release.js";
import { parseSearchArgs, runSearch } from "./commands/search.js";
import { parseThreadArgs, runThread } from "./commands/thread.js";
import { parseThreadsArgs, runThreads } from "./commands/threads.js";
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
      name: "ask",
      description: "Ask a question (interactive or AI-answered)",
      needsStore: false,
      handler: async (args) => {
        const { handleAsk } = await import("./commands/ask.js");
        await handleAsk(args);
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
      name: "discuss",
      description: "Post a discussion or reply",
      needsStore: false,
      handler: async (args) => {
        const { handleDiscuss } = await import("./commands/discuss.js");
        await handleDiscuss(args, groveOverride);
      },
    },
    {
      name: "review",
      description: "Submit a review of a contribution",
      needsStore: false,
      handler: async (args) => {
        const { handleReview } = await import("./commands/review.js");
        await handleReview(args, groveOverride);
      },
    },
    {
      name: "reproduce",
      description: "Submit a reproduction attempt",
      needsStore: false,
      handler: async (args) => {
        const { handleReproduce } = await import("./commands/reproduce.js");
        await handleReproduce(args, groveOverride);
      },
    },
    {
      name: "thread",
      description: "View a discussion thread",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runThread(parseThreadArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "threads",
      description: "List active discussion threads",
      needsStore: false,
      handler: async (args) => {
        await withCliDeps(async (a, deps) => {
          await runThreads(parseThreadsArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "export",
      description: "Export contribution to GitHub",
      needsStore: false,
      handler: async (args) => {
        const { handleExport } = await import("./commands/export.js");
        await handleExport(args, groveOverride);
      },
    },
    {
      name: "import",
      description: "Import from GitHub as contribution",
      needsStore: false,
      handler: async (args) => {
        const { handleImport } = await import("./commands/import.js");
        await handleImport(args, groveOverride);
      },
    },
    {
      name: "bounty",
      description: "Create, list, or claim bounties",
      needsStore: false,
      handler: async (args) => {
        const { dbPath } = resolveGroveDir(groveOverride);
        const stores = createSqliteStores(dbPath);
        try {
          await runBounty(args, {
            bountyStore: stores.bountyStore,
            claimStore: stores.claimStore,
            stdout: (msg) => console.log(msg),
            stderr: (msg) => console.error(msg),
          });
        } finally {
          stores.close();
        }
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
    {
      name: "gossip",
      description: "Gossip protocol commands",
      needsStore: false,
      handler: async (args) => {
        const { handleGossip } = await import("./commands/gossip.js");
        await handleGossip(args, groveOverride, withCliDeps);
      },
    },
    {
      name: "outcome",
      description: "Manage outcome annotations",
      needsStore: false,
      handler: async (args) => {
        const { parseOutcomeArgs, runOutcome } = await import("./commands/outcome.js");
        const { SqliteOutcomeStore } = await import("../local/sqlite-outcome-store.js");
        const { dbPath } = resolveGroveDir(groveOverride);
        const { initSqliteDb } = await import("../local/sqlite-store.js");
        const db = initSqliteDb(dbPath);
        const outcomeStore = new SqliteOutcomeStore(db);
        try {
          const parsed = parseOutcomeArgs([...args]);
          await runOutcome(parsed, {
            outcomeStore,
            stdout: console.log,
            stderr: console.error,
          });
        } finally {
          outcomeStore.close();
        }
      },
    },
    {
      name: "tui",
      description: "Operator TUI dashboard",
      needsStore: false,
      handler: async (args) => {
        const { handleTui } = await import("../tui/main.js");
        await handleTui(args, groveOverride);
      },
    },
    {
      name: "up",
      description: "Start all grove services and TUI",
      needsStore: false,
      handler: async (args) => {
        const { handleUp } = await import("./commands/up.js");
        await handleUp(args, groveOverride);
      },
    },
    {
      name: "down",
      description: "Stop all grove services",
      needsStore: false,
      handler: async (args) => {
        const { handleDown } = await import("./commands/down.js");
        await handleDown(args, groveOverride);
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
  grove init [name]                    Create a new grove
  grove init --preset <name> [name]    Create from preset (review-loop, exploration, swarm-ops, research-loop)
    --nexus-url <url>                  Use Nexus backend (or set GROVE_NEXUS_URL)
  grove up [--headless] [--no-tui]     Start all services and TUI
  grove down                           Stop all services

  grove contribute            Submit a contribution
  grove discuss [cid] <msg>   Post a discussion or reply
  grove review <cid>          Submit a review of a contribution
  grove reproduce <cid>       Submit a reproduction attempt
  grove claim <target>        Claim work to prevent duplication
  grove release <claim-id>    Release a claim
  grove claims                List claims
  grove ask <question>        Ask a question (interactive or AI-answered)

  grove bounty create <title> --amount <credits> --deadline <duration>
  grove bounty list [--status <status>] [--mine]
  grove bounty claim <bounty-id>

  grove checkout <cid> --to <dir>   Materialize contribution artifacts
  grove frontier [--metric <name>]  Show current frontier
  grove search [--query <text>]     Search contributions
  grove log [-n <count>]            Recent contributions
  grove tree [--from <cid>]         DAG visualization
  grove thread <cid>                View a discussion thread
  grove threads [--tag <tag>]       List active discussion threads

  grove outcome set <cid> <status>  Set outcome for a contribution
  grove outcome get <cid>          Get outcome for a contribution
  grove outcome list [--status]    List outcomes
  grove outcome stats              Show outcome statistics

  grove export --to-discussion <owner/repo> <cid>   Export to GitHub Discussion
  grove export --to-pr <owner/repo> <cid>           Export to GitHub PR
  grove import --from-pr <owner/repo#number>        Import GitHub PR
  grove import --from-discussion <owner/repo#number> Import GitHub Discussion

  grove tui [--interval <s>] [--url <url>] [--nexus <url>]  Operator TUI dashboard (auto-detects Nexus)

  grove gossip peers    [--server <url>]      List known peers
  grove gossip status   [--server <url>]      Show gossip overview
  grove gossip frontier [--server <url>]      Show merged frontier from gossip
  grove gossip watch    [--server <url>]      Stream gossip events
  grove gossip exchange <peer-url>            Push-pull frontier exchange
  grove gossip shuffle  <peer-url>            CYCLON peer sampling shuffle
  grove gossip sync     <seeds>               Full gossip round with seeds
  grove gossip daemon   <seeds>               Run persistent gossip loop
  grove gossip add-peer <id@address>          Add peer to local store
  grove gossip remove-peer <id>               Remove peer from local store

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
