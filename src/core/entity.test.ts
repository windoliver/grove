import { describe, expect, test } from "bun:test";
import type { AgentSession } from "./agent-runtime.js";
import type {
  AgentSessionEntity,
  ClaimEntity,
  Condition,
  ConditionStatus,
  ContributionEntity,
  Entity,
  EntityMetadata,
} from "./entity.js";
import {
  agentSessionToEntity,
  claimToEntity,
  claimViewToEntity,
  contributionToEntity,
} from "./entity.js";
import { Finalizer } from "./lifecycle-metadata.js";
import type { Claim, ClaimView, Contribution } from "./models.js";
import {
  ClaimStatus,
  ContributionKind,
  ContributionMode,
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
} from "./models.js";
import { makeClaim } from "./test-helpers.js";

describe("Entity envelope types", () => {
  test("Condition has six required fields", () => {
    const c: Condition = {
      type: "Ready",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: "2026-04-23T00:00:00Z",
      reason: "Started",
      message: "",
    };
    expect(c.type).toBe("Ready");
    expect(c.status).toBe("True");
  });

  test("ConditionStatus allows True | False | Unknown", () => {
    const values: ConditionStatus[] = ["True", "False", "Unknown"];
    expect(values).toHaveLength(3);
  });

  test("EntityMetadata requires generation, optional creationTimestamp", () => {
    const m: EntityMetadata = { generation: 1 };
    expect(m.generation).toBe(1);
    expect(m.creationTimestamp).toBeUndefined();
  });

  test("Entity envelope carries kind discriminant and all envelope fields", () => {
    type Foo = Entity<"Foo", { name: string }, { phase: string }>;
    const e: Foo = {
      kind: "Foo",
      namespace: "default",
      id: "foo-1",
      spec: { name: "x" },
      status: { phase: "ready" },
      conditions: [],
      observedGeneration: 0,
      resourceVersion: "0",
      metadata: { generation: 1 },
    };
    expect(e.kind).toBe("Foo");
    expect(e.namespace).toBe("default");
    expect(e.spec.name).toBe("x");
  });
});

function makeContribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    cid: "cid-1",
    manifestVersion: 1,
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "s",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1" },
    createdAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

describe("contributionToEntity", () => {
  test("wraps cid as id, namespace=default", () => {
    const e: ContributionEntity = contributionToEntity(makeContribution(), "default");
    expect(e.kind).toBe("Contribution");
    expect(e.id).toBe("cid-1");
    expect(e.namespace).toBe("default");
  });

  test("projects domain kind into spec.contributionKind", () => {
    const e = contributionToEntity(makeContribution({ kind: ContributionKind.Review }), "default");
    expect(e.spec.contributionKind).toBe("review");
  });

  test("status is empty object (immutable kind)", () => {
    const e = contributionToEntity(makeContribution(), "default");
    expect(e.status).toEqual({});
  });

  test("resourceVersion=0, observedGeneration=0, metadata.generation=1", () => {
    const e = contributionToEntity(makeContribution(), "default");
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
    expect(e.metadata.creationTimestamp).toBe("2026-04-23T00:00:00Z");
  });

  test("Published condition is always True with reason=Created", () => {
    const e = contributionToEntity(makeContribution(), "default");
    expect(e.conditions).toHaveLength(1);
    const published = e.conditions[0];
    expect(published?.type).toBe("Published");
    expect(published?.status).toBe("True");
    expect(published?.reason).toBe("Created");
    expect(published?.lastTransitionTime).toBe("2026-04-23T00:00:00Z");
    expect(published?.observedGeneration).toBe(0);
    expect(published?.message).toBe("");
  });

  test("preserves all spec fields from the contribution", () => {
    const c = makeContribution({
      summary: "hello",
      description: "full",
      tags: ["a", "b"],
      commitHash: "abc123",
    });
    const e = contributionToEntity(c, "default");
    expect(e.spec.summary).toBe("hello");
    expect(e.spec.description).toBe("full");
    expect(e.spec.tags).toEqual(["a", "b"]);
    expect(e.spec.commitHash).toBe("abc123");
    expect(e.spec.agent).toEqual({ agentId: "agent-1" });
    expect(e.spec.mode).toBe("evaluation");
    expect(e.spec.artifacts).toEqual({});
  });
});

function makeEntityClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: "claim-1",
    targetRef: "target-x",
    agent: { agentId: "agent-1" },
    status: ClaimStatus.Active,
    intentSummary: "do x",
    createdAt: "2026-04-23T00:00:00Z",
    heartbeatAt: "2026-04-23T00:01:00Z",
    leaseExpiresAt: "2026-04-23T00:05:00Z",
    ...overrides,
  };
}

describe("claim split conversion helpers", () => {
  test("claimToSpecRecord projects desired-state fields from flat claim", () => {
    const claim = makeClaim({
      claimId: "claim-rich",
      agent: { agentId: "agent-rich", platform: "codex", role: "coder" },
      context: { issue: 270 },
      createdAt: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:06:00.000Z",
      revision: 4,
    });

    const spec = claimToSpecRecord(claim);

    expect(spec.id).toBe("claim-rich");
    expect(spec.roleName).toBe("coder");
    expect(spec.platform).toBe("codex");
    expect(spec.assignee).toEqual(claim.agent);
    expect(spec.leaseDeadlineSec).toBe(360);
    expect(spec.generation).toBe(4);
    expect(spec.targetRef).toBe(claim.targetRef);
    expect(spec.context).toEqual({ issue: 270 });
  });

  test("claimToSpecRecord omits leaseDeadlineSec for invalid or non-forward leases", () => {
    const invalid = claimToSpecRecord(
      makeClaim({
        createdAt: "not-a-date",
        leaseExpiresAt: "2026-01-01T00:06:00.000Z",
      }),
    );
    expect(invalid.leaseDeadlineSec).toBeUndefined();

    const nonForward = claimToSpecRecord(
      makeClaim({
        createdAt: "2026-01-01T00:06:00.000Z",
        leaseExpiresAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(nonForward.leaseDeadlineSec).toBeUndefined();
  });

  test("claimToStatusRecord projects observed state and supplied conditions", () => {
    const claim = makeClaim({
      claimId: "claim-status",
      heartbeatAt: "2026-01-01T00:01:00.000Z",
      leaseExpiresAt: "2026-01-01T00:06:00.000Z",
      attemptCount: 3,
      revision: 4,
    });
    const condition: Condition = {
      type: "Active",
      status: "True",
      observedGeneration: 4,
      lastTransitionTime: "2026-01-01T00:01:00.000Z",
      reason: "active",
      message: "",
    };

    const status = claimToStatusRecord(claim, [condition]);

    expect(status.id).toBe("claim-status");
    expect(status.phase).toBe("active");
    expect(status.observedGeneration).toBe(4);
    expect(status.lastHeartbeatAt).toBe("2026-01-01T00:01:00.000Z");
    expect(status.leaseExpiresAt).toBe("2026-01-01T00:06:00.000Z");
    expect(status.conditions).toEqual([condition]);
    expect(status.lastTransitionAt).toBe("2026-01-01T00:01:00.000Z");
    expect(status.attemptCount).toBe(3);
    expect(status.revision).toBe(4);
  });

  test("claimViewToClaim merges split records and only preserves optional fields when set", () => {
    const claim = makeClaim({
      claimId: "claim-view",
      context: { issue: 270 },
      attemptCount: 2,
      revision: 5,
    });
    const view: ClaimView = {
      spec: claimToSpecRecord(claim),
      status: claimToStatusRecord(claim),
    };

    expect(claimViewToClaim(view)).toEqual(claim);

    const minimalClaim = makeClaim({ context: undefined, attemptCount: undefined });
    const minimalView: ClaimView = {
      spec: claimToSpecRecord(minimalClaim),
      status: claimToStatusRecord(minimalClaim),
    };
    const merged = claimViewToClaim(minimalView);

    expect("context" in merged).toBe(false);
    expect("attemptCount" in merged).toBe(false);
    expect(merged.revision).toBe(1);
  });
});

// Fixed clock a minute before the default leaseExpiresAt — keeps legacy
// tests deterministic without relying on the wall clock.
const claimClock = (): number => Date.parse("2026-04-23T00:04:00Z");
// Clock well after default leaseExpiresAt, for lease-expiry tests.
const pastLeaseClock = (): number => Date.parse("2026-04-23T00:10:00Z");

describe("claimToEntity", () => {
  test("wraps claimId as id, kind=Claim", () => {
    const e: ClaimEntity = claimToEntity(makeEntityClaim(), claimClock);
    expect(e.kind).toBe("Claim");
    expect(e.id).toBe("claim-1");
    expect(e.namespace).toBe("default");
  });

  test("spec carries targetRef, agent, intentSummary, context", () => {
    const e = claimToEntity(makeEntityClaim({ context: { k: "v" } }), claimClock);
    expect(e.spec.targetRef).toBe("target-x");
    expect(e.spec.intentSummary).toBe("do x");
    expect(e.spec.context).toEqual({ k: "v" });
  });

  test("claimToEntity projects split-compatible spec and status fields", () => {
    const claim = makeClaim({
      claimId: "claim-rich",
      targetRef: "target-rich",
      agent: {
        agentId: "agent-rich",
        platform: "codex",
        role: "coder",
      },
      intentSummary: "rich claim",
      context: { issue: 270 },
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:01:00.000Z",
      leaseExpiresAt: "2026-01-01T00:06:00.000Z",
      revision: 4,
    });

    const entity = claimToEntity(claim, () => Date.parse("2026-01-01T00:02:00.000Z"), "ns/test");

    expect(entity.spec.roleName).toBe("coder");
    expect(entity.spec.platform).toBe("codex");
    expect(entity.spec.assignee).toEqual(claim.agent);
    expect(entity.spec.leaseDeadlineSec).toBe(360);
    expect(entity.status.observedGeneration).toBe(4);
    expect(entity.status.lastHeartbeatAt).toBe("2026-01-01T00:01:00.000Z");
    expect(entity.status.leaseExpiresAt).toBe("2026-01-01T00:06:00.000Z");
    expect(entity.metadata.generation).toBe(4);
  });

  test("claimViewToEntity preserves split spec generation and controller status fields", () => {
    const conditions: readonly Condition[] = [
      {
        type: "Completed",
        status: "True",
        observedGeneration: 9,
        lastTransitionTime: "2026-01-01T00:05:00.000Z",
        reason: "controller",
        message: "done",
      },
    ];
    const view: ClaimView = {
      spec: {
        id: "claim-view-rich",
        roleName: "coder",
        platform: "codex",
        assignee: { agentId: "agent-view", role: "reviewer" },
        generation: 9,
        targetRef: "target-view",
        agent: { agentId: "agent-view", role: "coder", platform: "codex" },
        intentSummary: "view claim",
        context: { issue: 270 },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      status: {
        id: "claim-view-rich",
        phase: ClaimStatus.Completed,
        observedGeneration: 9,
        agentSessionId: "session-view",
        lastHeartbeatAt: "2026-01-01T00:04:00.000Z",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
        currentContributionCid:
          "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        conditions,
        lastTransitionAt: "2026-01-01T00:05:00.000Z",
        attemptCount: 3,
        revision: 4,
      },
    };

    const entity = claimViewToEntity(view, () => Date.parse("2026-01-01T00:06:00.000Z"), "ns/view");

    expect(entity.id).toBe("claim-view-rich");
    expect(entity.namespace).toBe("ns/view");
    expect(entity.metadata.generation).toBe(9);
    expect(entity.observedGeneration).toBe(9);
    expect(entity.resourceVersion).toBe("4");
    expect(entity.status.observedGeneration).toBe(9);
    expect(entity.status.agentSessionId).toBe("session-view");
    expect(entity.status.currentContributionCid).toBe(
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(entity.status.attemptCount).toBe(3);
    expect(entity.conditions).toEqual(conditions);
  });

  test("status carries phase/heartbeatAt/leaseExpiresAt/attemptCount", () => {
    const e = claimToEntity(makeEntityClaim({ attemptCount: 2 }), claimClock);
    expect(e.status.phase).toBe("active");
    expect(e.status.persistedPhase).toBe("active");
    expect(e.status.heartbeatAt).toBe("2026-04-23T00:01:00Z");
    expect(e.status.leaseExpiresAt).toBe("2026-04-23T00:05:00Z");
    expect(e.status.attemptCount).toBe(2);
  });

  test("status.phase is effective (lease-aware); persistedPhase is raw", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Active }), pastLeaseClock);
    expect(e.status.phase).toBe("expired");
    expect(e.status.persistedPhase).toBe("active");
  });

  test("attemptCount defaults to 0 when undefined on input", () => {
    const e = claimToEntity(makeEntityClaim(), claimClock);
    expect(e.status.attemptCount).toBe(0);
  });

  test("revision maps to resourceVersion + observedGeneration + metadata.generation", () => {
    const e = claimToEntity(makeEntityClaim({ revision: 7 }), claimClock);
    expect(e.resourceVersion).toBe("7");
    expect(e.observedGeneration).toBe(7);
    expect(e.metadata.generation).toBe(7);
  });

  test("missing revision → resourceVersion='0', generation=1", () => {
    const e = claimToEntity(makeEntityClaim(), claimClock);
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
  });

  test("active phase (lease fresh) → Active=True, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Active }), claimClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("True");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
    expect(m.Active?.reason).toBe("active");
    expect(m.Active?.lastTransitionTime).toBe("2026-04-23T00:01:00Z");
  });

  test("active phase but lease expired → Active=False, Expired=True, reason=lease-expired", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Active }), pastLeaseClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("True");
    expect(m.Active?.reason).toBe("lease-expired");
    expect(m.Expired?.reason).toBe("lease-expired");
  });

  test("resourceVersion changes when crossing the lease-expiry boundary", () => {
    // Same persisted claim (revision=5, phase=active), two different
    // wall clocks: one before the lease, one after. The lease-aware
    // projection must signal a version change so downstream caches
    // cannot conflate the Active and Expired snapshots.
    const claim = makeEntityClaim({ status: ClaimStatus.Active, revision: 5 });
    const fresh = claimToEntity(claim, claimClock);
    const stale = claimToEntity(claim, pastLeaseClock);
    expect(fresh.resourceVersion).toBe("5");
    expect(stale.resourceVersion).toBe("5-lease-expired");
    expect(stale.resourceVersion).not.toBe(fresh.resourceVersion);
    // observedGeneration stays pinned to the persisted revision — no
    // controller has reconciled the lease-expired view, so generation
    // tracking should not imply one did.
    expect(fresh.observedGeneration).toBe(5);
    expect(stale.observedGeneration).toBe(5);
  });

  test("lease-expired suffix does not apply to terminal phases", () => {
    const completed = claimToEntity(
      makeEntityClaim({ status: ClaimStatus.Completed, revision: 3 }),
      pastLeaseClock,
    );
    expect(completed.resourceVersion).toBe("3");
    const released = claimToEntity(
      makeEntityClaim({ status: ClaimStatus.Released, revision: 4 }),
      pastLeaseClock,
    );
    expect(released.resourceVersion).toBe("4");
  });

  test("released claim with past lease stays released (lease-gate only applies to active)", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Released }), pastLeaseClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
    expect(m.Active?.reason).toBe("released");
  });

  test("completed claim with past lease stays completed", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Completed }), pastLeaseClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Completed?.status).toBe("True");
    expect(m.Expired?.status).toBe("False");
  });

  test("expired phase → Expired=True, Active=False", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Expired }), claimClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("True");
    expect(m.Expired?.lastTransitionTime).toBe("2026-04-23T00:05:00Z");
  });

  test("completed phase → Completed=True, Active=False", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Completed }), claimClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Completed?.status).toBe("True");
    expect(m.Active?.status).toBe("False");
  });

  test("released phase → Active=False, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeEntityClaim({ status: ClaimStatus.Released }), claimClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
  });

  test("conditions observedGeneration mirrors entity observedGeneration", () => {
    const e = claimToEntity(makeEntityClaim({ revision: 3 }), claimClock);
    for (const c of e.conditions) {
      expect(c.observedGeneration).toBe(3);
    }
  });

  test("default clock uses wall-clock Date.now()", () => {
    // leaseExpiresAt year 9999 — guaranteed in the future for any wall clock
    const e = claimToEntity(
      makeEntityClaim({
        status: ClaimStatus.Active,
        leaseExpiresAt: "9999-01-01T00:00:00Z",
      }),
    );
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("True");
  });

  test("claimToEntity exposes owner refs, finalizers, and terminating condition", () => {
    const claim = makeClaim({
      ownerRef: { kind: "session", id: "s1", uid: "u1" },
      finalizers: [Finalizer.ReleaseSlots],
      deletionTimestamp: "2026-05-07T00:00:00.000Z",
    });

    const entity = claimToEntity(claim, () => Date.parse("2026-05-07T00:00:01.000Z"), "zone-a");

    expect(entity.metadata.ownerRefs).toEqual([{ kind: "session", id: "s1", uid: "u1" }]);
    expect(entity.metadata.finalizers).toEqual([Finalizer.ReleaseSlots]);
    expect(entity.metadata.deletionTimestamp).toBe("2026-05-07T00:00:00.000Z");
    expect(entity.conditions.find((c) => c.type === "Terminating")?.status).toBe("True");
  });
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "grove-coder-1-abc",
    role: "coder",
    status: "running",
    ...overrides,
  };
}

const fixedClock = () => "2026-04-23T12:00:00Z";

describe("agentSessionToEntity", () => {
  test("wraps id as id, kind=AgentSession", () => {
    const e: AgentSessionEntity = agentSessionToEntity(makeSession(), fixedClock);
    expect(e.kind).toBe("AgentSession");
    expect(e.id).toBe("grove-coder-1-abc");
    expect(e.namespace).toBe("default");
  });

  test("spec carries role/platform/model/agent", () => {
    const e = agentSessionToEntity(
      makeSession({ platform: "claude-code", model: "sonnet", agent: "claude" }),
      fixedClock,
    );
    expect(e.spec.role).toBe("coder");
    expect(e.spec.platform).toBe("claude-code");
    expect(e.spec.model).toBe("sonnet");
    expect(e.spec.agent).toBe("claude");
  });

  test("status carries phase + pid", () => {
    const e = agentSessionToEntity(makeSession({ pid: 4242 }), fixedClock);
    expect(e.status.phase).toBe("running");
    expect(e.status.pid).toBe(4242);
  });

  test("running → Ready=True, Crashed=False", () => {
    const e = agentSessionToEntity(makeSession({ status: "running" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("True");
    expect(m.Crashed?.status).toBe("False");
    expect(m.Ready?.reason).toBe("running");
  });

  test("idle → Ready=True", () => {
    const e = agentSessionToEntity(makeSession({ status: "idle" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("True");
    expect(m.Crashed?.status).toBe("False");
  });

  test("stopped → Ready=False, Crashed=False", () => {
    const e = agentSessionToEntity(makeSession({ status: "stopped" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("False");
    expect(m.Crashed?.status).toBe("False");
  });

  test("crashed → Ready=False, Crashed=True", () => {
    const e = agentSessionToEntity(makeSession({ status: "crashed" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("False");
    expect(m.Crashed?.status).toBe("True");
  });

  test("lastTransitionTime uses injected clock", () => {
    const e = agentSessionToEntity(makeSession(), fixedClock);
    for (const c of e.conditions) {
      expect(c.lastTransitionTime).toBe("2026-04-23T12:00:00Z");
    }
  });

  test("resourceVersion='0', metadata.generation=1, creationTimestamp undefined", () => {
    const e = agentSessionToEntity(makeSession(), fixedClock);
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
    expect(e.metadata.creationTimestamp).toBeUndefined();
  });

  test("default clock returns stable sentinel (no wall-clock fabrication)", () => {
    // Two back-to-back projections of the same session with no clock
    // injected MUST return identical condition timestamps. Otherwise
    // watchers/caches see phantom changes even though resourceVersion
    // (still "0") has not advanced.
    const e1 = agentSessionToEntity(makeSession());
    const e2 = agentSessionToEntity(makeSession());
    expect(e1.conditions[0]?.lastTransitionTime).toBe("");
    expect(e1.conditions[0]?.lastTransitionTime).toBe(e2.conditions[0]?.lastTransitionTime);
  });

  test("conditions observedGeneration matches entity observedGeneration (invariant)", () => {
    const e = agentSessionToEntity(makeSession(), fixedClock);
    for (const c of e.conditions) {
      expect(c.observedGeneration).toBe(0);
      expect(c.observedGeneration).toBe(e.observedGeneration);
    }
  });
});

describe("core/index exports", () => {
  test("re-exports Entity adapters and types", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.contributionToEntity).toBe("function");
    expect(typeof mod.claimToEntity).toBe("function");
    expect(typeof mod.agentSessionToEntity).toBe("function");
  });
});
