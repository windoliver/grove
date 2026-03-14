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
      "agent-id",
      "agent-name",
      "provider",
      "model",
      "platform",
      "role",
    ],
  },
  {
    name: "up",
    description: "Start all grove services and TUI",
    flags: ["headless", "no-tui", "grove", "help"],
  },
  { name: "down", description: "Stop all grove services", flags: ["grove"] },
  {
    name: "contribute",
    description: "Submit a contribution",
    flags: [
      "kind",
      "mode",
      "summary",
      "description",
      "tag",
      "score",
      "seed",
      "parent",
      "json",
      "agent-id",
      "agent-name",
      "provider",
      "model",
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
  { name: "release", description: "Release a claim", flags: ["json"] },
  {
    name: "claims",
    description: "List claims",
    flags: ["agent", "expired", "json"],
  },
  {
    name: "checkout",
    description: "Materialize contribution artifacts",
    flags: ["to", "json"],
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
    flags: ["depth", "json"],
  },
  {
    name: "threads",
    description: "List active discussion threads",
    flags: ["tag", "limit", "json", "wide"],
  },
  {
    name: "ask",
    description: "Ask a question (interactive or AI-answered)",
    flags: ["strategy", "rules-file", "json"],
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
      { name: "set", description: "Set outcome for a contribution", flags: ["json"] },
      { name: "get", description: "Get outcome for a contribution", flags: ["json"] },
      { name: "list", description: "List outcomes", flags: ["status", "json"] },
      { name: "stats", description: "Show outcome statistics", flags: ["json"] },
    ],
  },
  {
    name: "export",
    description: "Export contribution to GitHub",
    flags: ["to-discussion", "to-pr"],
  },
  {
    name: "import",
    description: "Import from GitHub as contribution",
    flags: ["from-pr", "from-discussion"],
  },
  {
    name: "tui",
    description: "Operator TUI dashboard",
    flags: ["interval", "url", "nexus"],
  },
  {
    name: "gossip",
    description: "Gossip protocol commands",
    flags: [],
    subcommands: [
      { name: "peers", description: "List known peers", flags: ["server"] },
      { name: "status", description: "Show gossip overview", flags: ["server"] },
      { name: "frontier", description: "Show merged frontier", flags: ["server"] },
      { name: "watch", description: "Stream gossip events", flags: ["server"] },
      { name: "exchange", description: "Push-pull frontier exchange", flags: [] },
      { name: "shuffle", description: "CYCLON peer sampling shuffle", flags: [] },
      { name: "sync", description: "Full gossip round with seeds", flags: [] },
      { name: "daemon", description: "Run persistent gossip loop", flags: [] },
      { name: "add-peer", description: "Add peer to local store", flags: [] },
      { name: "remove-peer", description: "Remove peer from local store", flags: [] },
    ],
  },
  {
    name: "completions",
    description: "Generate shell completion scripts",
    flags: [],
  },
];
