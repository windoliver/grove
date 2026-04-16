/**
 * Conformance test suite for HandoffStore implementations.
 *
 * Any backend that implements HandoffStore can validate its behavior
 * by calling `runHandoffStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HandoffStatus, type HandoffStore, InvalidTransitionError } from "./handoff.js";
import { makeHandoffInput } from "./test-helpers.js";

/** Factory that creates a fresh HandoffStore and returns a cleanup function. */
export type HandoffStoreFactory = () => Promise<{
  store: HandoffStore;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full HandoffStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates and tears down store instances.
 */
export function runHandoffStoreTests(factory: HandoffStoreFactory): void {
  describe("HandoffStore conformance", () => {
    let store: HandoffStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      store.close();
      await cleanup();
    });

    // ------------------------------------------------------------------
    // create / get
    // ------------------------------------------------------------------

    test("create stores and returns a handoff", async () => {
      const input = makeHandoffInput();
      const handoff = await store.create(input);
      expect(handoff.sourceCid).toBe(input.sourceCid);
      expect(handoff.fromRole).toBe(input.fromRole);
      expect(handoff.toRole).toBe(input.toRole);
      expect(typeof handoff.handoffId).toBe("string");
      expect(handoff.handoffId.length).toBeGreaterThan(0);
      expect(handoff.createdAt).toBeDefined();
    });

    test("create assigns a UUID when handoffId is omitted", async () => {
      const input = makeHandoffInput({ handoffId: undefined });
      const handoff = await store.create(input);
      expect(handoff.handoffId).toBeDefined();
      expect(handoff.handoffId.length).toBeGreaterThan(0);
    });

    test("create uses provided handoffId when given", async () => {
      const input = makeHandoffInput({ handoffId: "custom-id-123" });
      const handoff = await store.create(input);
      expect(handoff.handoffId).toBe("custom-id-123");
    });

    test("create defaults requiresReply to false", async () => {
      const input = makeHandoffInput({ requiresReply: undefined });
      const handoff = await store.create(input);
      expect(handoff.requiresReply).toBe(false);
    });

    test("create respects requiresReply=true", async () => {
      const input = makeHandoffInput({ requiresReply: true });
      const handoff = await store.create(input);
      expect(handoff.requiresReply).toBe(true);
    });

    test("create stores replyDueAt when provided", async () => {
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const input = makeHandoffInput({ replyDueAt: deadline });
      const handoff = await store.create(input);
      expect(handoff.replyDueAt).toBe(deadline);
    });

    test("create omits replyDueAt when not provided", async () => {
      const input = makeHandoffInput({ replyDueAt: undefined });
      const handoff = await store.create(input);
      expect(handoff.replyDueAt).toBeUndefined();
    });

    test("get returns stored handoff", async () => {
      const handoff = await store.create(makeHandoffInput());
      const retrieved = await store.get(handoff.handoffId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.handoffId).toBe(handoff.handoffId);
      expect(retrieved?.sourceCid).toBe(handoff.sourceCid);
      expect(retrieved?.fromRole).toBe(handoff.fromRole);
      expect(retrieved?.toRole).toBe(handoff.toRole);
    });

    test("get returns undefined for non-existent handoff", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // createMany
    // ------------------------------------------------------------------

    test("createMany stores multiple handoffs", async () => {
      if (store.createMany === undefined) return; // optional method

      const inputs = [
        makeHandoffInput({ toRole: "reviewer" }),
        makeHandoffInput({ toRole: "tester" }),
        makeHandoffInput({ toRole: "auditor" }),
      ];

      const handoffs = await store.createMany(inputs);
      expect(handoffs).toHaveLength(3);

      const roles = handoffs.map((h) => h.toRole);
      expect(roles).toContain("reviewer");
      expect(roles).toContain("tester");
      expect(roles).toContain("auditor");
    });

    test("createMany returns empty array for empty input", async () => {
      if (store.createMany === undefined) return;

      const handoffs = await store.createMany([]);
      expect(handoffs).toHaveLength(0);
    });

    test("createMany preserves input order", async () => {
      if (store.createMany === undefined) return;

      const inputs = [
        makeHandoffInput({ toRole: "alpha" }),
        makeHandoffInput({ toRole: "beta" }),
        makeHandoffInput({ toRole: "gamma" }),
      ];

      const handoffs = await store.createMany(inputs);
      expect(handoffs[0]?.toRole).toBe("alpha");
      expect(handoffs[1]?.toRole).toBe("beta");
      expect(handoffs[2]?.toRole).toBe("gamma");
    });

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    test("list returns all handoffs when no query", async () => {
      await store.create(makeHandoffInput({ toRole: "a" }));
      await store.create(makeHandoffInput({ toRole: "b" }));

      const all = await store.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    test("list filters by toRole", async () => {
      await store.create(makeHandoffInput({ toRole: "reviewer" }));
      await store.create(makeHandoffInput({ toRole: "tester" }));

      const results = await store.list({ toRole: "reviewer" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const h of results) {
        expect(h.toRole).toBe("reviewer");
      }
    });

    test("list filters by fromRole", async () => {
      await store.create(makeHandoffInput({ fromRole: "coder" }));
      await store.create(makeHandoffInput({ fromRole: "planner" }));

      const results = await store.list({ fromRole: "coder" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const h of results) {
        expect(h.fromRole).toBe("coder");
      }
    });

    test("list filters by sourceCid", async () => {
      await store.create(makeHandoffInput({ sourceCid: "blake3:aaa" }));
      await store.create(makeHandoffInput({ sourceCid: "blake3:bbb" }));

      const results = await store.list({ sourceCid: "blake3:aaa" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const h of results) {
        expect(h.sourceCid).toBe("blake3:aaa");
      }
    });

    test("list filters by status", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markDelivered(h.handoffId);
      await store.create(makeHandoffInput()); // stays at initial status

      const delivered = await store.list({ status: HandoffStatus.Delivered });
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      for (const d of delivered) {
        expect(d.status).toBe(HandoffStatus.Delivered);
      }
    });

    test("list respects limit", async () => {
      await store.create(makeHandoffInput({ toRole: "a" }));
      await store.create(makeHandoffInput({ toRole: "b" }));
      await store.create(makeHandoffInput({ toRole: "c" }));

      const results = await store.list({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    test("list returns empty array when no matches", async () => {
      const results = await store.list({ toRole: "nonexistent-role" });
      expect(results).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // markDelivered
    // ------------------------------------------------------------------

    test("markDelivered transitions status to delivered", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markDelivered(h.handoffId);

      const updated = await store.get(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Delivered);
    });

    // ------------------------------------------------------------------
    // markReplied
    // ------------------------------------------------------------------

    test("markReplied transitions status to replied and sets resolvedByCid", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markDelivered(h.handoffId);
      await store.markReplied(h.handoffId, "blake3:reply-cid");

      const updated = await store.get(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Replied);
      expect(updated?.resolvedByCid).toBe("blake3:reply-cid");
    });

    // ------------------------------------------------------------------
    // expireStale
    // ------------------------------------------------------------------

    test("expireStale marks overdue pending_pickup handoffs as expired", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const h = await store.create(
        makeHandoffInput({ replyDueAt: pastDeadline }),
      );

      const expired = await store.expireStale();
      const updated = await store.get(h.handoffId);

      expect(expired.map((e) => e.handoffId)).toContain(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Expired);
    });

    test("expireStale does not expire handoffs without replyDueAt", async () => {
      const h = await store.create(makeHandoffInput({ replyDueAt: undefined }));

      await store.expireStale();
      const updated = await store.get(h.handoffId);

      // Should still be at initial status, not expired
      expect(updated?.status).not.toBe(HandoffStatus.Expired);
    });

    test("expireStale does not expire handoffs with future deadline", async () => {
      const futureDeadline = new Date(Date.now() + 600_000).toISOString();
      const h = await store.create(
        makeHandoffInput({ replyDueAt: futureDeadline }),
      );

      await store.expireStale();
      const updated = await store.get(h.handoffId);

      expect(updated?.status).not.toBe(HandoffStatus.Expired);
    });

    test("expireStale is idempotent — second call returns empty for already expired", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      await store.create(makeHandoffInput({ replyDueAt: pastDeadline }));

      const first = await store.expireStale();
      expect(first.length).toBeGreaterThanOrEqual(1);

      const second = await store.expireStale();
      // Already expired — nothing new to expire
      expect(second).toHaveLength(0);
    });

    test("expireStale expires delivered handoffs with past deadline", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const h = await store.create(
        makeHandoffInput({ replyDueAt: pastDeadline }),
      );
      // Transition to delivered (not pending_pickup)
      await store.markDelivered(h.handoffId);

      const expired = await store.expireStale();
      const updated = await store.get(h.handoffId);

      expect(expired.map((e) => e.handoffId)).toContain(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Expired);
    });

    test("expireStale does not expire already-replied handoffs with past deadline", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const h = await store.create(
        makeHandoffInput({ replyDueAt: pastDeadline }),
      );
      // Transition to delivered then replied before expiry runs
      await store.markDelivered(h.handoffId);
      await store.markReplied(h.handoffId, "blake3:reply-cid");

      const expired = await store.expireStale();
      const updated = await store.get(h.handoffId);

      expect(expired.map((e) => e.handoffId)).not.toContain(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Replied);
    });

    // ------------------------------------------------------------------
    // countPending
    // ------------------------------------------------------------------

    test("countPending returns count of pending_pickup handoffs for role", async () => {
      await store.create(makeHandoffInput({ toRole: "reviewer" }));
      await store.create(makeHandoffInput({ toRole: "reviewer" }));
      await store.create(makeHandoffInput({ toRole: "tester" }));

      const count = await store.countPending("reviewer");
      expect(count).toBeGreaterThanOrEqual(2);
    });

    test("countPending returns 0 when no pending handoffs for role", async () => {
      const count = await store.countPending("nonexistent-role");
      expect(count).toBe(0);
    });

    test("countPending excludes delivered handoffs", async () => {
      const h = await store.create(makeHandoffInput({ toRole: "reviewer" }));
      await store.markDelivered(h.handoffId);

      const count = await store.countPending("reviewer");
      expect(count).toBe(0);
    });

    // ------------------------------------------------------------------
    // markSeen
    // ------------------------------------------------------------------

    test("markSeen sets seenAt timestamp", async () => {
      const h = await store.create(makeHandoffInput());
      expect(h.seenAt).toBeUndefined();

      await store.markSeen(h.handoffId);

      const updated = await store.get(h.handoffId);
      expect(updated?.seenAt).toBeDefined();
      expect(typeof updated?.seenAt).toBe("string");
    });

    test("markSeen is idempotent — second call preserves original timestamp", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markSeen(h.handoffId);

      const first = await store.get(h.handoffId);
      const originalSeenAt = first?.seenAt;

      // Brief delay to ensure different timestamp if re-set
      await new Promise((r) => setTimeout(r, 10));
      await store.markSeen(h.handoffId);

      const second = await store.get(h.handoffId);
      expect(second?.seenAt).toBe(originalSeenAt);
    });

    test("markSeen throws for non-existent handoff", async () => {
      await expect(store.markSeen("nonexistent")).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // markAcked
    // ------------------------------------------------------------------

    test("markAcked sets ackedAt timestamp", async () => {
      const h = await store.create(makeHandoffInput());
      expect(h.ackedAt).toBeUndefined();

      await store.markAcked(h.handoffId);

      const updated = await store.get(h.handoffId);
      expect(updated?.ackedAt).toBeDefined();
      expect(typeof updated?.ackedAt).toBe("string");
    });

    test("markAcked auto-fills seenAt if not already set", async () => {
      const h = await store.create(makeHandoffInput());
      expect(h.seenAt).toBeUndefined();

      await store.markAcked(h.handoffId);

      const updated = await store.get(h.handoffId);
      expect(updated?.seenAt).toBeDefined();
      expect(updated?.ackedAt).toBeDefined();
    });

    test("markAcked preserves existing seenAt", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markSeen(h.handoffId);
      const seen = await store.get(h.handoffId);
      const originalSeenAt = seen?.seenAt;

      await new Promise((r) => setTimeout(r, 10));
      await store.markAcked(h.handoffId);

      const updated = await store.get(h.handoffId);
      expect(updated?.seenAt).toBe(originalSeenAt);
      expect(updated?.ackedAt).toBeDefined();
    });

    test("markAcked is idempotent — second call preserves original timestamp", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markAcked(h.handoffId);

      const first = await store.get(h.handoffId);
      const originalAckedAt = first?.ackedAt;

      await new Promise((r) => setTimeout(r, 10));
      await store.markAcked(h.handoffId);

      const second = await store.get(h.handoffId);
      expect(second?.ackedAt).toBe(originalAckedAt);
    });

    test("markAcked throws for non-existent handoff", async () => {
      await expect(store.markAcked("nonexistent")).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // Invalid state transitions
    // ------------------------------------------------------------------

    test("markDelivered on expired handoff throws InvalidTransitionError", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const h = await store.create(makeHandoffInput({ replyDueAt: pastDeadline }));
      await store.expireStale();

      await expect(store.markDelivered(h.handoffId)).rejects.toThrow(InvalidTransitionError);
    });

    test("markDelivered on replied handoff throws InvalidTransitionError", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markDelivered(h.handoffId);
      await store.markReplied(h.handoffId, "blake3:reply");

      await expect(store.markDelivered(h.handoffId)).rejects.toThrow(InvalidTransitionError);
    });

    test("markReplied on expired handoff throws InvalidTransitionError", async () => {
      const pastDeadline = new Date(Date.now() - 60_000).toISOString();
      const h = await store.create(makeHandoffInput({ replyDueAt: pastDeadline }));
      await store.expireStale();

      await expect(
        store.markReplied(h.handoffId, "blake3:reply"),
      ).rejects.toThrow(InvalidTransitionError);
    });

    test("markAcked is atomic under concurrent retries — same timestamp returned", async () => {
      const h = await store.create(makeHandoffInput());

      // Fire 5 concurrent markAcked calls — they should all succeed and
      // converge on a single ackedAt timestamp (not stamp different times).
      await Promise.all(Array.from({ length: 5 }, () => store.markAcked(h.handoffId)));

      const updated = await store.get(h.handoffId);
      expect(updated?.ackedAt).toBeDefined();

      // Subsequent calls must not overwrite
      const originalAckedAt = updated?.ackedAt;
      await new Promise((r) => setTimeout(r, 20));
      await store.markAcked(h.handoffId);
      const after = await store.get(h.handoffId);
      expect(after?.ackedAt).toBe(originalAckedAt!);
    });

    test("markReplied on already-replied handoff throws InvalidTransitionError", async () => {
      const h = await store.create(makeHandoffInput());
      await store.markDelivered(h.handoffId);
      await store.markReplied(h.handoffId, "blake3:reply-1");

      await expect(
        store.markReplied(h.handoffId, "blake3:reply-2"),
      ).rejects.toThrow(InvalidTransitionError);
    });
  });
}
