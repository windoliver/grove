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
import type { ContributionQuery } from "../../core/store.js";
import type { CliDeps, Writer } from "../context.js";
import { formatContributions } from "../format.js";

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
  };
}

export async function runSearch(
  options: SearchOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  // Fetch all matching results (no limit yet — we must sort first, then slice)
  const filters: ContributionQuery = {
    kind: options.kind as ContributionKind | undefined,
    mode: options.mode as ContributionMode | undefined,
    tags: options.tag !== undefined ? [options.tag] : undefined,
    agentName: options.agent,
  };

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
    writer(JSON.stringify(results, null, 2));
    return;
  }

  writer(formatContributions(results));
}
