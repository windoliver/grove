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

/**
 * Compute a diff between two artifact versions using a provided `getArtifact`
 * function. This is the canonical implementation shared by all providers.
 */
export async function diffArtifactsUsing(
  getArtifact: (cid: string, name: string) => Promise<Buffer>,
  parentCid: string,
  childCid: string,
  name: string,
): Promise<{ readonly parent: string; readonly child: string }> {
  const [parentBuf, childBuf] = await Promise.all([
    getArtifact(parentCid, name),
    getArtifact(childCid, name),
  ]);
  return diffArtifactsFromBuffers(parentBuf, childBuf);
}

// ---------------------------------------------------------------------------
// Goal/session HTTP delegation helpers
// ---------------------------------------------------------------------------
//
// These functions encapsulate the HTTP fetch pattern shared by
// NexusDataProvider (when a co-located server URL is available) and
// RemoteDataProvider (which always talks HTTP).
// ---------------------------------------------------------------------------

import type { GoalData, SessionInput, SessionRecord } from "./provider.js";

/** Fetch the current goal from a grove-server HTTP API. */
export async function fetchGoalHttp(baseUrl: string): Promise<GoalData | undefined> {
  const resp = await fetch(`${baseUrl}/api/session/goal`);
  if (resp.ok) return (await resp.json()) as GoalData;
  if (resp.status === 404) return undefined;
  return undefined;
}

/** Set a goal via a grove-server HTTP API. */
export async function setGoalHttp(
  baseUrl: string,
  goal: string,
  acceptance: readonly string[],
): Promise<GoalData> {
  const resp = await fetch(`${baseUrl}/api/session/goal`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, acceptance }),
  });
  if (resp.ok) return (await resp.json()) as GoalData;
  throw new Error(`Failed to set goal: HTTP ${String(resp.status)}`);
}

/** List sessions via a grove-server HTTP API. */
export async function listSessionsHttp(
  baseUrl: string,
  query?: { status?: "active" | "archived"; presetName?: string },
): Promise<readonly SessionRecord[]> {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.presetName) params.set("preset_name", query.presetName);
  const qs = params.toString();
  const resp = await fetch(`${baseUrl}/api/sessions${qs ? `?${qs}` : ""}`);
  if (resp.ok) {
    const body = (await resp.json()) as { sessions: readonly SessionRecord[] };
    return body.sessions;
  }
  return [];
}

/** Create a session via a grove-server HTTP API. */
export async function createSessionHttp(
  baseUrl: string,
  input: SessionInput,
): Promise<SessionRecord> {
  const resp = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (resp.ok) return (await resp.json()) as SessionRecord;
  throw new Error(`Failed to create session: HTTP ${String(resp.status)}`);
}

/** Get a session by ID via a grove-server HTTP API. */
export async function getSessionHttp(
  baseUrl: string,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
  if (resp.ok) return (await resp.json()) as SessionRecord;
  if (resp.status === 404) return undefined;
  return undefined;
}

/** Archive a session via a grove-server HTTP API. */
export async function archiveSessionHttp(baseUrl: string, sessionId: string): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "PUT",
  });
  if (resp.ok) return;
  throw new Error(`Failed to archive session: HTTP ${String(resp.status)}`);
}

/** Add a contribution to a session via a grove-server HTTP API. */
export async function addContributionToSessionHttp(
  baseUrl: string,
  sessionId: string,
  cid: string,
): Promise<void> {
  const resp = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/contributions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    },
  );
  if (resp.ok) return;
  throw new Error(`Failed to add contribution to session: HTTP ${String(resp.status)}`);
}
