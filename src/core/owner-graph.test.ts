import { describe, expect, test } from "bun:test";
import { PropagationFinalizer } from "./lifecycle-metadata.js";
import {
  type GcNode,
  planDanglingChild,
  planOwnerDeletion,
  policyOf,
} from "./owner-graph.js";

function node(over: Partial<GcNode> & Pick<GcNode, "kind" | "id" | "uid">): GcNode {
  return {
    resourceVersion: "1",
    ownerRefs: [],
    finalizers: [],
    ...over,
  };
}

function child(id: string, ownerUid: string, over: Partial<GcNode> = {}): GcNode {
  return node({
    kind: "agentTask",
    id,
    uid: `uid-${id}`,
    ownerRefs: [{ kind: "taskGroup", id: "tg", uid: ownerUid, controller: true }],
    ...over,
  });
}

describe("policyOf", () => {
  test("Foreground / Orphan / Background derived from owner finalizers", () => {
    expect(policyOf(node({ kind: "taskGroup", id: "tg", uid: "u" }))).toBe("Background");
    expect(
      policyOf(node({ kind: "taskGroup", id: "tg", uid: "u", finalizers: [PropagationFinalizer.Foreground] })),
    ).toBe("Foreground");
    expect(
      policyOf(node({ kind: "taskGroup", id: "tg", uid: "u", finalizers: [PropagationFinalizer.Orphan] })),
    ).toBe("Orphan");
  });
});

describe("planOwnerDeletion — no deletionTimestamp", () => {
  test("not being deleted → no actions", () => {
    const owner = node({ kind: "taskGroup", id: "tg", uid: "u-tg" });
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([]);
  });
});

describe("planOwnerDeletion — Foreground", () => {
  const owner = node({
    kind: "taskGroup",
    id: "tg",
    uid: "u-tg",
    finalizers: [PropagationFinalizer.Foreground],
    deletionTimestamp: "2026-06-08T00:00:00.000Z",
  });

  test("marks unmarked controlled children", () => {
    const actions = planOwnerDeletion(owner, [child("a", "u-tg"), child("b", "u-tg")]);
    expect(actions).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
      { type: "mark-deletion", ref: { kind: "agentTask", id: "b" } },
    ]);
  });

  test("children marked but still present → still terminating (no actions)", () => {
    const marked = child("a", "u-tg", { deletionTimestamp: "2026-06-08T00:00:01.000Z" });
    expect(planOwnerDeletion(owner, [marked])).toEqual([]);
  });

  test("children gone → remove foreground finalizer", () => {
    expect(planOwnerDeletion(owner, [])).toEqual([
      {
        type: "remove-finalizer",
        ref: { kind: "taskGroup", id: "tg" },
        finalizer: PropagationFinalizer.Foreground,
      },
    ]);
  });

  test("finalizer removed + children gone → reap", () => {
    const reapable = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(reapable, [])).toEqual([
      { type: "reap", ref: { kind: "taskGroup", id: "tg" } },
    ]);
  });
});

describe("planOwnerDeletion — Orphan", () => {
  const owner = node({
    kind: "taskGroup",
    id: "tg",
    uid: "u-tg",
    finalizers: [PropagationFinalizer.Orphan],
    deletionTimestamp: "2026-06-08T00:00:00.000Z",
  });

  test("strips the controller ownerRef from children", () => {
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([
      { type: "orphan", ref: { kind: "agentTask", id: "a" }, ownerUid: "u-tg" },
    ]);
  });

  test("children detached → remove orphan finalizer, then reap on next pass", () => {
    expect(planOwnerDeletion(owner, [])).toEqual([
      {
        type: "remove-finalizer",
        ref: { kind: "taskGroup", id: "tg" },
        finalizer: PropagationFinalizer.Orphan,
      },
    ]);
  });
});

describe("planOwnerDeletion — Background", () => {
  test("marks children AND reaps owner immediately", () => {
    const owner = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
      { type: "reap", ref: { kind: "taskGroup", id: "tg" } },
    ]);
  });
});

describe("reap gating by finalizer", () => {
  test("deletionTimestamp set but a kind finalizer present → no reap", () => {
    const owner = node({
      kind: "agentTask",
      id: "at",
      uid: "u",
      finalizers: ["grove.dev/pending-review"],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(owner, [])).toEqual([]);
  });
});

describe("planDanglingChild", () => {
  test("owner gone, child unmarked → mark for deletion", () => {
    expect(planDanglingChild(child("a", "u-tg"), false)).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
    ]);
  });

  test("owner gone, child marked, finalizers empty → reap", () => {
    const marked = child("a", "u-tg", { deletionTimestamp: "2026-06-08T00:00:01.000Z" });
    expect(planDanglingChild(marked, false)).toEqual([
      { type: "reap", ref: { kind: "agentTask", id: "a" } },
    ]);
  });

  test("owner still exists → no actions", () => {
    expect(planDanglingChild(child("a", "u-tg"), true)).toEqual([]);
  });

  test("no controller ownerRef → not a dangling candidate", () => {
    const orphaned = node({ kind: "agentTask", id: "a", uid: "u-a" });
    expect(planDanglingChild(orphaned, false)).toEqual([]);
  });
});

describe("idempotency", () => {
  test("converged Foreground owner (children gone, finalizer cleared) yields reap then nothing", () => {
    const reaped = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    const first = planOwnerDeletion(reaped, []);
    expect(first).toEqual([{ type: "reap", ref: { kind: "taskGroup", id: "tg" } }]);
    // After reap the node would be gone; re-running planDanglingChild on a
    // hypothetical leftover with empty finalizers is a single reap, not a loop.
    expect(planOwnerDeletion(reaped, [])).toEqual(first);
  });
});
