/**
 * Grove CLI — command-line interface for the contribution graph.
 *
 * Dispatches subcommands to dedicated handlers. Each command parses
 * its own arguments via `parseArgs` from `node:util`.
 *
 * Global flags (--help, --version, --verbose, --grove, --no-color) are handled
 * before dispatch.
 *
 * Commands:
 *   grove init          — Create a new grove
 *   grove contribute    — Submit a contribution
 *   grove claim         — Claim work
 *   grove release       — Release a claim
 *   grove claims        — List claims
 *   grove work-blocks   — List WorkBlock records
 *   grove timeline      — Print timeline events
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

import type { OwnerRef } from "../core/lifecycle-metadata.js";
import type { SessionStore } from "../core/session.js";
import { UsageError } from "./errors.js";
import { setColorEnabled, shouldEnableColor } from "./utils/color.js";
import { suggestCommand } from "./utils/string.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into claim-based commands. */
interface CommandDeps {
  readonly claimStore: import("../core/store.js").ClaimStore;
  readonly sessionOwnerRef?: OwnerRef | undefined;
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
      readonly helpText?: string;
    }
  | {
      readonly name: string;
      readonly description: string;
      readonly needsStore: true;
      readonly handler: (args: readonly string[], deps: CommandDeps) => Promise<void>;
      readonly helpText?: string;
    };

async function resolveSessionOwnerRef(
  goalSessionStore: Pick<SessionStore, "getSession">,
): Promise<OwnerRef | undefined> {
  const sessionId = process.env.GROVE_SESSION_ID;
  if (!sessionId) return undefined;

  const session = await goalSessionStore.getSession(sessionId);
  if (session === undefined) {
    throw new Error(
      `Session ${sessionId} not found. GROVE_SESSION_ID points at a session that does not exist in this grove's session store.`,
    );
  }

  return { kind: "session", id: session.id, uid: session.uid };
}

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
    const { initCliDeps } = await import("./context.js");
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
        await handleContribute(args, groveOverride);
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
        const { parseThreadArgs, runThread } = await import("./commands/thread.js");
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
        const { parseThreadsArgs, runThreads } = await import("./commands/threads.js");
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
        const { runBounty } = await import("./commands/bounty.js");
        const { resolveGroveDir } = await import("./utils/grove-dir.js");
        const { createSqliteStores } = await import("../local/sqlite-store.js");
        const { dbPath } = resolveGroveDir(groveOverride);
        const stores = createSqliteStores(dbPath);
        try {
          const sessionOwnerRef = await resolveSessionOwnerRef(stores.goalSessionStore);
          await runBounty(args, {
            bountyStore: stores.bountyStore,
            claimStore: stores.claimStore,
            ...(sessionOwnerRef !== undefined ? { sessionOwnerRef } : {}),
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
      handler: async (args, deps) => {
        const { runClaim } = await import("./commands/claim.js");
        await runClaim(args, deps);
      },
    },
    {
      name: "release",
      description: "Release a claim",
      needsStore: true,
      handler: async (args, deps) => {
        const { runRelease } = await import("./commands/release.js");
        await runRelease(args, deps);
      },
    },
    {
      name: "claims",
      description: "List claims",
      needsStore: true,
      handler: async (args, deps) => {
        const { runClaims } = await import("./commands/claims.js");
        await runClaims(args, deps);
      },
    },
    {
      name: "work-blocks",
      description: "List WorkBlock records",
      needsStore: false,
      handler: async (args) => {
        const { parseWorkBlocksArgs, runWorkBlocks } = await import("./commands/work-blocks.js");
        await withCliDeps(async (a, deps) => {
          await runWorkBlocks(parseWorkBlocksArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "timeline",
      description: "Print timeline events",
      needsStore: false,
      handler: async (args) => {
        const { parseTimelineArgs, runTimeline } = await import("./commands/timeline.js");
        await withCliDeps(async (a, deps) => {
          await runTimeline(parseTimelineArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "checkout",
      description: "Materialize contribution artifacts",
      needsStore: false,
      handler: async (args) => {
        const { parseCheckoutArgs, runCheckout } = await import("./commands/checkout.js");
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
        const { parseFrontierArgs, runFrontier } = await import("./commands/frontier.js");
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
        const { parseSearchArgs, runSearch } = await import("./commands/search.js");
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
        const { parseLogArgs, runLog } = await import("./commands/log.js");
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
        const { parseTreeArgs, runTree } = await import("./commands/tree.js");
        await withCliDeps(async (a, deps) => {
          await runTree(parseTreeArgs([...a]), deps);
        }, args);
      },
    },
    {
      name: "export-dag",
      description: "Export contribution DAG as JSON",
      needsStore: false,
      handler: async (args) => {
        const { parseExportDagArgs, runExportDag } = await import("./commands/export-dag.js");
        await withCliDeps(async (a, deps) => {
          await runExportDag(parseExportDagArgs([...a]), deps);
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
        const { resolveGroveDir } = await import("./utils/grove-dir.js");
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
      name: "recipe",
      description: "Validate, list, and dry-run Grove recipes",
      needsStore: false,
      helpText: `grove recipe — validate, list, and dry-run Grove recipes

Usage:
  grove recipe validate <path> [--json]
  grove recipe list [--dir <path>] [--json]
  grove recipe run <path> --dry-run [--param key=value] [--json]`,
      handler: async (args) => {
        const { handleRecipe } = await import("./commands/recipe.js");
        await handleRecipe(args);
      },
    },
    {
      name: "session",
      description: "Manage agent sessions (start, list, status, stop, delete)",
      needsStore: false,
      handler: async (args) => {
        const { executeSession } = await import("./commands/session.js");
        await executeSession(args);
      },
    },
    {
      name: "repo",
      description: "Inspect and maintain the bare-clone repo cache",
      needsStore: false,
      handler: async (args) => {
        const { executeRepo } = await import("./commands/repo.js");
        await executeRepo(args);
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
      name: "migrate",
      description: "Migrate legacy grove to namespaced identity",
      needsStore: false,
      handler: async (args) => {
        const { handleMigrate } = await import("./commands/migrate.js");
        await handleMigrate(args, groveOverride);
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
      name: "diagnostics",
      description: "Create a diagnostics ZIP for bug reports",
      needsStore: false,
      helpText: `grove diagnostics — create a diagnostics ZIP for bug reports

Usage:
  grove diagnostics [--exclude-db] [--scrub standard|aggressive|off] [--slot <id>] [--out <path>]`,
      handler: async (args) => {
        const { handleDiagnostics } = await import("./commands/diagnostics.js");
        await handleDiagnostics(args, groveOverride);
      },
    },
    {
      name: "check-trajectory",
      description: "Check a local agent transcript against trajectory rules",
      needsStore: false,
      helpText: `grove check-trajectory — check a local agent transcript

Usage:
  grove check-trajectory --transcript <path> [--spec <path>] [--runtime auto|acpx|codex|claude-stream-json|subprocess|unknown] [--format markdown|json] [--annotated-log <path>]`,
      handler: async (args) => {
        const { parseCheckTrajectoryArgs, runCheckTrajectory } = await import(
          "./commands/check-trajectory.js"
        );
        await runCheckTrajectory(parseCheckTrajectoryArgs(args));
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
  setColorEnabled(shouldEnableColor(process.env, rawArgs));

  // Extract global --grove option before subcommand
  let groveOverride: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i] ?? "";
    if (token === "--grove") {
      const value = rawArgs[i + 1];
      if (!value) {
        throw new UsageError("--grove requires a path value");
      }
      groveOverride = value;
      i++; // skip consumed value
    } else if (token.startsWith("--grove=")) {
      const value = token.slice("--grove=".length);
      if (!value) {
        throw new UsageError("--grove requires a non-empty path value");
      }
      groveOverride = value;
    } else if (token !== "--no-color") {
      args.push(token);
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
    const { handleVersion } = await import("./commands/version.js");
    handleVersion();
    return;
  }

  // Find command
  const commands = buildCommands(groveOverride);
  const command = commands.find((c) => c.name === first);
  if (!command) {
    const suggestion = suggestCommand(
      first,
      commands.map((c) => c.name),
    );
    const hint = suggestion ? `Did you mean '${suggestion}'?` : "Run 'grove --help' for usage.";
    throw new UsageError(`unknown command '${first}'. ${hint}`);
  }

  // Per-command help — only intercept if the command has explicit helpText.
  // Otherwise let the command handler process --help itself (many commands
  // like import, export, gossip, up already print detailed usage internally).
  const subArgs = args.slice(1);
  if ((subArgs[0] === "--help" || subArgs[0] === "-h") && command.helpText) {
    console.log(command.helpText);
    return;
  }

  if (command.needsStore) {
    const { resolveGroveDir } = await import("./utils/grove-dir.js");
    const { createSqliteStores } = await import("../local/sqlite-store.js");
    const { dbPath } = resolveGroveDir(groveOverride);
    const stores = createSqliteStores(dbPath);
    try {
      const sessionOwnerRef = await resolveSessionOwnerRef(stores.goalSessionStore);
      await command.handler(subArgs, {
        claimStore: stores.claimStore,
        ...(sessionOwnerRef !== undefined ? { sessionOwnerRef } : {}),
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
  console.log(`grove — multi-agent contribution graph

Getting Started:
  grove                                Launch TUI (default)
  grove init [--preset <name>] [name]  Create a new grove
  grove migrate [--dry-run|--rollback] Migrate legacy grove to namespaced identity
  grove up [--headless] [--no-tui]     Start all services and TUI
  grove down                           Stop all services

Contributions:
  grove contribute                     Submit a contribution
  grove review <cid>                   Review a contribution
  grove discuss [cid] <msg>            Post a discussion or reply
  grove reproduce <cid>                Submit a reproduction attempt

Navigation:
  grove log [-n <count>]               Recent contributions
  grove frontier [--metric <name>]     Show current frontier
  grove tree [--from <cid>]            DAG visualization
  grove export-dag [options]           Export contribution DAG as JSON
  grove search [--query <text>]        Search contributions
  grove checkout <cid> --to <dir>      Materialize contribution artifacts
  grove thread <cid>                   View a discussion thread
  grove threads [--tag <tag>]          List active discussion threads

Agents:
  grove session start|list|status|stop|delete Manage agent sessions
  grove status [--json]                Agent status overview
  grove inbox send|read                Agent messaging
  grove whoami                         Show resolved agent identity

Work Coordination:
  grove claim <target>                 Claim work to prevent duplication
  grove release <claim-id>             Release a claim
  grove claims                         List active claims
  grove work-blocks [--session <id>]   List WorkBlock records
  grove timeline [--session <id>]      Print timeline events
  grove bounty create|list|claim       Manage bounties
  grove goal [set <text>]              View or set the current goal
  grove outcome set|get|list|stats     Manage outcome annotations

Collaboration:
  grove ask <question>                 Ask a question
  grove export --to-pr|--to-discussion Export to GitHub
  grove import --from-pr|--from-discussion  Import from GitHub

Advanced:
  grove gossip <subcommand>            P2P federation (peers, sync, daemon, ...)
  grove skill install                  Install AI assistant skill files
  grove diagnostics [--out <path>]    Create a diagnostics ZIP for bug reports
  grove check-trajectory --transcript <path> Check local transcript rules
  grove completions bash|zsh|fish      Generate shell completion scripts
  grove tui [--nexus <url>]            Operator TUI dashboard

Global options:
  --grove <path>    Path to grove directory (or set GROVE_DIR)
  --help, -h        Show this help message
  --version, -v     Show version
  --verbose         Show stack traces on error
  --no-color        Disable ANSI color output
  --wide            Show full values in table output (frontier, log, search, threads)
  --json            Machine-readable JSON output

Run 'grove <command> --help' for details on any command.`);
}

// ---------------------------------------------------------------------------
// Centralized error handling
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  // Check for --verbose in original args for stack trace display
  const verbose = process.argv.includes("--verbose");

  if (err instanceof Error) {
    console.error(`grove: ${err.message}`);
    if (err instanceof UsageError && err.suggestion) {
      console.error(`hint: ${err.suggestion}`);
    }
    if (verbose && err.stack) {
      console.error(err.stack);
    }
  } else {
    console.error(`grove: unexpected error: ${String(err)}`);
  }

  // UsageError → exit 2, everything else → exit 1
  process.exitCode = err instanceof UsageError ? err.exitCode : 1;
});
