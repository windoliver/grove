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
import type { DangerousToken } from "./safety/index.js";

// ---------------------------------------------------------------------------
// HTTP conflict error
// ---------------------------------------------------------------------------
//
// `HttpConflictError` is the structured form of a 409 response from a
// `@Dangerous` route. The `ConfirmAndMutateProvider`'s retry loop reads
// `status` + `current` from the thrown error to bump its snapshot RV and
// re-open the modal (C6 #304, T11 critical item A).
//
// Why a class (not a plain object): `parseConflict` in
// `safety/confirm-and-mutate.tsx` accepts any object with the right shape,
// but a named class makes the contract greppable from the route handler
// side and gives `instanceof` reachable for future error walls.
// ---------------------------------------------------------------------------

export class HttpConflictError extends Error {
  readonly status = 409 as const;
  readonly current: { readonly resourceVersion: string; readonly generation: number };

  constructor(
    message: string,
    current: { readonly resourceVersion: string; readonly generation: number },
  ) {
    super(message);
    this.name = "HttpConflictError";
    this.current = current;
  }
}

interface ConflictBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly current?: { readonly resourceVersion?: string; readonly generation?: number };
  };
}

/**
 * Parse a 409 response body into an `HttpConflictError`.
 *
 * Expected shape (per T6 routes): `{ error: { code, message, current: { resourceVersion, generation } } }`.
 * Falls back to safe defaults if the body is unparseable so the provider's
 * retry loop still fires (with retryCount-based termination).
 */
async function buildConflictError(res: Response): Promise<HttpConflictError> {
  let body: ConflictBody | null = null;
  try {
    body = (await res.json()) as ConflictBody;
  } catch {
    body = null;
  }
  const current = body?.error?.current ?? {};
  const resourceVersion =
    typeof current.resourceVersion === "string" ? current.resourceVersion : "?";
  const generation = typeof current.generation === "number" ? current.generation : 0;
  const detail = body?.error?.message ?? "conflict";
  return new HttpConflictError(`HTTP 409: ${detail}`, { resourceVersion, generation });
}

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

/**
 * Map from API response format (backwards-compat fields) to Session format.
 *
 * The HTTP API's `toSessionResponse` mapper preserves backwards compat by
 * sending `sessionId`, `startedAt`, `endedAt`. This function normalises
 * those back to the canonical `Session` field names (`id`, `createdAt`,
 * `completedAt`).
 */
interface ApiSessionResponse {
  readonly sessionId?: string;
  readonly id?: string;
  readonly uid?: string;
  readonly goal?: string;
  readonly presetName?: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly createdAt?: string;
  readonly endedAt?: string;
  readonly completedAt?: string;
  readonly stopReason?: string;
  readonly stopStatus?: import("../core/loop-runner.js").LoopStopStatus;
  readonly topology?: import("../core/topology.js").AgentTopology;
  readonly config?: import("../core/contract.js").GroveContract;
  readonly contributionCount?: number;
  readonly finalizers?: readonly import("../core/lifecycle-metadata.js").Finalizer[];
  readonly resourceVersion?: number;
}

function mapApiSession(raw: ApiSessionResponse): SessionRecord {
  const id = (raw.sessionId ?? raw.id) as string;
  return {
    id,
    uid: raw.uid ?? id,
    goal: raw.goal,
    presetName: raw.presetName,
    status: raw.status as SessionRecord["status"],
    createdAt: (raw.startedAt ?? raw.createdAt) as string,
    finalizers: raw.finalizers ?? [],
    completedAt: raw.endedAt ?? raw.completedAt,
    stopReason: raw.stopReason,
    stopStatus: raw.stopStatus,
    topology: raw.topology,
    config: raw.config,
    contributionCount: raw.contributionCount ?? 0,
    resourceVersion: raw.resourceVersion,
  };
}

/** Fetch the current goal from a grove-server HTTP API. */
export async function fetchGoalHttp(
  baseUrl: string,
  authHeaders?: Record<string, string>,
): Promise<GoalData | undefined> {
  const resp = await fetch(`${baseUrl}/api/session/goal`, { headers: authHeaders });
  if (resp.ok) return (await resp.json()) as GoalData;
  if (resp.status === 404) return undefined;
  return undefined;
}

/**
 * Set a goal via a grove-server HTTP API.
 *
 * C6 (#304): `token` carries the goal's current `ifMatch` resourceVersion;
 * the helper threads it through to the `@Dangerous` PUT route's If-Match
 * header. The route returns 409 on stale RV — callers should refetch and
 * re-mint the token via `confirmAndMutate` (T10).
 */
export async function setGoalHttp(
  token: DangerousToken<"Goal">,
  baseUrl: string,
  goal: string,
  acceptance: readonly string[],
  authHeaders?: Record<string, string>,
): Promise<GoalData> {
  const resp = await fetch(`${baseUrl}/api/session/goal`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "if-match": token.ifMatch,
      ...authHeaders,
    },
    body: JSON.stringify({ goal, acceptance }),
  });
  if (resp.ok) return (await resp.json()) as GoalData;
  if (resp.status === 409) throw await buildConflictError(resp);
  throw new Error(`Failed to set goal: HTTP ${String(resp.status)}`);
}

/** List sessions via a grove-server HTTP API. */
export async function listSessionsHttp(
  baseUrl: string,
  query?: { status?: "active" | "archived"; presetName?: string },
  authHeaders?: Record<string, string>,
): Promise<readonly SessionRecord[]> {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.presetName) params.set("preset_name", query.presetName);
  const qs = params.toString();
  const resp = await fetch(`${baseUrl}/api/sessions${qs ? `?${qs}` : ""}`, {
    headers: authHeaders,
  });
  if (resp.ok) {
    const body = (await resp.json()) as { sessions: readonly ApiSessionResponse[] };
    return body.sessions.map(mapApiSession);
  }
  return [];
}

/** Create a session via a grove-server HTTP API. */
export async function createSessionHttp(
  baseUrl: string,
  input: SessionInput,
  authHeaders?: Record<string, string>,
): Promise<SessionRecord> {
  const resp = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(input),
  });
  if (resp.ok) return mapApiSession((await resp.json()) as ApiSessionResponse);
  throw new Error(`Failed to create session: HTTP ${String(resp.status)}`);
}

/** Get a session by ID via a grove-server HTTP API. */
export async function getSessionHttp(
  baseUrl: string,
  sessionId: string,
  authHeaders?: Record<string, string>,
): Promise<SessionRecord | undefined> {
  const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    headers: authHeaders,
  });
  if (resp.ok) return mapApiSession((await resp.json()) as ApiSessionResponse);
  if (resp.status === 404) return undefined;
  return undefined;
}

/**
 * Archive a session via a grove-server HTTP API.
 *
 * C6 (#304): `token.id` supplies the session id for the URL path and
 * `token.ifMatch` is sent as the If-Match header. The `@Dangerous` PUT
 * route returns 409 on stale RV — callers should refetch the session
 * and re-mint the token via `confirmAndMutate` (T10).
 */
export async function archiveSessionHttp(
  token: DangerousToken<"AgentSession">,
  baseUrl: string,
  authHeaders?: Record<string, string>,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(token.id)}/archive`, {
    method: "PUT",
    headers: { "if-match": token.ifMatch, ...authHeaders },
  });
  if (resp.ok) return;
  if (resp.status === 409) throw await buildConflictError(resp);
  throw new Error(`Failed to archive session: HTTP ${String(resp.status)}`);
}

/** Add a contribution to a session via a grove-server HTTP API. */
export async function addContributionToSessionHttp(
  baseUrl: string,
  sessionId: string,
  cid: string,
  authHeaders?: Record<string, string>,
): Promise<void> {
  const resp = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/contributions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ cid }),
    },
  );
  if (resp.ok) return;
  throw new Error(`Failed to add contribution to session: HTTP ${String(resp.status)}`);
}
