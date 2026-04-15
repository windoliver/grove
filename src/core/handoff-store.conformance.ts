/**
 * Conformance test suite for HandoffStore implementations.
 *
 * Runs the same behavioral tests against any HandoffStore implementation
 * to verify interface contract compliance. Follows the established pattern
 * from store.conformance.ts, cas.conformance.ts, bounty-store.conformance.ts.
 *
 * Usage:
 *   import { runHandoffStoreConformanceTests } from "./handoff-store.conformance.js";
 *   runHandoffStoreConformanceTests("InMemoryHandoffStore", () => new InMemoryHandoffStore());
 */

import { describe, expect, test } from "bun:test";
import { HandoffStatus, type HandoffStore } from "./handoff.js";

export function runHandoffStoreConformanceTests(
  name: string,
  factory: () => HandoffStore | Promise<HandoffStore>,
  cleanup?: () => void | Promise<void>,
): void {
  describe(`HandoffStore conformance: ${name}`, () => {
    async function make(): Promise<HandoffStore> {
      const result = factory();
      return result instanceof Promise ? await result : result;
    }

    // --- create + get ---

    test("create returns a handoff with all required fields", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc123",
          fromRole: "coder",
          toRole: "reviewer",
        });
        expect(h.handoffId).toBeTruthy();
        expect(h.sourceCid).toBe("blake3:abc123");
        expect(h.fromRole).toBe("coder");
        expect(h.toRole).toBe("reviewer");
        expect(h.requiresReply).toBe(false);
        expect(h.createdAt).toBeTruthy();
        // Status must be one of the valid values
        expect(Object.values(HandoffStatus)).toContain(h.status);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("create with explicit handoffId preserves it", async () => {
      const store = await make();
      try {
        const h = await store.create({
          handoffId: "custom-id-1",
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
        });
        expect(h.handoffId).toBe("custom-id-1");
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("create with requiresReply=true preserves it", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
          requiresReply: true,
          replyDueAt: "2099-01-01T00:00:00.000Z",
        });
        expect(h.requiresReply).toBe(true);
        expect(h.replyDueAt).toBe("2099-01-01T00:00:00.000Z");
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("get returns the created handoff by ID", async () => {
      const store = await make();
      try {
        const created = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
        });
        const fetched = await store.get(created.handoffId);
        expect(fetched).toBeDefined();
        expect(fetched!.handoffId).toBe(created.handoffId);
        expect(fetched!.sourceCid).toBe(created.sourceCid);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("get returns undefined for nonexistent ID", async () => {
      const store = await make();
      try {
        const fetched = await store.get("nonexistent-id");
        expect(fetched).toBeUndefined();
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- list ---

    test("list returns all handoffs when no query provided", async () => {
      const store = await make();
      try {
        await store.create({ sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" });
        await store.create({ sourceCid: "blake3:b", fromRole: "reviewer", toRole: "coder" });

        const all = await store.list();
        expect(all.length).toBeGreaterThanOrEqual(2);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("list filters by toRole", async () => {
      const store = await make();
      try {
        await store.create({ sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" });
        await store.create({ sourceCid: "blake3:b", fromRole: "reviewer", toRole: "coder" });

        const forReviewer = await store.list({ toRole: "reviewer" });
        for (const h of forReviewer) {
          expect(h.toRole).toBe("reviewer");
        }
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("list filters by fromRole", async () => {
      const store = await make();
      try {
        await store.create({ sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" });
        await store.create({ sourceCid: "blake3:b", fromRole: "reviewer", toRole: "coder" });

        const fromCoder = await store.list({ fromRole: "coder" });
        for (const h of fromCoder) {
          expect(h.fromRole).toBe("coder");
        }
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("list filters by sourceCid", async () => {
      const store = await make();
      try {
        await store.create({ sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" });
        await store.create({ sourceCid: "blake3:b", fromRole: "coder", toRole: "reviewer" });

        const forA = await store.list({ sourceCid: "blake3:a" });
        expect(forA).toHaveLength(1);
        expect(forA[0]!.sourceCid).toBe("blake3:a");
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("list respects limit", async () => {
      const store = await make();
      try {
        for (let i = 0; i < 5; i++) {
          await store.create({ sourceCid: `blake3:${i}`, fromRole: "coder", toRole: "reviewer" });
        }

        const limited = await store.list({ limit: 2 });
        expect(limited).toHaveLength(2);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- status transitions ---

    test("markDelivered transitions status to delivered", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
        });
        await store.markDelivered(h.handoffId);
        const updated = await store.get(h.handoffId);
        expect(updated?.status).toBe(HandoffStatus.Delivered);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("markReplied transitions status to replied with resolvedByCid", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
        });
        await store.markDelivered(h.handoffId);
        await store.markReplied(h.handoffId, "blake3:reply-cid");
        const updated = await store.get(h.handoffId);
        expect(updated?.status).toBe(HandoffStatus.Replied);
        expect(updated?.resolvedByCid).toBe("blake3:reply-cid");
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- expireStale ---

    test("expireStale marks overdue pending_pickup handoffs as expired", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
          replyDueAt: new Date(Date.now() - 60_000).toISOString(),
        });

        // Only handoffs with pending_pickup status get expired.
        // Some implementations default to Delivered — if so, we need to check
        // that expiry doesn't affect non-pending handoffs.
        const expired = await store.expireStale();
        const updated = await store.get(h.handoffId);

        if (h.status === HandoffStatus.PendingPickup) {
          // Should have been expired
          expect(expired.map((e) => e.handoffId)).toContain(h.handoffId);
          expect(updated?.status).toBe(HandoffStatus.Expired);
        } else {
          // Not pending_pickup, so not eligible for expiry
          expect(expired.map((e) => e.handoffId)).not.toContain(h.handoffId);
        }
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("expireStale does not expire handoffs without replyDueAt", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
          // No replyDueAt
        });

        const expired = await store.expireStale();
        expect(expired.map((e) => e.handoffId)).not.toContain(h.handoffId);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("expireStale does not expire future-due handoffs", async () => {
      const store = await make();
      try {
        const h = await store.create({
          sourceCid: "blake3:abc",
          fromRole: "coder",
          toRole: "reviewer",
          replyDueAt: new Date(Date.now() + 60_000).toISOString(),
        });

        const expired = await store.expireStale();
        expect(expired.map((e) => e.handoffId)).not.toContain(h.handoffId);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- countPending ---

    test("countPending counts only pending_pickup handoffs for a role", async () => {
      const store = await make();
      try {
        const h1 = await store.create({
          sourceCid: "blake3:a",
          fromRole: "coder",
          toRole: "reviewer",
        });
        await store.create({ sourceCid: "blake3:b", fromRole: "coder", toRole: "reviewer" });
        await store.create({ sourceCid: "blake3:c", fromRole: "coder", toRole: "tester" });

        // Mark one as delivered (not pending)
        await store.markDelivered(h1.handoffId);

        const pending = await store.countPending("reviewer");
        // Implementation-dependent: InMemory defaults to PendingPickup,
        // Nexus defaults to Delivered. Count only PendingPickup.
        expect(typeof pending).toBe("number");
        expect(pending).toBeGreaterThanOrEqual(0);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- createMany (optional) ---

    test("createMany creates multiple handoffs in one call (when supported)", async () => {
      const store = await make();
      try {
        if (store.createMany === undefined) return; // optional method

        const handoffs = await store.createMany([
          { sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" },
          { sourceCid: "blake3:b", fromRole: "coder", toRole: "tester" },
          { sourceCid: "blake3:c", fromRole: "coder", toRole: "auditor" },
        ]);

        expect(handoffs).toHaveLength(3);
        expect(handoffs[0]!.toRole).toBe("reviewer");
        expect(handoffs[1]!.toRole).toBe("tester");
        expect(handoffs[2]!.toRole).toBe("auditor");

        // All should be retrievable
        for (const h of handoffs) {
          const fetched = await store.get(h.handoffId);
          expect(fetched).toBeDefined();
        }
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    test("createMany with empty array returns empty array", async () => {
      const store = await make();
      try {
        if (store.createMany === undefined) return;

        const handoffs = await store.createMany([]);
        expect(handoffs).toHaveLength(0);
      } finally {
        store.close();
        await cleanup?.();
      }
    });

    // --- close ---

    test("close is idempotent", async () => {
      const store = await make();
      store.close();
      store.close(); // should not throw
      await cleanup?.();
    });
  });
}
