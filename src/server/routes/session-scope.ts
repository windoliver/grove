import { contributionToEntity } from "../../core/entity.js";
import type { Contribution, Relation } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import type { OperationDeps } from "../../core/operations/deps.js";
import type {
  ContributionQuery,
  ContributionStore,
  HotThreadsOptions,
  ThreadNode,
  ThreadSummary,
} from "../../core/store.js";
import type { ServerDeps } from "../deps.js";
import { toOperationDeps } from "../operation-adapter.js";

class SessionFilteredContributionStore implements ContributionStore {
  readonly storeIdentity: string | undefined;
  private readonly inner: ContributionStore;
  private readonly sessionId: string;
  private sessionCidsPromise: Promise<ReadonlySet<string>> | undefined;

  constructor(inner: ContributionStore, sessionId: string) {
    this.inner = inner;
    this.sessionId = sessionId;
    this.storeIdentity =
      inner.storeIdentity !== undefined ? `${inner.storeIdentity}:session:${sessionId}` : undefined;
  }

  private async sessionCids(): Promise<ReadonlySet<string>> {
    this.sessionCidsPromise ??= this.inner
      .list({ sessionId: this.sessionId })
      .then((items) => new Set(items.map((c) => c.cid)));
    return this.sessionCidsPromise;
  }

  private async includes(cid: string): Promise<boolean> {
    const cids = await this.sessionCids();
    return cids.has(cid);
  }

  private async filterSessionContributions(
    contributions: readonly Contribution[],
  ): Promise<readonly Contribution[]> {
    const cids = await this.sessionCids();
    return contributions.filter((c) => cids.has(c.cid));
  }

  put = async (contribution: Contribution): Promise<void> => {
    await this.inner.put(contribution);
    this.sessionCidsPromise = undefined;
  };

  putMany = async (contributions: readonly Contribution[]): Promise<void> => {
    await this.inner.putMany(contributions);
    this.sessionCidsPromise = undefined;
  };

  get = async (cid: string): Promise<Contribution | undefined> => {
    if (!(await this.includes(cid))) return undefined;
    return this.inner.get(cid);
  };

  getMany = async (cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> => {
    const sessionCids = await this.sessionCids();
    return this.inner.getMany(cids.filter((cid) => sessionCids.has(cid)));
  };

  list = (query?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.inner.list({ ...query, sessionId: this.sessionId });

  children = async (cid: string): Promise<readonly Contribution[]> => {
    if (!(await this.includes(cid))) return [];
    return this.filterSessionContributions(await this.inner.children(cid));
  };

  incomingSources = async (targetCids: readonly string[]): Promise<readonly Contribution[]> => {
    const sessionCids = await this.sessionCids();
    const scopedTargets = targetCids.filter((cid) => sessionCids.has(cid));
    return this.filterSessionContributions(await this.inner.incomingSources(scopedTargets));
  };

  ancestors = async (cid: string): Promise<readonly Contribution[]> => {
    if (!(await this.includes(cid))) return [];
    return this.filterSessionContributions(await this.inner.ancestors(cid));
  };

  relationsOf = async (cid: string, relationType?: RelationType): Promise<readonly Relation[]> => {
    if (!(await this.includes(cid))) return [];
    const sessionCids = await this.sessionCids();
    return (await this.inner.relationsOf(cid, relationType)).filter((rel) =>
      sessionCids.has(rel.targetCid),
    );
  };

  relatedTo = async (
    cid: string,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    if (!(await this.includes(cid))) return [];
    return this.filterSessionContributions(await this.inner.relatedTo(cid, relationType));
  };

  search = (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.inner.search(query, { ...filters, sessionId: this.sessionId });

  findExisting = async (
    agentId: string,
    targetCid: string,
    kind: Contribution["kind"],
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> => {
    if (!(await this.includes(targetCid))) return [];
    return this.filterSessionContributions(
      await this.inner.findExisting(agentId, targetCid, kind, relationType),
    );
  };

  count = (query?: ContributionQuery): Promise<number> =>
    this.inner.count({ ...query, sessionId: this.sessionId });

  countSince = async (query: { agentId?: string; since: string }): Promise<number> => {
    const contributions = await this.inner.list({
      sessionId: this.sessionId,
      agentId: query.agentId,
    });
    const sinceMs = Date.parse(query.since);
    return contributions.filter((c) => Date.parse(c.createdAt) >= sinceMs).length;
  };

  thread = async (
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> => {
    const limit = opts?.limit;
    if (limit !== undefined && limit <= 0) return [];

    const root = await this.get(rootCid);
    if (root === undefined) return [];

    const maxDepth = opts?.maxDepth ?? 50;
    const nodes: ThreadNode[] = [{ contribution: root, depth: 0 }];
    if (limit !== undefined && nodes.length >= limit) return nodes.slice(0, limit);

    const visited = new Set<string>([rootCid]);
    let currentLevel = [rootCid];

    for (let depth = 1; depth <= maxDepth && currentLevel.length > 0; depth++) {
      const childrenAtDepth = (
        await Promise.all(currentLevel.map((cid) => this.children(cid)))
      ).flat();
      childrenAtDepth.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      const nextLevel: string[] = [];
      for (const child of childrenAtDepth) {
        if (visited.has(child.cid)) continue;
        visited.add(child.cid);
        nodes.push({ contribution: child, depth });
        nextLevel.push(child.cid);
        if (limit !== undefined && nodes.length >= limit) return nodes.slice(0, limit);
      }
      currentLevel = nextLevel;
    }

    return nodes;
  };

  replyCounts = async (cids: readonly string[]): Promise<ReadonlyMap<string, number>> => {
    const result = new Map<string, number>();
    for (const cid of cids) result.set(cid, 0);

    const contributions = await this.inner.list({ sessionId: this.sessionId });
    const sessionCids = new Set(contributions.map((c) => c.cid));
    const targetCids = new Set(cids.filter((cid) => sessionCids.has(cid)));
    for (const contribution of contributions) {
      for (const rel of contribution.relations) {
        if (rel.relationType === RelationType.RespondsTo && targetCids.has(rel.targetCid)) {
          result.set(rel.targetCid, (result.get(rel.targetCid) ?? 0) + 1);
        }
      }
    }
    return result;
  };

  hotThreads = async (opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]> => {
    const contributions = await this.inner.list({ sessionId: this.sessionId });
    const byCid = new Map(contributions.map((c) => [c.cid, c]));
    const threadInfo = new Map<string, { replyCount: number; lastReplyAt: string }>();

    for (const contribution of contributions) {
      for (const rel of contribution.relations) {
        if (rel.relationType !== RelationType.RespondsTo || !byCid.has(rel.targetCid)) continue;
        const existing = threadInfo.get(rel.targetCid);
        if (existing === undefined) {
          threadInfo.set(rel.targetCid, {
            replyCount: 1,
            lastReplyAt: contribution.createdAt,
          });
        } else {
          existing.replyCount += 1;
          if (Date.parse(contribution.createdAt) > Date.parse(existing.lastReplyAt)) {
            existing.lastReplyAt = contribution.createdAt;
          }
        }
      }
    }

    const requiredTags = opts?.tags !== undefined ? [...new Set(opts.tags)] : [];
    const summaries: ThreadSummary[] = [];
    for (const [cid, info] of threadInfo) {
      const contribution = byCid.get(cid);
      if (contribution === undefined) continue;
      if (
        requiredTags.length > 0 &&
        !requiredTags.every((tag) => contribution.tags.includes(tag))
      ) {
        continue;
      }
      summaries.push({ contribution, ...info });
    }

    summaries.sort((a, b) => {
      if (b.replyCount !== a.replyCount) return b.replyCount - a.replyCount;
      return Date.parse(b.lastReplyAt) - Date.parse(a.lastReplyAt);
    });

    return summaries.slice(0, opts?.limit ?? 20);
  };

  async listEntities(query?: ContributionQuery) {
    return (await this.list(query)).map(contributionToEntity);
  }

  close(): void {
    // This is a non-owning filtered view; the server runtime owns the inner store lifetime.
  }
}

export function contributionStoreForSession(
  deps: ServerDeps,
  sessionId: string | undefined,
): ContributionStore {
  if (sessionId !== undefined && deps.contributionStoreForSession !== undefined) {
    return deps.contributionStoreForSession(sessionId);
  }
  if (sessionId !== undefined) {
    return new SessionFilteredContributionStore(deps.contributionStore, sessionId);
  }
  return deps.contributionStore;
}

export function operationDepsForSession(
  deps: ServerDeps,
  sessionId: string | undefined,
): OperationDeps {
  const scopedContributionStore = contributionStoreForSession(deps, sessionId);
  const scopedFrontier =
    sessionId !== undefined && deps.frontierForSession !== undefined
      ? deps.frontierForSession(sessionId)
      : deps.frontier;

  return {
    ...toOperationDeps(deps),
    contributionStore: scopedContributionStore,
    frontier: scopedFrontier,
  };
}
