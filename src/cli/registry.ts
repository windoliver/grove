/**
 * Static command registry for the Grove CLI.
 *
 * Lightweight metadata (name, description, flags) used by:
 * - `grove completions` (shell completion generation)
 * - `printUsage()` (help text)
 * - `buildCommands()` (command dispatch)
 *
 * This module must NOT import any heavy dependencies (stores, servers, etc.)
 * to keep `grove completions` fast.
 */

/** A registered command's metadata (no handler, no imports). */
export interface CommandMeta {
  readonly name: string;
  readonly description: string;
  /** Flag names this command accepts (without leading --). */
  readonly flags: readonly string[];
  /** Subcommands, if any. */
  readonly subcommands?: readonly CommandMeta[];
}

/** All registered grove commands. */
export const COMMANDS: readonly CommandMeta[] = [
  {
    name: "init",
    description: "Create a new grove",
    flags: [
      "seed",
      "mode",
      "metric",
      "description",
      "force",
      "preset",
      "nexus-url",
      "nexus-channel",
      "agent-id",
      "agent-name",
      "provider",
      "model",
      "platform",
      "role",
    ],
  },
  {
    name: "migrate",
    description: "Migrate legacy grove to namespaced identity",
    flags: ["dry-run", "rollback", "grove", "help"],
  },
  {
    name: "up",
    description: "Start all grove services and TUI",
    flags: ["headless", "no-tui", "grove", "build", "nexus-source", "help"],
  },
  { name: "down", description: "Stop all grove services", flags: ["grove", "help"] },
  {
    name: "contribute",
    description: "Submit a contribution",
    flags: [
      "kind",
      "mode",
      "summary",
      "description",
      "artifacts",
      "from-git-diff",
      "from-git-tree",
      "from-report",
      "parent",
      "reviews",
      "responds-to",
      "adopts",
      "reproduces",
      "metric",
      "score",
      "tag",
      "idempotency-key",
      "agent-id",
      "agent-name",
      "provider",
      "model",
      "platform",
      "role",
      "json",
    ],
  },
  {
    name: "discuss",
    description: "Post a discussion or reply",
    flags: ["tag", "mode", "description", "json"],
  },
  {
    name: "review",
    description: "Submit a review of a contribution",
    flags: ["summary", "description", "score", "tag", "json"],
  },
  {
    name: "reproduce",
    description: "Submit a reproduction attempt",
    flags: ["summary", "description", "result", "score", "tag", "json"],
  },
  {
    name: "claim",
    description: "Claim work to prevent duplication",
    flags: ["lease", "intent", "agent-id", "json"],
  },
  { name: "release", description: "Release a claim", flags: ["completed", "json"] },
  {
    name: "claims",
    description: "List claims",
    flags: ["agent", "expired", "json"],
  },
  {
    name: "checkout",
    description: "Materialize contribution artifacts",
    flags: ["to", "frontier", "agent", "json"],
  },
  {
    name: "frontier",
    description: "Show current frontier",
    flags: ["metric", "tag", "mode", "context", "n", "json", "wide"],
  },
  {
    name: "search",
    description: "Search contributions",
    flags: ["query", "kind", "mode", "tag", "agent", "sort", "n", "json", "wide"],
  },
  {
    name: "log",
    description: "Recent contributions",
    flags: ["kind", "mode", "outcome", "n", "json", "wide"],
  },
  {
    name: "tree",
    description: "DAG visualization",
    flags: ["from", "depth", "json"],
  },
  {
    name: "thread",
    description: "View a discussion thread",
    flags: ["depth", "n", "json"],
  },
  {
    name: "threads",
    description: "List active discussion threads",
    flags: ["tag", "limit", "json", "wide"],
  },
  {
    name: "ask",
    description: "Ask a question (interactive or AI-answered)",
    flags: ["options", "context", "strategy", "config"],
  },
  {
    name: "bounty",
    description: "Create, list, or claim bounties",
    flags: [],
    subcommands: [
      {
        name: "create",
        description: "Create a new bounty",
        flags: [
          "amount",
          "deadline",
          "description",
          "criteria",
          "metric-name",
          "metric-threshold",
          "metric-direction",
          "tags",
          "agent-id",
          "zone-id",
          "json",
        ],
      },
      {
        name: "list",
        description: "List bounties",
        flags: ["status", "mine", "agent-id", "limit", "json"],
      },
      {
        name: "claim",
        description: "Claim a bounty",
        flags: ["agent-id", "lease", "json"],
      },
    ],
  },
  {
    name: "outcome",
    description: "Manage outcome annotations",
    flags: [],
    subcommands: [
      {
        name: "set",
        description: "Set outcome for a contribution",
        flags: ["reason", "baseline", "evaluator", "json"],
      },
      { name: "get", description: "Get outcome for a contribution", flags: ["json"] },
      { name: "list", description: "List outcomes", flags: ["status", "n", "json"] },
      { name: "stats", description: "Show outcome statistics", flags: ["json"] },
    ],
  },
  {
    name: "export",
    description: "Export contribution to GitHub",
    flags: ["to-discussion", "to-pr", "category"],
  },
  {
    name: "import",
    description: "Import from GitHub as contribution",
    flags: ["from-pr", "from-discussion"],
  },
  {
    name: "export-dag",
    description: "Export contribution DAG as JSON",
    flags: ["kind", "mode", "agent", "tag", "from", "depth", "n", "output"],
  },
  {
    name: "goal",
    description: "View or set the current goal",
    flags: [],
    subcommands: [
      { name: "get", description: "Show current goal", flags: [] },
      { name: "set", description: "Set a new goal", flags: ["acceptance"] },
    ],
  },
  {
    name: "session",
    description: "Manage agent sessions (start, list, status, stop)",
    flags: [],
    subcommands: [
      {
        name: "start",
        description: "Start a new session",
        flags: ["goal", "preset", "roles", "runtime"],
      },
      { name: "list", description: "List sessions", flags: [] },
      { name: "status", description: "Show session status", flags: [] },
      { name: "stop", description: "Stop current session", flags: ["reason"] },
    ],
  },
  {
    name: "repo",
    description: "Inspect and maintain the bare-clone repo cache",
    flags: [],
    subcommands: [
      { name: "list", description: "List every cached repo with manifest summary", flags: [] },
      {
        name: "prune",
        description: "Remove one or all cache entries",
        flags: ["all"],
      },
      { name: "fetch", description: "Force a fetch on an existing cache entry", flags: [] },
    ],
  },
  {
    name: "tui",
    description: "Operator TUI dashboard",
    flags: ["interval", "url", "nexus", "grove", "help"],
  },
  {
    name: "gossip",
    description: "Gossip protocol commands",
    flags: [],
    subcommands: [
      { name: "peers", description: "List known peers", flags: ["server", "json"] },
      { name: "status", description: "Show gossip overview", flags: ["server", "json"] },
      { name: "frontier", description: "Show merged frontier", flags: ["server", "json"] },
      { name: "watch", description: "Stream gossip events", flags: ["server", "interval", "json"] },
      { name: "exchange", description: "Push-pull frontier exchange", flags: ["peer-id", "json"] },
      { name: "shuffle", description: "CYCLON peer sampling shuffle", flags: ["peer-id", "json"] },
      { name: "sync", description: "Full gossip round with seeds", flags: ["peer-id", "json"] },
      {
        name: "daemon",
        description: "Run persistent gossip loop",
        flags: ["peer-id", "port", "interval"],
      },
      { name: "add-peer", description: "Add peer to local store", flags: [] },
      { name: "remove-peer", description: "Remove peer from local store", flags: [] },
    ],
  },
  {
    name: "skill",
    description: "Manage AI assistant skill files",
    flags: [],
    subcommands: [
      {
        name: "install",
        description: "Install SKILL.md for supported assistants",
        flags: ["server-url", "mcp-url"],
      },
    ],
  },
  {
    name: "inbox",
    description: "Send and read agent messages",
    flags: [],
    subcommands: [
      {
        name: "send",
        description: "Send a message to an agent",
        flags: ["to", "reply-to", "tag", "agent-id", "agent-name", "json"],
      },
      {
        name: "read",
        description: "Read inbox messages",
        flags: ["from", "since", "limit", "json"],
      },
    ],
  },
  {
    name: "whoami",
    description: "Show resolved agent identity",
    flags: ["json"],
  },
  {
    name: "status",
    description: "Show agent status overview",
    flags: ["json"],
  },
  {
    name: "diagnostics",
    description: "Create a diagnostics ZIP for bug reports",
    flags: ["exclude-db", "scrub", "slot", "out", "help"],
  },
  {
    name: "completions",
    description: "Generate shell completion scripts",
    flags: [],
  },
];
