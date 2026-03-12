/**
 * Shared test utilities for Grove core tests.
 *
 * Provides an in-memory ContributionStore implementation that all test
 * files can share, ensuring consistent behavior across test suites and
 * a single place to update when the ContributionStore interface evolves.
 */

import type { Contribution, ContributionKind, Relation, RelationType } from "./models.js";
import type {
  ContributionQuery,
  ContributionStore,
  HotThreadsOptions,
  ThreadNode,
  ThreadSummary,
} from "./store.js";

/**
 * In-memory ContributionStore for testing.
 *
 * Implements the full ContributionStore interface with simple Map/Array
 * operations. Supports list() filtering, search (substring match),
 * findExisting, thread traversal (BFS), and reply counting.
 */
export class InMemoryContributionStore implements ContributionStore {
  private readonly contributions = new Map<string, Contribution>();

  constructor(contributions: readonly Contribution[] = []) {
    for (const c of contributions) {
      this.contributions.set(c.cid, c);
    }
  }

  put = async (c: Contribution): Promise<void> => {
    this.contributions.set(c.cid, c);
  };

  putMany = async (cs: readonly Contribution[]): Promise<void> => {
    for (const c of cs) this.contributions.set(c.cid, c);
  };

  get = async (cid: string): Promise<Contribution | undefined> => this.contributions.get(cid);

  getMany = async (cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> => {
    const result = new Map<string, Contribution>();
    for (const cid of cids) {
      const c = this.contributions.get(cid);
      if (c !== undefined) {
        result.set(cid, c);
      }
    }
    return result;
  };

  list = async (query?: ContributionQuery): Promise<readonly Contribution[]> => {
    let results = [...this.contributions.values()];

    if (query?.kind !== undefined) {
      results = results.filter((c) => c.kind === query.kind);
    }
    if (query?.mode !== undefined) {
      results = results.filter((c) => c.mode === query.mode);
    }
    if (query?.tags !== undefined && query.tags.length > 0) {
      results = results.filter((c) => query.tags?.every((t) => c.tags.includes(t)));
    }
    if (query?.agentId !== undefined) {
      results = results.filter((c) => c.agent.agentId === query.agentId);
    }
    if (query?.agentName !== undefined) {
      results = results.filter((c) => c.agent.agentName === query.agentName);
    }
    if (query?.offset !== undefined) {
      results = results.slice(query.offset);
    }
    if (query?.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  };

  count = async (query?: ContributionQuery): Promise<number> => {
    const results = await this.list(query);
    return results.length;
  };

  children = async (cid: string): Promise<readonly Contribution[]> => {
    const result: Contribution[] = [];
    for (const c of this.contributions.values()) {
      for (const rel of c.relations) {
        if (rel.targetCid === cid) {
          result.push(c);
          break;
        }
      }
    }
    return result;
  };

  ancestors = async (cid: string): Promise<readonly Contribution[]> => {
    const c = this.contributions.get(cid);
    if (c === undefined) return [];
    const result: Contribution[] = [];
    for (const rel of c.relations) {
      const target = this.contributions.get(rel.targetCid);
      if (target !== undefined) result.push(target);
    }
    return result;
  };

  relationsOf = async (cid: string, relationType?: RelationType): Promise<readonly Relation[]> => {
    const c = this.contributions.get(cid);
    if (c === undefined) return [];
    if (relationType === undefined) return c.relations;
    return c.relations.filter((r) => r.relationType === relationType);
  };

  relatedTo = async (
    cid: string,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    const result: Contribution[] = [];
    for (const c of this.contributions.values()) {
      for (const rel of c.relations) {
        if (
          rel.targetCid === cid &&
          (relationType === undefined || rel.relationType === relationType)
        ) {
          result.push(c);
          break;
        }
      }
    }
    return result;
  };

  search = async (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> => {
    const lower = query.toLowerCase();
    let results = [...this.contributions.values()].filter(
      (c) =>
        c.summary.toLowerCase().includes(lower) || c.description?.toLowerCase().includes(lower),
    );

    if (filters?.kind !== undefined) {
      results = results.filter((c) => c.kind === filters.kind);
    }
    if (filters?.mode !== undefined) {
      results = results.filter((c) => c.mode === filters.mode);
    }
    if (filters?.tags !== undefined && filters.tags.length > 0) {
      results = results.filter((c) => filters.tags?.every((t) => c.tags.includes(t)));
    }
    if (filters?.limit !== undefined) {
      results = results.slice(0, filters.limit);
    }

    return results;
  };

  findExisting = async (
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    return [...this.contributions.values()].filter(
      (c) =>
        c.agent.agentId === agentId &&
        c.kind === kind &&
        c.relations.some(
          (r) =>
            r.targetCid === targetCid &&
            (relationType === undefined || r.relationType === relationType),
        ),
    );
  };

  thread = async (
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> => {
    const maxDepth = opts?.maxDepth ?? 50;
    const root = this.contributions.get(rootCid);
    if (root === undefined) return [];

    // BFS from root, collecting nodes with depth
    const nodes: ThreadNode[] = [{ contribution: root, depth: 0 }];
    const visited = new Set<string>([rootCid]);

    // Build children map: parent CID → child contributions with responds_to
    const childrenOf = new Map<string, Contribution[]>();
    for (const c of this.contributions.values()) {
      for (const rel of c.relations) {
        if (rel.relationType === "responds_to") {
          let children = childrenOf.get(rel.targetCid);
          if (children === undefined) {
            children = [];
            childrenOf.set(rel.targetCid, children);
          }
          children.push(c);
        }
      }
    }

    // BFS level by level
    let currentLevel = [rootCid];
    let depth = 0;

    while (currentLevel.length > 0 && depth < maxDepth) {
      depth += 1;
      const nextLevel: string[] = [];

      // Collect all children at this depth, sorted by createdAt
      const childrenAtDepth: { cid: string; contribution: Contribution }[] = [];
      for (const parentCid of currentLevel) {
        const children = childrenOf.get(parentCid) ?? [];
        for (const child of children) {
          if (!visited.has(child.cid)) {
            childrenAtDepth.push({ cid: child.cid, contribution: child });
          }
        }
      }

      // Sort by createdAt for chronological ordering within depth
      childrenAtDepth.sort(
        (a, b) => Date.parse(a.contribution.createdAt) - Date.parse(b.contribution.createdAt),
      );

      for (const { cid, contribution } of childrenAtDepth) {
        if (visited.has(cid)) continue;
        visited.add(cid);
        nodes.push({ contribution, depth });
        nextLevel.push(cid);
      }

      currentLevel = nextLevel;
    }

    if (opts?.limit !== undefined) {
      return nodes.slice(0, opts.limit);
    }
    return nodes;
  };

  replyCounts = async (cids: readonly string[]): Promise<ReadonlyMap<string, number>> => {
    const result = new Map<string, number>();
    for (const cid of cids) {
      result.set(cid, 0);
    }

    const cidSet = new Set(cids);
    for (const c of this.contributions.values()) {
      for (const rel of c.relations) {
        if (rel.relationType === "responds_to" && cidSet.has(rel.targetCid)) {
          result.set(rel.targetCid, (result.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }

    return result;
  };

  hotThreads = async (opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]> => {
    // Build map: target CID → { count, lastReplyAt }
    const threadInfo = new Map<string, { replyCount: number; lastReplyAt: string }>();
    for (const c of this.contributions.values()) {
      for (const rel of c.relations) {
        if (rel.relationType === "responds_to") {
          const existing = threadInfo.get(rel.targetCid);
          if (existing === undefined) {
            threadInfo.set(rel.targetCid, { replyCount: 1, lastReplyAt: c.createdAt });
          } else {
            existing.replyCount += 1;
            // Compare by UTC epoch to handle timezone offsets correctly
            if (new Date(c.createdAt).getTime() > new Date(existing.lastReplyAt).getTime()) {
              existing.lastReplyAt = c.createdAt;
            }
          }
        }
      }
    }

    // Collect thread summaries
    const summaries: ThreadSummary[] = [];
    for (const [cid, info] of threadInfo) {
      const contribution = this.contributions.get(cid);
      if (contribution === undefined) continue;

      // Tag filter — deduplicate tags to match SQLite behavior
      if (opts?.tags !== undefined && opts.tags.length > 0) {
        const uniqueTags = [...new Set(opts.tags)];
        if (!uniqueTags.every((t) => contribution.tags.includes(t))) continue;
      }

      summaries.push({
        contribution,
        replyCount: info.replyCount,
        lastReplyAt: info.lastReplyAt,
      });
    }

    // Sort: reply count DESC, then last reply UTC epoch DESC
    summaries.sort((a, b) => {
      if (b.replyCount !== a.replyCount) return b.replyCount - a.replyCount;
      return new Date(b.lastReplyAt).getTime() - new Date(a.lastReplyAt).getTime();
    });

    // Apply default limit of 20 to match SQLite backend
    const limit = opts?.limit ?? 20;
    return summaries.slice(0, limit);
  };

  close(): void {}
}
