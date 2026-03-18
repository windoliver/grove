/**
 * grove outcome — manage outcome annotations for contributions.
 *
 * Subcommands:
 *   grove outcome set <cid> <status>   — set the outcome for a contribution
 *   grove outcome get <cid>            — get the outcome for a contribution
 *   grove outcome list                 — list outcomes with optional filters
 *   grove outcome stats                — show aggregated outcome statistics
 *
 * Usage:
 *   grove outcome set blake3:abc123 accepted --reason "looks good"
 *   grove outcome set blake3:abc123 rejected --baseline blake3:def456
 *   grove outcome get blake3:abc123
 *   grove outcome get blake3:abc123 --json
 *   grove outcome list --status accepted -n 10
 *   grove outcome list --json
 *   grove outcome stats
 */

import { parseArgs } from "node:util";
import type { OperationDeps } from "../../core/operations/index.js";
import {
  getOutcomeOperation,
  listOutcomesOperation,
  outcomeStatsOperation,
  setOutcomeOperation,
} from "../../core/operations/index.js";
import type { OutcomeRecord, OutcomeStats, OutcomeStore } from "../../core/outcome.js";
import { OUTCOME_STATUSES } from "../../core/outcome.js";
import type { Writer } from "../context.js";
import { formatTable, outputJson, truncateCid } from "../format.js";
import { resolveAgentId } from "../utils/grove-dir.js";
import { handleOperationError } from "../utils/handle-result.js";
import { parseLimit, requirePositional } from "../utils/parse-helpers.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface OutcomeDeps {
  readonly outcomeStore: OutcomeStore;
  readonly stdout: Writer;
  readonly stderr: Writer;
}

/** Build OperationDeps from OutcomeDeps (only outcome-relevant fields). */
function toOpDeps(deps: OutcomeDeps): OperationDeps {
  return {
    outcomeStore: deps.outcomeStore,
  };
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
  readonly json: boolean;
}

export interface OutcomeGetArgs {
  readonly subcommand: "get";
  readonly cid: string;
  readonly json: boolean;
}

export interface OutcomeListArgs {
  readonly subcommand: "list";
  readonly status?: string | undefined;
  readonly limit: number;
  readonly json: boolean;
}

export interface OutcomeStatsArgs {
  readonly subcommand: "stats";
  readonly json: boolean;
}

export type OutcomeArgs = OutcomeSetArgs | OutcomeGetArgs | OutcomeListArgs | OutcomeStatsArgs;

const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export function parseOutcomeArgs(argv: string[]): OutcomeArgs {
  const subcommand = argv[0];

  if (subcommand === "set") {
    return parseSetArgs(argv.slice(1));
  }
  if (subcommand === "get") {
    return parseGetArgs(argv.slice(1));
  }
  if (subcommand === "list") {
    return parseListArgs(argv.slice(1));
  }
  if (subcommand === "stats") {
    return parseStatsArgs(argv.slice(1));
  }

  throw new Error(
    `Unknown subcommand: '${subcommand ?? "(none)"}'. Expected: set, get, list, stats`,
  );
}

function parseSetArgs(argv: string[]): OutcomeSetArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      reason: { type: "string" },
      baseline: { type: "string" },
      evaluator: { type: "string" },
      json: { type: "boolean", default: false },
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
    json: values.json ?? false,
  };
}

function parseGetArgs(argv: string[]): OutcomeGetArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const cid = requirePositional(positionals, 0, "cid");

  return {
    subcommand: "get",
    cid,
    json: values.json ?? false,
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

  const limit = parseLimit(values.n, DEFAULT_LIMIT);

  return {
    subcommand: "list",
    status: values.status,
    limit,
    json: values.json ?? false,
  };
}

function parseStatsArgs(argv: string[]): OutcomeStatsArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    subcommand: "stats",
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
    case "get":
      return runGet(args, deps);
    case "list":
      return runList(args, deps);
    case "stats":
      return runStats(args, deps);
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

  const result = await setOutcomeOperation(
    {
      cid: args.cid,
      status: args.status as OutcomeRecord["status"],
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.baseline !== undefined ? { baselineCid: args.baseline } : {}),
      agent: { agentId: args.evaluator },
    },
    toOpDeps(deps),
  );

  if (!result.ok) {
    handleOperationError(result.error, args.json);
    return;
  }

  if (args.json) {
    outputJson(result.value);
    return;
  }

  const record = result.value;
  deps.stdout(
    `Outcome set: ${truncateCid(record.cid)} → ${record.status} (by ${record.evaluatedBy})`,
  );
}

async function runGet(args: OutcomeGetArgs, deps: OutcomeDeps): Promise<void> {
  const result = await getOutcomeOperation({ cid: args.cid }, toOpDeps(deps));

  if (!result.ok) {
    handleOperationError(result.error, args.json);
    return;
  }

  if (args.json) {
    outputJson(result.value);
    return;
  }

  const r = result.value;
  deps.stdout(
    `Outcome for ${truncateCid(r.cid)}:\n` +
      `  Status:      ${r.status}\n` +
      `  Evaluator:   ${r.evaluatedBy}\n` +
      `  Evaluated:   ${r.evaluatedAt}` +
      (r.reason ? `\n  Reason:      ${r.reason}` : "") +
      (r.baselineCid ? `\n  Baseline:    ${truncateCid(r.baselineCid)}` : ""),
  );
}

async function runList(args: OutcomeListArgs, deps: OutcomeDeps): Promise<void> {
  const result = await listOutcomesOperation(
    {
      ...(args.status !== undefined ? { status: args.status as OutcomeRecord["status"] } : {}),
      limit: args.limit,
    },
    toOpDeps(deps),
  );

  if (!result.ok) {
    deps.stderr(`Error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  const outcomes = result.value;

  if (args.json) {
    outputJson(outcomes);
    return;
  }

  deps.stdout(formatTable(OUTCOME_COLUMNS, outcomes.map(outcomeToRow)));
}

async function runStats(args: OutcomeStatsArgs, deps: OutcomeDeps): Promise<void> {
  const result = await outcomeStatsOperation(toOpDeps(deps));

  if (!result.ok) {
    deps.stderr(`Error: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    outputJson(result.value);
    return;
  }

  deps.stdout(formatStats(result.value));
}
