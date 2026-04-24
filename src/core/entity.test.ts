import { describe, expect, test } from "bun:test";
import type { Condition, ConditionStatus, Entity, EntityMetadata } from "./entity.js";
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode } from "./models.js";
import type { ContributionEntity } from "./entity.js";
import { contributionToEntity } from "./entity.js";
import type { Claim } from "./models.js";
import { ClaimStatus } from "./models.js";
import type { ClaimEntity } from "./entity.js";
import { claimToEntity } from "./entity.js";

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
    const e: ContributionEntity = contributionToEntity(makeContribution());
    expect(e.kind).toBe("Contribution");
    expect(e.id).toBe("cid-1");
    expect(e.namespace).toBe("default");
  });

  test("projects domain kind into spec.contributionKind", () => {
    const e = contributionToEntity(
      makeContribution({ kind: ContributionKind.Review }),
    );
    expect(e.spec.contributionKind).toBe("review");
  });

  test("status is empty object (immutable kind)", () => {
    const e = contributionToEntity(makeContribution());
    expect(e.status).toEqual({});
  });

  test("resourceVersion=0, observedGeneration=0, metadata.generation=1", () => {
    const e = contributionToEntity(makeContribution());
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
    expect(e.metadata.creationTimestamp).toBe("2026-04-23T00:00:00Z");
  });

  test("Published condition is always True with reason=Created", () => {
    const e = contributionToEntity(makeContribution());
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
    const e = contributionToEntity(c);
    expect(e.spec.summary).toBe("hello");
    expect(e.spec.description).toBe("full");
    expect(e.spec.tags).toEqual(["a", "b"]);
    expect(e.spec.commitHash).toBe("abc123");
    expect(e.spec.agent).toEqual({ agentId: "agent-1" });
    expect(e.spec.mode).toBe("evaluation");
    expect(e.spec.artifacts).toEqual({});
  });
});

function makeClaim(overrides: Partial<Claim> = {}): Claim {
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

describe("claimToEntity", () => {
  test("wraps claimId as id, kind=Claim", () => {
    const e: ClaimEntity = claimToEntity(makeClaim());
    expect(e.kind).toBe("Claim");
    expect(e.id).toBe("claim-1");
    expect(e.namespace).toBe("default");
  });

  test("spec carries targetRef, agent, intentSummary, context", () => {
    const e = claimToEntity(makeClaim({ context: { k: "v" } }));
    expect(e.spec.targetRef).toBe("target-x");
    expect(e.spec.intentSummary).toBe("do x");
    expect(e.spec.context).toEqual({ k: "v" });
  });

  test("status carries phase/heartbeatAt/leaseExpiresAt/attemptCount", () => {
    const e = claimToEntity(makeClaim({ attemptCount: 2 }));
    expect(e.status.phase).toBe("active");
    expect(e.status.heartbeatAt).toBe("2026-04-23T00:01:00Z");
    expect(e.status.leaseExpiresAt).toBe("2026-04-23T00:05:00Z");
    expect(e.status.attemptCount).toBe(2);
  });

  test("attemptCount defaults to 0 when undefined on input", () => {
    const e = claimToEntity(makeClaim());
    expect(e.status.attemptCount).toBe(0);
  });

  test("revision maps to resourceVersion + observedGeneration + metadata.generation", () => {
    const e = claimToEntity(makeClaim({ revision: 7 }));
    expect(e.resourceVersion).toBe("7");
    expect(e.observedGeneration).toBe(7);
    expect(e.metadata.generation).toBe(7);
  });

  test("missing revision → resourceVersion='0', generation=1", () => {
    const e = claimToEntity(makeClaim());
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
  });

  test("active phase → Active=True, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Active }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("True");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
    expect(m.Active?.reason).toBe("active");
    expect(m.Active?.lastTransitionTime).toBe("2026-04-23T00:01:00Z");
  });

  test("expired phase → Expired=True, Active=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Expired }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("True");
    expect(m.Expired?.lastTransitionTime).toBe("2026-04-23T00:05:00Z");
  });

  test("completed phase → Completed=True, Active=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Completed }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Completed?.status).toBe("True");
    expect(m.Active?.status).toBe("False");
  });

  test("released phase → Active=False, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Released }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
  });

  test("conditions observedGeneration mirrors entity observedGeneration", () => {
    const e = claimToEntity(makeClaim({ revision: 3 }));
    for (const c of e.conditions) {
      expect(c.observedGeneration).toBe(3);
    }
  });
});
