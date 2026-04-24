import { describe, expect, test } from "bun:test";
import type { Condition, ConditionStatus, Entity, EntityMetadata } from "./entity.js";
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode } from "./models.js";
import type { ContributionEntity } from "./entity.js";
import { contributionToEntity } from "./entity.js";

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
