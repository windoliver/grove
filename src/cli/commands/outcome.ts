/**
 * grove outcome — manage outcome annotations for contributions.
 *
 * Subcommands:
 *   grove outcome set <cid> <status>   — set the outcome for a contribution
 *   grove outcome list                 — list outcomes with optional filters
 *   grove outcome stats                — show aggregated outcome statistics
 *
 * Usage:
 *   grove outcome set blake3:abc123 accepted --reason "looks good"
 *   grove outcome set blake3:abc123 rejected --baseline blake3:def456
 *   grove outcome list --status accepted -n 10
 *   grove outcome list --json
 *   grove outcome stats
 */

import { parseArgs } from "node:util";

import type {
  OutcomeQuery,
  OutcomeRecord,
  OutcomeStats,
  OutcomeStore,
} from "../../core/outcome.js";
import { OUTCOME_STATUSES } from "../../core/outcome.js";
import type { Writer } from "../context.js";
import { formatTable, truncateCid } from "../format.js";
import { resolveAgentId } from "../utils/grove-dir.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface OutcomeDeps {
  readonly outcomeStore: OutcomeStore;
  readonly stdout: Writer;
  readonly stderr: Writer;
}

// ---------------------------------------------------------------------------
// Parsed arguments
// ---------------------------------------------------------------------------

export interface OutcomeSetArgs {
  readonly subcommand: "set";
  readonly cid: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly baseline?: string | undefined;
  readonly evaluator: string;
}

export interface OutcomeListArgs {
  readonly subcommand: "list";
  readonly status?: string | undefined;
  readonly limit: number;
  readonly json: boolean;
}

export interface OutcomeStatsArgs {
  readonly subcommand: "stats";
}

export type OutcomeArgs = OutcomeSetArgs | OutcomeListArgs | OutcomeStatsArgs;

const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export function parseOutcomeArgs(argv: string[]): OutcomeArgs {
  const subcommand = argv[0];

  if (subcommand === "set") {
    return parseSetArgs(argv.slice(1));
  }
  if (subcommand === "list") {
    return parseListArgs(argv.slice(1));
  }
  if (subcommand === "stats") {
    return { subcommand: "stats" };
  }

  throw new Error(`Unknown subcommand: '${subcommand ?? "(none)"}'. Expected: set, list, stats`);
}

function parseSetArgs(argv: string[]): OutcomeSetArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      reason: { type: "string" },
      baseline: { type: "string" },
      evaluator: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const cid = positionals[0];
  const status = positionals[1];

  if (!cid || !status) {
    throw new Error(
      "Usage: grove outcome set <cid> <status> [--reason <text>] [--baseline <cid>] [--evaluator <name>]",
    );
  }

  return {
    subcommand: "set",
    cid,
    status,
    reason: values.reason,
    baseline: values.baseline,
    evaluator: resolveAgentId(values.evaluator),
  };
}

function parseListArgs(argv: string[]): OutcomeListArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      status: { type: "string" },
      n: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const limit = values.n !== undefined ? Number.parseInt(values.n, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit <= 0) {
    throw new Error(`Invalid limit: '${values.n}'. Must be a positive integer.`);
  }

  return {
    subcommand: "list",
    status: values.status,
    limit,
    json: values.json ?? false,
  };
}

// ---------------------------------------------------------------------------
// Outcome table columns
// ---------------------------------------------------------------------------

const OUTCOME_COLUMNS = [
  { header: "CID", key: "cid", maxWidth: 22 },
  { header: "STATUS", key: "status", maxWidth: 12 },
  { header: "EVALUATOR", key: "evaluator", maxWidth: 16 },
  { header: "EVALUATED AT", key: "evaluatedAt", maxWidth: 24 },
] as const;

function outcomeToRow(r: OutcomeRecord): Record<string, string> {
  return {
    cid: truncateCid(r.cid),
    status: r.status,
    evaluator: r.evaluatedBy,
    evaluatedAt: r.evaluatedAt,
  };
}

// ---------------------------------------------------------------------------
// Stats formatter
// ---------------------------------------------------------------------------

function formatStats(stats: OutcomeStats): string {
  const pct = (n: number): string => {
    if (stats.total === 0) return "0.0%";
    return `${((n / stats.total) * 100).toFixed(1)}%`;
  };

  const labelWidth = 14;
  const lines = [
    "Outcome Statistics:",
    `  ${"Total:".padEnd(labelWidth)}${stats.total}`,
    `  ${"Accepted:".padEnd(labelWidth)}${String(stats.accepted).padStart(String(stats.total).length)}  (${pct(stats.accepted)})`,
    `  ${"Rejected:".padEnd(labelWidth)}${String(stats.rejected).padStart(String(stats.total).length)}  (${pct(stats.rejected)})`,
    `  ${"Crashed:".padEnd(labelWidth)}${String(stats.crashed).padStart(String(stats.total).length)}  (${pct(stats.crashed)})`,
    `  ${"Invalidated:".padEnd(labelWidth)}${String(stats.invalidated).padStart(String(stats.total).length)}  (${pct(stats.invalidated)})`,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runOutcome(args: OutcomeArgs, deps: OutcomeDeps): Promise<void> {
  switch (args.subcommand) {
    case "set":
      return runSet(args, deps);
    case "list":
      return runList(args, deps);
    case "stats":
      return runStats(deps);
  }
}

async function runSet(args: OutcomeSetArgs, deps: OutcomeDeps): Promise<void> {
  if (!OUTCOME_STATUSES.has(args.status)) {
    deps.stderr(
      `Error: invalid status '${args.status}'. Must be one of: ${[...OUTCOME_STATUSES].join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  const record = await deps.outcomeStore.set(args.cid, {
    status: args.status as OutcomeRecord["status"],
    reason: args.reason,
    baselineCid: args.baseline,
    evaluatedBy: args.evaluator,
  });

  deps.stdout(
    `Outcome set: ${truncateCid(record.cid)} → ${record.status} (by ${record.evaluatedBy})`,
  );
}

async function runList(args: OutcomeListArgs, deps: OutcomeDeps): Promise<void> {
  const query: OutcomeQuery = {
    status: args.status as OutcomeQuery["status"],
    limit: args.limit,
  };

  const outcomes = await deps.outcomeStore.list(query);

  if (args.json) {
    deps.stdout(JSON.stringify(outcomes, null, 2));
    return;
  }

  deps.stdout(formatTable(OUTCOME_COLUMNS, outcomes.map(outcomeToRow)));
}

async function runStats(deps: OutcomeDeps): Promise<void> {
  const stats = await deps.outcomeStore.getStats();
  deps.stdout(formatStats(stats));
}
