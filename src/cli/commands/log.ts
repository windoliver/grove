/**
 * grove log — list recent contributions in reverse chronological order.
 *
 * Usage:
 *   grove log                    # recent contributions (default 20)
 *   grove log --kind work        # only work contributions
 *   grove log --mode exploration  # only exploration mode
 *   grove log -n 10              # last 10
 *   grove log --json             # JSON output
 */

import { parseArgs } from "node:util";

import type { OutcomeStatus } from "../../core/outcome.js";
import { OUTCOME_STATUSES } from "../../core/outcome.js";
import type { ContributionQuery } from "../../core/store.js";
import type { CliDeps, Writer } from "../context.js";
import { formatContributions } from "../format.js";

const DEFAULT_LIMIT = 20;

export interface LogOptions {
  readonly kind?: string | undefined;
  readonly mode?: string | undefined;
  readonly outcome?: string | undefined;
  readonly limit: number;
  readonly json: boolean;
}

export function parseLogArgs(argv: string[]): LogOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      mode: { type: "string" },
      outcome: { type: "string" },
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

  if (values.outcome !== undefined && !OUTCOME_STATUSES.has(values.outcome)) {
    throw new Error(
      `Invalid outcome: '${values.outcome}'. Must be one of: accepted, rejected, crashed, invalidated.`,
    );
  }

  return {
    kind: values.kind,
    mode: values.mode,
    outcome: values.outcome,
    limit,
    json: values.json ?? false,
  };
}

export async function runLog(
  options: LogOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  // Fetch all matching contributions (no limit yet — we must sort first)
  const query: ContributionQuery = {
    kind: options.kind as ContributionQuery["kind"],
    mode: options.mode as ContributionQuery["mode"],
  };

  let contributions = await deps.store.list(query);

  // Filter by outcome status if requested
  if (options.outcome !== undefined) {
    if (deps.outcomeStore === undefined) {
      throw new Error("Outcome store is not available. Cannot filter by outcome.");
    }
    const cids = contributions.map((c) => c.cid);
    const outcomes = await deps.outcomeStore.getBatch(cids);
    const targetStatus = options.outcome as OutcomeStatus;
    contributions = contributions.filter((c) => {
      const record = outcomes.get(c.cid);
      return record !== undefined && record.status === targetStatus;
    });
  }

  // Sort by createdAt descending (most recent first), then apply limit
  const sorted = [...contributions]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, options.limit);

  if (options.json) {
    writer(JSON.stringify(sorted, null, 2));
    return;
  }

  writer(formatContributions(sorted));
}
