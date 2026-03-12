/**
 * Shared provider functions extracted from LocalDataProvider and NexusDataProvider.
 *
 * These functions implement common logic for TUI data providers,
 * delegating to the core store interfaces.
 */

import type { FrontierCalculator } from "../core/frontier.js";
import type { Claim, Contribution } from "../core/models.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";
import type {
  ActivityQuery,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  GroveMetadata,
  OperatorStats,
} from "./provider.js";
import { buildFrontierSummary } from "./provider-utils.js";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Build dashboard data from stores. */
export async function dashboardFromStores(
  store: ContributionStore,
  claims: ClaimStore,
  frontier: FrontierCalculator,
  name: string,
  mode: string,
): Promise<DashboardData> {
  const [contributionCount, activeClaims, recentContributions, frontierData] = await Promise.all([
    store.count(),
    claims.activeClaims(),
    store.list({ limit: 10 }),
    frontier.compute({ limit: 3 }),
  ]);

  const metadata: GroveMetadata = {
    name,
    contributionCount,
    activeClaimCount: activeClaims.length,
    mode,
    backendLabel: mode,
  };

  return {
    metadata,
    activeClaims,
    recentContributions,
    frontierSummary: buildFrontierSummary(frontierData),
  };
}

// ---------------------------------------------------------------------------
// Contribution detail
// ---------------------------------------------------------------------------

/** Fetch full contribution detail with ancestors, children, and thread. */
export async function contributionDetailFromStore(
  store: ContributionStore,
  cid: string,
): Promise<ContributionDetail | undefined> {
  const contribution = await store.get(cid);
  if (!contribution) return undefined;

  const [ancestors, children, thread] = await Promise.all([
    store.ancestors(cid),
    store.children(cid),
    store.thread(cid, { maxDepth: 20, limit: 50 }),
  ]);

  return { contribution, ancestors, children, thread };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Query claims from a ClaimStore. */
export async function claimsFromStore(
  claims: ClaimStore,
  query?: ClaimsQuery,
): Promise<readonly Claim[]> {
  if (!query || query.status === "active") {
    if (query?.agentId) {
      return claims.listClaims({ status: "active", agentId: query.agentId });
    }
    return claims.activeClaims();
  }
  return claims.listClaims({ agentId: query.agentId });
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** Query activity from a ContributionStore. */
export async function activityFromStore(
  store: ContributionStore,
  query?: ActivityQuery,
): Promise<readonly Contribution[]> {
  return store.list({
    kind: query?.kind,
    tags: query?.tags ? [...query.tags] : undefined,
    agentId: query?.agentId,
    limit: query?.limit ?? 100,
    offset: query?.offset,
  });
}

// ---------------------------------------------------------------------------
// DAG
// ---------------------------------------------------------------------------

/**
 * Build DAG data from a ContributionStore.
 *
 * When rootCid is provided, performs BFS from that root, batch-loading
 * children for in-memory traversal. Otherwise returns the most recent
 * contributions.
 */
export async function dagFromStore(store: ContributionStore, rootCid?: string): Promise<DagData> {
  if (rootCid) {
    const visited = new Set<string>();
    const queue: string[] = [rootCid];
    const result: Contribution[] = [];

    while (queue.length > 0 && result.length < 200) {
      // Batch: drain current queue level for parallel fetch
      const batch = queue.splice(0, Math.min(queue.length, 20));
      const fetched = await Promise.all(
        batch
          .filter((cid) => !visited.has(cid))
          .map(async (cid) => {
            visited.add(cid);
            const contribution = await store.get(cid);
            if (!contribution) return { contribution: undefined, children: [] as Contribution[] };
            const children = await store.children(cid);
            return { contribution, children };
          }),
      );

      for (const { contribution, children } of fetched) {
        if (!contribution) continue;
        result.push(contribution);
        for (const child of children) {
          if (!visited.has(child.cid)) {
            queue.push(child.cid);
          }
        }
      }
    }

    return { contributions: result };
  }

  const contributions = await store.list({ limit: 200 });
  return { contributions };
}

// ---------------------------------------------------------------------------
// Outcome stats
// ---------------------------------------------------------------------------

/** Build operator stats from an OutcomeStore. */
export async function outcomeStatsFromStore(
  outcomes: OutcomeStore | undefined,
): Promise<OperatorStats> {
  if (!outcomes) {
    return {
      totalContributions: 0,
      outcomeBreakdown: { accepted: 0, rejected: 0, crashed: 0, invalidated: 0 },
      acceptanceRate: 0,
      byAgent: [],
    };
  }
  const stats = await outcomes.getStats();
  return {
    totalContributions: stats.total,
    outcomeBreakdown: {
      accepted: stats.accepted,
      rejected: stats.rejected,
      crashed: stats.crashed,
      invalidated: stats.invalidated,
    },
    acceptanceRate: stats.acceptanceRate,
    byAgent: [],
  };
}

// ---------------------------------------------------------------------------
// Artifact diff
// ---------------------------------------------------------------------------

/** Convert raw artifact buffers to diff-friendly strings. */
export function diffArtifactsFromBuffers(
  parentBuf: Buffer,
  childBuf: Buffer,
): { readonly parent: string; readonly child: string } {
  return { parent: parentBuf.toString("utf-8"), child: childBuf.toString("utf-8") };
}
