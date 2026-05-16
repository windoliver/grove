import { describe, expect, test } from "bun:test";
import { createApprovalQueue } from "./approval-queue.js";
import type { PendingApproval } from "./types.js";

function ap(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    agentId: over.agentId ?? "a-1",
    requestId: over.requestId ?? `r-${Math.random().toString(36).slice(2, 6)}`,
    kind: "tmux-permission",
    prompt: "x",
    fullBody: "x",
    requestedAt: over.requestedAt ?? Date.now(),
    ...over,
  };
}

describe("ApprovalQueue", () => {
  test("FIFO ordering by requestedAt", () => {
    let resolved = false;
    const accept = async () => { resolved = true; };
    const reject = async () => {};
    const q = createApprovalQueue(
      [ap({ requestId: "B", requestedAt: 200 }), ap({ requestId: "A", requestedAt: 100 })],
      { accept, reject },
    );
    expect(q.head?.requestId).toBe("A");
    expect(q.pending.map((p) => p.requestId)).toEqual(["A", "B"]);
    expect(resolved).toBe(false);
  });

  test("deduplicates by (agentId, requestId)", () => {
    const q = createApprovalQueue(
      [
        ap({ agentId: "x", requestId: "r", requestedAt: 100 }),
        ap({ agentId: "x", requestId: "r", requestedAt: 200 }),
        ap({ agentId: "y", requestId: "r", requestedAt: 50 }),
      ],
      { accept: async () => {}, reject: async () => {} },
    );
    expect(q.pending).toHaveLength(2);
  });

  test("forAgent returns the pending approval for that agent if any", () => {
    const q = createApprovalQueue(
      [ap({ agentId: "x", requestId: "r" }), ap({ agentId: "y", requestId: "s" })],
      { accept: async () => {}, reject: async () => {} },
    );
    expect(q.forAgent("x")?.requestId).toBe("r");
    expect(q.forAgent("z")).toBeUndefined();
  });

  test("accept delegates to provided fn with requestId", async () => {
    let called: string | undefined;
    const q = createApprovalQueue(
      [ap({ requestId: "alpha" })],
      { accept: async (id) => { called = id; }, reject: async () => {} },
    );
    await q.accept("alpha");
    expect(called).toBe("alpha");
  });

  test("reject delegates similarly", async () => {
    let called: string | undefined;
    const q = createApprovalQueue(
      [ap({ requestId: "beta" })],
      { accept: async () => {}, reject: async (id) => { called = id; } },
    );
    await q.reject("beta");
    expect(called).toBe("beta");
  });

  test("accept of unknown requestId throws (caller can surface as toast)", async () => {
    const q = createApprovalQueue([], { accept: async () => {}, reject: async () => {} });
    await expect(q.accept("nope")).rejects.toThrow(/unknown approval/i);
  });
});
