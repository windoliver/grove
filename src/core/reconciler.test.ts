import { describe, expect, test } from "bun:test";
import { expectOk } from "./cas.js";
import type { ClaimEntity } from "./entity.js";
import { claimToEntity } from "./entity.js";
import { NotFoundError } from "./errors.js";
import { ownerRefsEqual } from "./lifecycle-metadata.js";
import {
  type ClaimSpecRecord,
  ClaimStatus,
  type ClaimStatusRecord,
  type ClaimView,
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
} from "./models.js";
import { DefaultReconciler } from "./reconciler.js";
import type { ClaimQuery, ClaimStatusPatch, ClaimStore, ExpiredClaim } from "./store.js";
import { ExpiryReason } from "./store.js";
import type {
  CheckoutOptions,
  WorkspaceInfo,
  WorkspaceManager,
  WorkspaceQuery,
} from "./workspace.js";
import { WorkspaceNotFoundError, WorkspaceStatus } from "./workspace.js";

function makeClaimStore(overrides?: {
  activeClaims?: () => Promise<readonly import("./models.js").Claim[]>;
  release?: (claimId: string) => Promise<import("./models.js").Claim>;
  expireStale?: () => Promise<readonly ExpiredClaim[]>;
  cleanCompleted?: () => Promise<number>;
}): ClaimStore {
  const claimsById = new Map<string, import("./models.js").Claim>();
  const viewsById = new Map<string, ClaimView>();
  const viewFromClaim = (claim: import("./models.js").Claim): ClaimView => ({
    spec: claimToSpecRecord(claim),
    status: claimToStatusRecord(claim),
  });
  const viewFor = (claimId: string): ClaimView | undefined => {
    const view = viewsById.get(claimId);
    if (view !== undefined) return view;
    const claim = claimsById.get(claimId);
    return claim === undefined ? undefined : viewFromClaim(claim);
  };
  const putView = (view: ClaimView): void => {
    viewsById.set(view.spec.id, view);
    claimsById.set(view.spec.id, claimViewToClaim(view));
  };
  const putClaim = (claim: import("./models.js").Claim): void => {
    claimsById.set(claim.claimId, claim);
    viewsById.set(claim.claimId, viewFromClaim(claim));
  };

  return {
    putClaimSpec: async (spec: ClaimSpecRecord) => {
      const existing = viewFor(spec.id);
      const now = new Date().toISOString();
      const createdAtMs = Date.parse(spec.createdAt);
      const leaseBaseMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
      const view: ClaimView =
        existing === undefined
          ? {
              spec: {
                ...spec,
                generation: 1,
              },
              status: {
                id: spec.id,
                phase: ClaimStatus.Active,
                observedGeneration: 0,
                lastHeartbeatAt: now,
                leaseExpiresAt: new Date(
                  leaseBaseMs + (spec.leaseDeadlineSec ?? 300) * 1000,
                ).toISOString(),
                conditions: [],
                lastTransitionAt: now,
                attemptCount: 0,
                revision: 1,
              },
            }
          : {
              spec: {
                ...spec,
                createdAt: existing.spec.createdAt,
                generation: existing.spec.generation + 1,
              },
              status: existing.status,
            };
      putView(view);
      return { kind: "ok" as const, view };
    },
    getClaimView: async (claimId) => {
      return viewFor(claimId);
    },
    patchClaimStatus: async (claimId, patch: ClaimStatusPatch) => {
      const view = viewFor(claimId);
      if (view === undefined) {
        throw new NotFoundError({
          resource: "Claim",
          identifier: claimId,
          message: `Claim ${claimId} does not exist`,
        });
      }
      const updatedStatus: ClaimStatusRecord = {
        ...view.status,
        phase: patch.phase ?? view.status.phase,
        observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
        agentSessionId: patch.agentSessionId ?? view.status.agentSessionId,
        lastHeartbeatAt: patch.lastHeartbeatAt ?? view.status.lastHeartbeatAt,
        leaseExpiresAt: patch.leaseExpiresAt ?? view.status.leaseExpiresAt,
        currentContributionCid: patch.currentContributionCid ?? view.status.currentContributionCid,
        conditions: patch.conditions ?? view.status.conditions,
        lastTransitionAt: patch.lastTransitionAt ?? view.status.lastTransitionAt,
        revision: view.status.revision + 1,
      };
      const updated = { spec: view.spec, status: updatedStatus };
      putView(updated);
      return { kind: "ok" as const, view: updated };
    },
    createClaim: async (claim) => {
      putClaim(claim);
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
        putClaim(released);
        return released;
      }),
    releaseOwnedBy: async (ownerRef) => {
      let count = 0;
      for (const claim of claimsById.values()) {
        if (claim.status !== ClaimStatus.Active || !ownerRefsEqual(claim.ownerRef, ownerRef)) {
          continue;
        }
        putClaim({ ...claim, status: ClaimStatus.Released });
        count++;
      }
      return count;
    },
    complete: async (claimId) => {
      const claim = claimsById.get(claimId);
      if (!claim) throw new Error("missing claim");
      const completed = { ...claim, status: ClaimStatus.Completed };
      putClaim(completed);
      return completed;
    },
    deleteTerminalOwnedBy: async (ownerRef) => {
      let count = 0;
      for (const claim of claimsById.values()) {
        if (claim.status === ClaimStatus.Active || !ownerRefsEqual(claim.ownerRef, ownerRef)) {
          continue;
        }
        claimsById.delete(claim.claimId);
        viewsById.delete(claim.claimId);
        count++;
      }
      return count;
    },
    expireStale: overrides?.expireStale ?? (async () => []),
    activeClaims: overrides?.activeClaims ?? (async () => []),
    listClaims: async () => [],
    cleanCompleted: overrides?.cleanCompleted ?? (async () => 0),
    countActiveClaims: async () => 0,
    detectStalled: async () => [],
    listEntities: async (query?: ClaimQuery): Promise<readonly ClaimEntity[]> => {
      const allClaims = [...claimsById.values()];
      let result = allClaims;
      if (query?.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        result = result.filter((c) => statuses.includes(c.status));
      }
      if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
      return result.map((c) => claimToEntity(c));
    },
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

describe("makeClaimStore split claim adapters", () => {
  test("putClaimSpec derives default status lease from createdAt and lease deadline", async () => {
    const claimStore = makeClaimStore();

    const view = expectOk(
      await claimStore.putClaimSpec({
        id: "split-created",
        targetRef: "target-split",
        agent: { agentId: "agent-split" },
        intentSummary: "create split claim",
        createdAt: "2026-01-01T00:00:00.000Z",
        leaseDeadlineSec: 120,
        generation: 99,
      }),
    );

    expect(view.spec.generation).toBe(1);
    expect(view.status.leaseExpiresAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("putClaimSpec updates preserve original createdAt and status", async () => {
    const claimStore = makeClaimStore();

    const created = expectOk(
      await claimStore.putClaimSpec({
        id: "split-updated",
        targetRef: "target-split",
        agent: { agentId: "agent-split" },
        intentSummary: "first intent",
        createdAt: "2026-01-01T00:00:00.000Z",
        generation: 1,
      }),
    );
    const patched = expectOk(
      await claimStore.patchClaimStatus("split-updated", {
        phase: ClaimStatus.Completed,
        observedGeneration: created.spec.generation,
        lastHeartbeatAt: "2026-01-01T00:05:00.000Z",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
        lastTransitionAt: "2026-01-01T00:05:00.000Z",
      }),
    );

    const updated = expectOk(
      await claimStore.putClaimSpec({
        ...created.spec,
        intentSummary: "second intent",
        createdAt: "2026-02-01T00:00:00.000Z",
        generation: 99,
      }),
    );

    expect(updated.spec.createdAt).toBe(created.spec.createdAt);
    expect(updated.spec.generation).toBe(created.spec.generation + 1);
    expect(updated.spec.intentSummary).toBe("second intent");
    expect(updated.status).toEqual(patched.status);
  });

  test("patchClaimStatus preserves split-only status fields in later views", async () => {
    const claimStore = makeClaimStore();
    await claimStore.putClaimSpec({
      id: "split-status",
      targetRef: "target-split",
      agent: { agentId: "agent-split" },
      intentSummary: "status patch",
      createdAt: "2026-01-01T00:00:00.000Z",
      generation: 1,
    });

    const patched = expectOk(
      await claimStore.patchClaimStatus("split-status", {
        phase: ClaimStatus.Active,
        observedGeneration: 7,
        agentSessionId: "session-1",
        lastHeartbeatAt: "2026-01-01T00:03:00.000Z",
        leaseExpiresAt: "2026-01-01T00:08:00.000Z",
        currentContributionCid:
          "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        conditions: [
          {
            type: "Ready",
            status: "True",
            observedGeneration: 7,
            lastTransitionTime: "2026-01-01T00:03:00.000Z",
            reason: "Heartbeat",
            message: "claim heartbeat observed",
          },
        ],
        lastTransitionAt: "2026-01-01T00:03:00.000Z",
      }),
    );

    const current = await claimStore.getClaimView("split-status");

    expect(patched.status.revision).toBe(2);
    expect(patched.status.observedGeneration).toBe(7);
    expect(patched.status.agentSessionId).toBe("session-1");
    expect(patched.status.currentContributionCid).toBe(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(patched.status.conditions).toHaveLength(1);
    expect(patched.status.lastTransitionAt).toBe("2026-01-01T00:03:00.000Z");
    expect(current?.status).toEqual(patched.status);
  });

  test("patchClaimStatus throws NotFoundError for missing claims", async () => {
    const claimStore = makeClaimStore();

    await expect(claimStore.patchClaimStatus("missing", {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

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

  test("startupReconcile continues when one orphan workspace is concurrently removed", async () => {
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
        if (cid === "cid-a") throw new WorkspaceNotFoundError(cid, agentId);
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

  test("startupReconcile surfaces non-benign orphan-mark failures", async () => {
    const claimStore = makeClaimStore({
      expireStale: async () => [],
      activeClaims: async () => [],
    });
    const workspaceManager = makeWorkspaceManager({
      listWorkspaces: async () => [
        {
          cid: "cid-x",
          workspacePath: "/tmp/cid-x",
          agent: { agentId: "agent-x" },
          status: WorkspaceStatus.Active,
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
      ],
      markWorkspaceStale: async () => {
        throw new Error("sqlite write failed");
      },
    });

    const reconciler = new DefaultReconciler(claimStore, workspaceManager);
    await expect(reconciler.startupReconcile()).rejects.toThrow("sqlite write failed");
  });
});
