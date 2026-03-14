/**
 * grove search — full-text and filtered search over contributions.
 *
 * Usage:
 *   grove search --tag optimizer --sort adoption
 *   grove search --kind review --agent codex-bob
 *   grove search --query "connection pool" --sort recency
 *   grove search --mode exploration
 *   grove search --json
 */

import { parseArgs } from "node:util";

import type { ContributionKind, ContributionMode } from "../../core/models.js";
import type { ContributionSummary } from "../../core/operations/index.js";
import { searchOperation } from "../../core/operations/index.js";
import type { ContributionQuery } from "../../core/store.js";
import type { CliDeps, Writer } from "../context.js";
import { formatContributions, outputJson } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";

const DEFAULT_LIMIT = 20;

export type SortField = "recency" | "adoption";

export interface SearchOptions {
  readonly query?: string | undefined;
  readonly kind?: string | undefined;
  readonly mode?: string | undefined;
  readonly tag?: string | undefined;
  readonly agent?: string | undefined;
  readonly sort: SortField;
  readonly limit: number;
  readonly json: boolean;
  readonly wide: boolean;
}

export function parseSearchArgs(argv: string[]): SearchOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      query: { type: "string" },
      kind: { type: "string" },
      mode: { type: "string" },
      tag: { type: "string" },
      agent: { type: "string" },
      sort: { type: "string", default: "recency" },
      n: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
      wide: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const limit = values.n !== undefined ? Number.parseInt(values.n, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit <= 0) {
    throw new Error(`Invalid limit: '${values.n}'. Must be a positive integer.`);
  }

  const sort = values.sort as SortField;
  if (sort !== "recency" && sort !== "adoption") {
    throw new Error(`Invalid sort: '${sort}'. Must be 'recency' or 'adoption'.`);
  }

  return {
    query: values.query,
    kind: values.kind,
    mode: values.mode,
    tag: values.tag,
    agent: values.agent,
    sort,
    limit,
    json: values.json ?? false,
    wide: values.wide ?? false,
  };
}

export async function runSearch(
  options: SearchOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const filters: ContributionQuery = {
    kind: options.kind as ContributionKind | undefined,
    mode: options.mode as ContributionMode | undefined,
    tags: options.tag !== undefined ? [options.tag] : undefined,
    agentName: options.agent,
  };

  // When using the search operation for text queries with recency sort,
  // delegate to the operation layer. For adoption sort or no-query listing,
  // use the store directly since adoption counting is CLI-specific logic.
  if (options.query && options.sort === "recency") {
    const result = await searchOperation(
      {
        query: options.query,
        ...(options.kind !== undefined ? { kind: options.kind as ContributionKind } : {}),
        ...(options.mode !== undefined ? { mode: options.mode as ContributionMode } : {}),
        ...(options.tag !== undefined ? { tags: [options.tag] } : {}),
        ...(options.agent !== undefined ? { agentName: options.agent } : {}),
      },
      toOperationDeps(deps),
    );

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    if (options.json) {
      const sliced = result.value.results.slice(0, options.limit);
      outputJson({ results: sliced, count: sliced.length });
      return;
    }

    // Fetch full Contribution objects for display formatting
    const cids = result.value.results.map((r) => r.cid);
    const fullMap = await deps.store.getMany(cids);
    const full = cids
      .map((cid) => fullMap.get(cid))
      .filter((c): c is import("../../core/models.js").Contribution => c !== undefined);
    const sorted = [...full]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, options.limit);

    writer(formatContributions(sorted, { wide: options.wide }));
    return;
  }

  // No query or adoption sort — fetch all matching, then sort and slice
  let results = options.query
    ? await deps.store.search(options.query, filters)
    : await deps.store.list(filters);

  // Sort, then apply limit
  if (options.sort === "recency") {
    results = [...results]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, options.limit);
  } else if (options.sort === "adoption") {
    // Count adoption + derives_from relations pointing at each result
    const allContributions = await deps.store.list();
    const adoptionCounts = new Map<string, number>();
    for (const r of results) {
      adoptionCounts.set(r.cid, 0);
    }
    for (const c of allContributions) {
      for (const rel of c.relations) {
        if (
          (rel.relationType === "adopts" || rel.relationType === "derives_from") &&
          adoptionCounts.has(rel.targetCid)
        ) {
          adoptionCounts.set(rel.targetCid, (adoptionCounts.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }
    results = [...results]
      .sort((a, b) => (adoptionCounts.get(b.cid) ?? 0) - (adoptionCounts.get(a.cid) ?? 0))
      .slice(0, options.limit);
  }

  if (options.json) {
    const summaries: ContributionSummary[] = results.map((c) => ({
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

  writer(formatContributions(results, { wide: options.wide }));
}
