import { describe, expect, test } from "bun:test";
import { ClaimStatus } from "./models.js";
import { DefaultReconciler } from "./reconciler.js";
import type { ClaimStore, ExpiredClaim } from "./store.js";
import { ExpiryReason } from "./store.js";
import type {
  CheckoutOptions,
  WorkspaceInfo,
  WorkspaceManager,
  WorkspaceQuery,
} from "./workspace.js";
import { WorkspaceStatus } from "./workspace.js";

function makeClaimStore(overrides?: {
  activeClaims?: () => Promise<readonly import("./models.js").Claim[]>;
  release?: (claimId: string) => Promise<import("./models.js").Claim>;
  expireStale?: () => Promise<readonly ExpiredClaim[]>;
  cleanCompleted?: () => Promise<number>;
}): ClaimStore {
  const claimsById = new Map<string, import("./models.js").Claim>();
  return {
    createClaim: async (claim) => {
      claimsById.set(claim.claimId, claim);
      return claim;
    },
    claimOrRenew: async (claim) => claim,
    getClaim: async (claimId) => claimsById.get(claimId),
    heartbeat: async (claimId) => {
      const claim = claimsById.get(claimId);
      if (!claim) throw new Error("missing claim");
      return claim;
    },
    release:
      overrides?.release ??
      (async (claimId) => {
        const claim = claimsById.get(claimId);
        if (!claim) throw new Error("missing claim");
        const released = { ...claim, status: ClaimStatus.Released };
        claimsById.set(claimId, released);
        return released;
      }),
    complete: async (claimId) => {
      const claim = claimsById.get(claimId);
      if (!claim) throw new Error("missing claim");
      const completed = { ...claim, status: ClaimStatus.Completed };
      claimsById.set(claimId, completed);
      return completed;
    },
    expireStale: overrides?.expireStale ?? (async () => []),
    activeClaims: overrides?.activeClaims ?? (async () => []),
    listClaims: async () => [],
    cleanCompleted: overrides?.cleanCompleted ?? (async () => 0),
    countActiveClaims: async () => 0,
    detectStalled: async () => [],
    close: () => undefined,
  };
}

function makeWorkspaceManager(overrides?: {
  listWorkspaces?: (query?: WorkspaceQuery) => Promise<readonly WorkspaceInfo[]>;
  markWorkspaceStale?: (cid: string, agentId: string) => Promise<WorkspaceInfo>;
}): WorkspaceManager {
  return {
    checkout: async (_cid: string, _options: CheckoutOptions) => {
      throw new Error("not implemented");
    },
    getWorkspace: async () => undefined,
    listWorkspaces: overrides?.listWorkspaces ?? (async () => []),
    cleanWorkspace: async () => false,
    markStale: async () => [],
    markWorkspaceStale:
      overrides?.markWorkspaceStale ??
      (async (cid, agentId) => ({
        cid,
        workspacePath: `/tmp/${cid}`,
        agent: { agentId },
        status: WorkspaceStatus.Stale,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      })),
    createBareWorkspace: async (key, options) => ({
      cid: key,
      workspacePath: `/tmp/${key}`,
      agent: options.agent,
      status: WorkspaceStatus.Active,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }),
    touchWorkspace: async () => {
      throw new Error("not implemented");
    },
    close: () => undefined,
  };
}

describe("DefaultReconciler", () => {
  test("deduplicateActiveClaims keeps newest by actual timestamp, not lexical string", async () => {
    const releasedIds: string[] = [];
    const claimStore = makeClaimStore({
      activeClaims: async () => [
        {
          claimId: "old-offset",
          targetRef: "target-1",
          agent: { agentId: "agent-1" },
          status: ClaimStatus.Active,
          intentSummary: "older absolute time, but lexically larger",
          createdAt: "2026-01-01T00:00:00+09:00",
          heartbeatAt: "2026-01-01T00:00:00+09:00",
          leaseExpiresAt: "2026-01-02T00:00:00+09:00",
        },
        {
          claimId: "newer-z",
          targetRef: "target-1",
          agent: { agentId: "agent-1" },
          status: ClaimStatus.Active,
          intentSummary: "newer absolute time",
          createdAt: "2025-12-31T16:00:00Z",
          heartbeatAt: "2025-12-31T16:00:00Z",
          leaseExpiresAt: "2026-01-01T16:00:00Z",
        },
      ],
      release: async (claimId) => {
        releasedIds.push(claimId);
        return {
          claimId,
          targetRef: "target-1",
          agent: { agentId: "agent-1" },
          status: ClaimStatus.Released,
          intentSummary: "released",
          createdAt: "2026-01-01T00:00:00Z",
          heartbeatAt: "2026-01-01T00:00:00Z",
          leaseExpiresAt: "2026-01-01T01:00:00Z",
        };
      },
    });

    const reconciler = new DefaultReconciler(claimStore);
    const result = await reconciler.reconcile();

    expect(result.deduplicatedClaims).toEqual(["old-offset"]);
    expect(releasedIds).toEqual(["old-offset"]);
  });

  test("startupReconcile continues when one orphan workspace fails to mark stale", async () => {
    const claimStore = makeClaimStore({
      expireStale: async () => [],
      activeClaims: async () => [],
    });
    const wsA: WorkspaceInfo = {
      cid: "cid-a",
      workspacePath: "/tmp/cid-a",
      agent: { agentId: "agent-a" },
      status: WorkspaceStatus.Active,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const wsB: WorkspaceInfo = {
      cid: "cid-b",
      workspacePath: "/tmp/cid-b",
      agent: { agentId: "agent-b" },
      status: WorkspaceStatus.Active,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const workspaceManager = makeWorkspaceManager({
      listWorkspaces: async () => [wsA, wsB],
      markWorkspaceStale: async (cid, agentId) => {
        if (cid === "cid-a") throw new Error("concurrent cleanup");
        return {
          cid,
          workspacePath: `/tmp/${cid}`,
          agent: { agentId },
          status: WorkspaceStatus.Stale,
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
          context: { reason: ExpiryReason.Stalled },
        };
      },
    });

    const reconciler = new DefaultReconciler(claimStore, workspaceManager);
    const result = await reconciler.startupReconcile();

    expect(result.expiredClaims).toHaveLength(0);
    expect(result.orphanedWorkspaces).toHaveLength(1);
    expect(result.orphanedWorkspaces[0]?.cid).toBe("cid-b");
    expect(result.orphanedWorkspaces[0]?.status).toBe(WorkspaceStatus.Stale);
  });
});
