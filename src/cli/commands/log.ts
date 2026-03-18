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

import type { ContributionKind, ContributionMode } from "../../core/models.js";
import type { ContributionSummary } from "../../core/operations/index.js";
import { logOperation } from "../../core/operations/index.js";
import type { OutcomeStatus } from "../../core/outcome.js";
import { OUTCOME_STATUSES } from "../../core/outcome.js";
import type { CliDeps, Writer } from "../context.js";
import { formatContributions, outputJson } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";
import { parseLimit } from "../utils/parse-helpers.js";

const DEFAULT_LIMIT = 20;

export interface LogOptions {
  readonly kind?: string | undefined;
  readonly mode?: string | undefined;
  readonly outcome?: string | undefined;
  readonly limit: number;
  readonly json: boolean;
  readonly wide: boolean;
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
      wide: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const limit = parseLimit(values.n, DEFAULT_LIMIT);

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
    wide: values.wide ?? false,
  };
}

export async function runLog(
  options: LogOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  // Outcome filtering requires direct store access (getBatch is not in the operation)
  if (options.outcome !== undefined) {
    if (deps.outcomeStore === undefined) {
      throw new Error("Outcome store is not available. Cannot filter by outcome.");
    }

    // Fetch all matching contributions, filter by outcome, then sort and slice
    const contributions = await deps.store.list({
      kind: options.kind as ContributionKind | undefined,
      mode: options.mode as ContributionMode | undefined,
    });

    const cids = contributions.map((c) => c.cid);
    const outcomes = await deps.outcomeStore.getBatch(cids);
    const targetStatus = options.outcome as OutcomeStatus;
    const filtered = contributions.filter((c) => {
      const record = outcomes.get(c.cid);
      return record !== undefined && record.status === targetStatus;
    });

    const sorted = [...filtered]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, options.limit);

    if (options.json) {
      const summaries: ContributionSummary[] = sorted.map((c) => ({
        cid: c.cid,
        summary: c.summary,
        kind: c.kind,
        mode: c.mode,
        tags: c.tags,
        ...(c.scores !== undefined ? { scores: c.scores } : {}),
        agentId: c.agent.agentId,
        createdAt: c.createdAt,
      }));
      outputJson({ results: summaries, count: summaries.length });
      return;
    }
    writer(formatContributions(sorted, { wide: options.wide }));
    return;
  }

  // Use the operation layer to fetch contributions (without limit — the operation's
  // store-level limit returns oldest-first which would cut off newest entries).
  // Apply limit after the operation reverses to newest-first order.
  const result = await logOperation(
    {
      ...(options.kind !== undefined ? { kind: options.kind as ContributionKind } : {}),
      ...(options.mode !== undefined ? { mode: options.mode as ContributionMode } : {}),
    },
    toOperationDeps(deps),
  );

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  // The operation returns newest-first; apply CLI limit
  const sliced = result.value.results.slice(0, options.limit);

  if (options.json) {
    outputJson({ results: sliced, count: sliced.length });
    return;
  }

  // Fetch full Contribution objects for display
  const cids = sliced.map((r) => r.cid);
  const fullMap = await deps.store.getMany(cids);
  // Preserve the operation's order (newest first)
  const full = cids
    .map((cid) => fullMap.get(cid))
    .filter((c): c is import("../../core/models.js").Contribution => c !== undefined);

  writer(formatContributions(full, { wide: options.wide }));
}
