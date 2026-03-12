/**
 * Query operations.
 *
 * frontierOperation — Multi-signal frontier ranking
 * searchOperation   — Full-text search with filters
 * logOperation      — Recent contributions (newest first)
 * treeOperation     — DAG traversal (children/ancestors/both)
 * threadOperation   — Walk a discussion thread
 * threadsOperation  — Hot threads ranked by activity
 */

import type { FrontierEntry } from "../frontier.js";
import type { Contribution, ContributionKind, ContributionMode, JsonValue } from "../models.js";
import type { ThreadNode, ThreadSummary } from "../store.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok } from "./result.js";

// ---------------------------------------------------------------------------
// Shared summary types
// ---------------------------------------------------------------------------

/** Trimmed contribution summary for list responses. */
export interface ContributionSummary {
  readonly cid: string;
  readonly summary: string;
  readonly kind: string;
  readonly mode: string;
  readonly tags: readonly string[];
  readonly scores?: Readonly<Record<string, { value: number; direction: string }>> | undefined;
  readonly agentId: string;
  readonly createdAt: string;
}

/** Trimmed frontier entry summary. */
export interface FrontierEntrySummary {
  readonly cid: string;
  readonly summary: string;
  readonly value: number;
  readonly kind: string;
  readonly mode: string;
  readonly agentId: string;
}

/** Thread node summary. */
export interface ThreadNodeSummary {
  readonly cid: string;
  readonly depth: number;
  readonly summary: string;
  readonly kind: string;
  readonly agentId: string;
  readonly createdAt: string;
}

/** Thread summary for hot threads. */
export interface ThreadActivitySummary {
  readonly cid: string;
  readonly summary: string;
  readonly kind: string;
  readonly replyCount: number;
  readonly lastReplyAt: string;
  readonly agentId: string;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function toContributionSummary(c: Contribution): ContributionSummary {
  return {
    cid: c.cid,
    summary: c.summary,
    kind: c.kind,
    mode: c.mode,
    tags: c.tags,
    ...(c.scores !== undefined ? { scores: c.scores } : {}),
    agentId: c.agent.agentId,
    createdAt: c.createdAt,
  };
}

function toFrontierEntrySummary(e: FrontierEntry): FrontierEntrySummary {
  return {
    cid: e.cid,
    summary: e.summary,
    value: e.value,
    kind: e.contribution.kind,
    mode: e.contribution.mode,
    agentId: e.contribution.agent.agentId,
  };
}

function toThreadNodeSummary(n: ThreadNode): ThreadNodeSummary {
  return {
    cid: n.contribution.cid,
    depth: n.depth,
    summary: n.contribution.summary,
    kind: n.contribution.kind,
    agentId: n.contribution.agent.agentId,
    createdAt: n.contribution.createdAt,
  };
}

function toThreadActivitySummary(t: ThreadSummary): ThreadActivitySummary {
  return {
    cid: t.contribution.cid,
    summary: t.contribution.summary,
    kind: t.contribution.kind,
    replyCount: t.replyCount,
    lastReplyAt: t.lastReplyAt,
    agentId: t.contribution.agent.agentId,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a frontier operation. */
export interface FrontierResult {
  readonly byMetric: Readonly<Record<string, readonly FrontierEntrySummary[]>>;
  readonly byAdoption: readonly FrontierEntrySummary[];
  readonly byRecency: readonly FrontierEntrySummary[];
  readonly byReviewScore: readonly FrontierEntrySummary[];
  readonly byReproduction: readonly FrontierEntrySummary[];
}

/** Result of a search operation. */
export interface SearchResult {
  readonly results: readonly ContributionSummary[];
  readonly count: number;
}

/** Result of a log operation. */
export interface LogResult {
  readonly results: readonly ContributionSummary[];
  readonly count: number;
}

/** Result of a tree operation. */
export interface TreeResult {
  readonly cid: string;
  readonly summary: string;
  readonly kind: string;
  readonly children?: readonly ContributionSummary[] | undefined;
  readonly ancestors?: readonly ContributionSummary[] | undefined;
}

/** Result of a thread operation. */
export interface ThreadResult {
  readonly nodes: readonly ThreadNodeSummary[];
  readonly count: number;
}

/** Result of a threads (hot threads) operation. */
export interface ThreadsResult {
  readonly threads: readonly ThreadActivitySummary[];
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for the frontier operation. */
export interface FrontierInput {
  readonly metric?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly limit?: number | undefined;
}

/** Input for the search operation. */
export interface SearchInput {
  readonly query: string;
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Input for the log operation. */
export interface LogInput {
  readonly kind?: ContributionKind | undefined;
  readonly mode?: ContributionMode | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Input for the tree operation. */
export interface TreeInput {
  readonly cid: string;
  readonly direction?: "children" | "ancestors" | "both" | undefined;
}

/** Input for the thread operation. */
export interface ThreadInput {
  readonly cid: string;
  readonly maxDepth?: number | undefined;
  readonly limit?: number | undefined;
}

/** Input for the threads (hot threads) operation. */
export interface ThreadsInput {
  readonly tags?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Compute the multi-signal frontier. */
export async function frontierOperation(
  input: FrontierInput,
  deps: OperationDeps,
): Promise<OperationResult<FrontierResult>> {
  try {
    const result = await deps.frontier.compute({
      metric: input.metric,
      tags: input.tags,
      kind: input.kind,
      mode: input.mode,
      agentId: input.agentId,
      agentName: input.agentName,
      context: input.context,
      limit: input.limit,
    });

    return ok({
      byMetric: Object.fromEntries(
        Object.entries(result.byMetric).map(([k, v]) => [k, v.map(toFrontierEntrySummary)]),
      ),
      byAdoption: result.byAdoption.map(toFrontierEntrySummary),
      byRecency: result.byRecency.map(toFrontierEntrySummary),
      byReviewScore: result.byReviewScore.map(toFrontierEntrySummary),
      byReproduction: result.byReproduction.map(toFrontierEntrySummary),
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Full-text search with filters. */
export async function searchOperation(
  input: SearchInput,
  deps: OperationDeps,
): Promise<OperationResult<SearchResult>> {
  try {
    const results = await deps.contributionStore.search(input.query, {
      kind: input.kind,
      mode: input.mode,
      tags: input.tags,
      agentId: input.agentId,
      agentName: input.agentName,
      limit: input.limit,
      offset: input.offset,
    });

    const summaries = results.map(toContributionSummary);
    return ok({ results: summaries, count: summaries.length });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** List recent contributions (newest first). */
export async function logOperation(
  input: LogInput,
  deps: OperationDeps,
): Promise<OperationResult<LogResult>> {
  try {
    const results = await deps.contributionStore.list({
      kind: input.kind,
      mode: input.mode,
      tags: input.tags,
      agentId: input.agentId,
      limit: input.limit,
      offset: input.offset,
    });

    // Store returns oldest-first; reverse for newest-first
    const summaries = results.map(toContributionSummary).reverse();
    return ok({ results: summaries, count: summaries.length });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** View DAG structure around a contribution. */
export async function treeOperation(
  input: TreeInput,
  deps: OperationDeps,
): Promise<OperationResult<TreeResult>> {
  try {
    const contribution = await deps.contributionStore.get(input.cid);
    if (contribution === undefined) {
      return notFound("Contribution", input.cid);
    }

    const direction = input.direction ?? "both";
    const result: TreeResult = {
      cid: contribution.cid,
      summary: contribution.summary,
      kind: contribution.kind,
      ...(direction === "children" || direction === "both"
        ? {
            children: (await deps.contributionStore.children(input.cid)).map(toContributionSummary),
          }
        : {}),
      ...(direction === "ancestors" || direction === "both"
        ? {
            ancestors: (await deps.contributionStore.ancestors(input.cid)).map(
              toContributionSummary,
            ),
          }
        : {}),
    };

    return ok(result);
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Walk a discussion thread. */
export async function threadOperation(
  input: ThreadInput,
  deps: OperationDeps,
): Promise<OperationResult<ThreadResult>> {
  try {
    const nodes = await deps.contributionStore.thread(input.cid, {
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });

    if (nodes.length === 0) {
      return notFound("Thread root", input.cid);
    }

    const summaries = nodes.map(toThreadNodeSummary);
    return ok({ nodes: summaries, count: summaries.length });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** List hot threads ranked by activity. */
export async function threadsOperation(
  input: ThreadsInput,
  deps: OperationDeps,
): Promise<OperationResult<ThreadsResult>> {
  try {
    const threads = await deps.contributionStore.hotThreads({
      tags: input.tags,
      limit: input.limit,
    });

    const summaries = threads.map(toThreadActivitySummary);
    return ok({ threads: summaries, count: summaries.length });
  } catch (error) {
    return fromGroveError(error);
  }
}
