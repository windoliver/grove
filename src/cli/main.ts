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
 *   grove goal          — View or set the current goal
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
import { UsageError } from "./errors.js";
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
      name: "goal",
      description: "View or set the current goal",
      needsStore: false,
      handler: async (args) => {
        const { handleGoal } = await import("./commands/goal.js");
        await handleGoal(args);
      },
    },
    {
      name: "session",
      description: "Manage agent sessions (start, list, status, stop)",
      needsStore: false,
      handler: async (args) => {
        const { executeSession } = await import("./commands/session.js");
        await executeSession(args);
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
    {
      name: "skill",
      description: "Manage AI assistant skill files",
      needsStore: false,
      handler: async (args) => {
        const { handleSkill } = await import("./commands/skill.js");
        await handleSkill(args);
      },
    },
    {
      name: "inbox",
      description: "Send and read agent messages",
      needsStore: false,
      handler: async (args) => {
        const { handleInbox } = await import("./commands/inbox.js");
        await handleInbox(args, groveOverride);
      },
    },
    {
      name: "whoami",
      description: "Show resolved agent identity",
      needsStore: false,
      handler: async (args) => {
        const { handleWhoami } = await import("./commands/whoami.js");
        await handleWhoami(args);
      },
    },
    {
      name: "status",
      description: "Show agent status overview",
      needsStore: false,
      handler: async (args) => {
        const { parseStatusArgs, runStatus } = await import("./commands/status.js");
        await withCliDeps(async (a, deps) => {
          await runStatus(parseStatusArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "completions",
      description: "Generate shell completion scripts",
      needsStore: false,
      handler: async (args) => {
        const { handleCompletions } = await import("./commands/completions.js");
        await handleCompletions(args);
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
  if (first === "--help" || first === "-h") {
    printUsage();
    return;
  }

  // No subcommand → launch TUI (handles uninitialized state internally)
  if (!first) {
    const { handleTuiDirect } = await import("../tui/main.js");
    await handleTuiDirect(groveOverride);
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
    throw new UsageError(`unknown command '${first}'. Run 'grove --help' for usage.`);
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
  grove <command> [options]

Core Commands:
  init                    Create a new grove
    grove init [name]                           Create a new grove with optional name
    grove init --preset <name> [name]           Create from preset
    grove init --nexus-url <url> [name]         Use external Nexus backend
    Example: grove init "My Project" --preset review-loop

  up                      Start all grove services and TUI
    grove up                                    Start services + TUI (default)
    grove up --headless                         Start services only (CI mode)
    grove up --no-tui                           Start services, no dashboard
    Example: grove up --headless

  down                    Stop all grove services
    grove down                                  Graceful shutdown
    Example: grove down

  contribute              Submit a contribution
    grove contribute --kind <type> --summary "<text>"
    grove contribute --parent <cid>             Link to parent contribution
    Example: grove contribute --kind fix --summary "Fix bug in parser"

  discuss                 Post a discussion or reply
    grove discuss <cid> "<message>"             Reply to contribution
    grove discuss --tag <tag> "<message>"       Start new tagged discussion
    Example: grove discuss abc123 "Great work!"

  review                  Submit a review of a contribution
    grove review <cid> --summary "<text>" --score <1-5>
    Example: grove review abc123 --score 4 --summary "Looks good"

  reproduce               Submit a reproduction attempt
    grove reproduce <cid> --result <pass|fail> --summary "<text>"
    Example: grove reproduce abc123 --result pass

Coordination Commands:
  claim                   Claim work to prevent duplication
    grove claim <target> --lease <hours>        Claim with lease duration
    grove claim <target> --intent "<description>"
    Example: grove claim issue-42 --lease 24

  release                 Release a claim
    grove release <claim-id>                    Release specific claim
    Example: grove release claim-123

  claims                  List claims
    grove claims                              List all active claims
    grove claims --agent <id>                   Filter by agent
    grove claims --expired                      Show expired claims
    Example: grove claims --expired

  checkout                Materialize contribution artifacts
    grove checkout <cid> --to <directory>       Checkout to specific dir
    Example: grove checkout abc123 --to ./output

Discovery Commands:
  frontier                Show current frontier
    grove frontier --metric <name>              Rank by specific metric
    grove frontier --tag <tag>                  Filter by tag
    grove frontier --json                       JSON output
    Example: grove frontier --metric value --n 10

  search                  Search contributions
    grove search --query "<text>"               Full-text search
    grove search --kind <type>                  Filter by kind
    Example: grove search --query "bug fix" --n 20

  log                     Recent contributions
    grove log                               Show recent contributions
    grove log --kind <type>                     Filter by kind
    grove log -n <count>                        Number of entries
    Example: grove log -n 50

  tree                    DAG visualization
    grove tree --from <cid>                     Start from specific node
    grove tree --depth <n>                      Limit depth
    Example: grove tree --from abc123 --depth 3

Discussion Commands:
  thread                  View a discussion thread
    grove thread <cid>                          Show full thread
    grove thread <cid> --depth <n>              Limit depth
    Example: grove thread abc123 --depth 5

  threads                 List active discussion threads
    grove threads                           List all threads
    grove threads --tag <tag>                   Filter by tag
    Example: grove threads --tag bug

  ask                     Ask a question
    grove ask "<question>"                      Interactive or AI-answered
    grove ask --strategy <rules|llm|agent>      Answering strategy
    Example: grove ask "How do I fix this?"

Bounty Commands:
  bounty create         Create a new bounty
    grove bounty create <title> --amount <credits> --deadline <duration>
    Example: grove bounty create "Fix parser" --amount 100 --deadline 7d

  bounty list           List bounties
    grove bounty list --status <status>         Filter by status
    grove bounty list --mine                    Show your bounties
    Example: grove bounty list --status open

  bounty claim          Claim a bounty
    grove bounty claim <bounty-id>              Claim specific bounty
    Example: grove bounty claim bounty-42

Outcome Commands:
  outcome set           Set outcome for a contribution
    grove outcome set <cid> <status>            Set status
    Example: grove outcome set abc123 accepted

  outcome get           Get outcome for a contribution
    grove outcome get <cid>                     Get outcome status
    Example: grove outcome get abc123

  outcome list          List outcomes
    grove outcome list --status <status>        Filter by status
    Example: grove outcome list --status accepted

  outcome stats         Show outcome statistics
    grove outcome stats                     Show aggregate stats
    Example: grove outcome stats

Goal Commands:
  goal                  View or set the current goal
    grove goal                            Show current goal
    grove goal set <text>                   Set new goal
    Example: grove goal set "Improve performance"

Session Commands:
  session               Manage agent sessions
    grove session start <agent>               Start agent session
    grove session list                        List active sessions
    grove session status <id>                 Show session status
    grove session stop <id>                   Stop session
    Example: grove session start reviewer

Communication Commands:
  inbox send            Send a message to an agent
    grove inbox send "<msg>" --to @agent      Send to specific agent
    Example: grove inbox send "Ready" --to @reviewer

  inbox read            Read inbox messages
    grove inbox read                      Show all messages
    grove inbox read --from <id>              Filter by sender
    Example: grove inbox read

Identity Commands:
  whoami                Show resolved agent identity
    grove whoami --json                       JSON output
    Example: grove whoami

  status                Show agent status overview
    grove status --json                       JSON output
    Example: grove status

GitHub Integration:
  export                Export contribution to GitHub
    grove export --to-discussion <owner/repo> <cid>
    grove export --to-pr <owner/repo> <cid>
    Example: grove export --to-discussion myorg/myrepo abc123

  import                Import from GitHub as contribution
    grove import --from-pr <owner/repo#number>
    grove import --from-discussion <owner/repo#number>
    Example: grove import --from-pr myorg/myrepo#42

TUI Commands:
  tui                   Operator TUI dashboard
    grove tui --interval <s>                  Refresh interval
    grove tui --url <url>                     Connect to remote server
    Example: grove tui --interval 5

Gossip Commands:
  gossip peers          List known peers
    grove gossip peers --server <url>
    Example: grove gossip peers --server http://node1:4515

  gossip status         Show gossip overview
  gossip frontier       Show merged frontier
  gossip watch          Stream gossip events
  gossip exchange       Push-pull frontier exchange
  gossip shuffle        CYCLON peer sampling shuffle
  gossip sync           Full gossip round with seeds
  gossip daemon         Run persistent gossip loop
  gossip add-peer       Add peer to local store
  gossip remove-peer    Remove peer from local store

Utility Commands:
  skill install         Manage AI assistant skill files
    grove skill install --server-url <url>
    Example: grove skill install

  completions           Generate shell completion scripts
    grove completions bash|zsh|fish
    Example: grove completions bash > ~/.bash_completion

Global Options:
  --grove <path>        Path to grove directory (or set GROVE_DIR)
  --help, -h            Show this help message
  --version, -v         Show version
  --verbose             Show stack traces on error
  --wide                Show full values (no truncation)
  --json                Machine-readable JSON output

Presets:
  review-loop           Code review workflows
  exploration           Open-ended discovery
  swarm-ops             Production multi-agent ops
  research-loop         ML research & benchmarks
  pr-review             GitHub PR analysis
  federated-swarm       Gossip-coordinated teams

For more info: grove <command> --help or see QUICKSTART.md`);
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

  // UsageError → exit 2, everything else → exit 1
  process.exitCode = err instanceof UsageError ? err.exitCode : 1;
});
