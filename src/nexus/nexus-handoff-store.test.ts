/**
 * Run HandoffStore conformance tests against NexusHandoffStore,
 * plus Nexus-specific tests for VFS behavior.
 */

import { describe, expect, test } from "bun:test";
import { HandoffStatus } from "../core/handoff.js";
import { runHandoffStoreConformanceTests } from "../core/handoff-store.conformance.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusHandoffStore } from "./nexus-handoff-store.js";

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

runHandoffStoreConformanceTests("NexusHandoffStore", () => {
  const client = new MockNexusClient();
  return new NexusHandoffStore(client, "test-session", "default");
});

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("NexusHandoffStore: Nexus-specific behavior", () => {
  test("created handoffs default to Delivered status (not PendingPickup)", async () => {
    const client = new MockNexusClient();
    const store = new NexusHandoffStore(client, "sess-1", "default");
    try {
      const h = await store.create({
        sourceCid: "blake3:abc",
        fromRole: "coder",
        toRole: "reviewer",
      });
      // NexusHandoffStore intentionally defaults to Delivered
      expect(h.status).toBe(HandoffStatus.Delivered);
    } finally {
      store.close();
    }
  });

  test("createMany is idempotent — duplicate handoffIds are skipped", async () => {
    const client = new MockNexusClient();
    const store = new NexusHandoffStore(client, "sess-1", "default");
    try {
      const results1 = await store.createMany([
        { handoffId: "h-1", sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" },
        { handoffId: "h-2", sourceCid: "blake3:b", fromRole: "coder", toRole: "tester" },
      ]);
      expect(results1).toHaveLength(2);

      // Write the same IDs again
      const results2 = await store.createMany([
        { handoffId: "h-1", sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" },
        { handoffId: "h-3", sourceCid: "blake3:c", fromRole: "coder", toRole: "auditor" },
      ]);
      expect(results2).toHaveLength(2);

      // Total should be 3 (h-1 deduped, h-2 from first, h-3 from second)
      const all = await store.list();
      expect(all).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  test("scoped list does NOT leak peer sessions' handoffs", async () => {
    const client = new MockNexusClient();
    // Create handoffs in two different sessions
    const store1 = new NexusHandoffStore(client, "sess-1", "default");
    const store2 = new NexusHandoffStore(client, "sess-2", "default");
    try {
      const h1 = await store1.create({
        sourceCid: "blake3:a",
        fromRole: "coder",
        toRole: "reviewer",
      });
      const h2 = await store2.create({
        sourceCid: "blake3:b",
        fromRole: "reviewer",
        toRole: "coder",
      });

      // store1 must only see its own handoff
      const listed1 = await store1.list();
      expect(listed1.map((h) => h.handoffId)).toEqual([h1.handoffId]);
      // store2 must only see its own handoff
      const listed2 = await store2.list();
      expect(listed2.map((h) => h.handoffId)).toEqual([h2.handoffId]);

      // Unscoped store (CLI/admin) walks the whole dir and sees both
      const admin = new NexusHandoffStore(client, undefined, "default");
      const all = await admin.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
      admin.close();
    } finally {
      store1.close();
      store2.close();
    }
  });

  test("scoped get does NOT leak peer sessions' handoffs", async () => {
    const client = new MockNexusClient();
    const store1 = new NexusHandoffStore(client, "sess-1", "default");
    const store2 = new NexusHandoffStore(client, "sess-2", "default");
    try {
      await store2.create({
        handoffId: "cross-session-id",
        sourceCid: "blake3:a",
        fromRole: "coder",
        toRole: "reviewer",
      });

      // store1 must NOT find store2's handoff — cross-session reads are rejected
      const found = await store1.get("cross-session-id");
      expect(found).toBeUndefined();

      // Unscoped admin store still resolves across sessions
      const admin = new NexusHandoffStore(client, undefined, "default");
      const adminFound = await admin.get("cross-session-id");
      expect(adminFound).toBeDefined();
      admin.close();
    } finally {
      store1.close();
      store2.close();
    }
  });

  test("scoped list includes pre-#164 _global migration rows", async () => {
    const client = new MockNexusClient();
    const legacy = new NexusHandoffStore(client, undefined, "default");
    const scoped = new NexusHandoffStore(client, "new-session", "default");
    try {
      const hLegacy = await legacy.create({
        sourceCid: "blake3:legacy",
        fromRole: "coder",
        toRole: "reviewer",
      });

      const listed = await scoped.list();
      expect(listed.find((h) => h.handoffId === hLegacy.handoffId)).toBeDefined();
      const got = await scoped.get(hLegacy.handoffId);
      expect(got?.handoffId).toBe(hLegacy.handoffId);
    } finally {
      legacy.close();
      scoped.close();
    }
  });

  test("store without sessionId uses _global.json", async () => {
    const client = new MockNexusClient();
    const store = new NexusHandoffStore(client, undefined, "default");
    try {
      const h = await store.create({
        sourceCid: "blake3:abc",
        fromRole: "coder",
        toRole: "reviewer",
      });

      const fetched = await store.get(h.handoffId);
      expect(fetched).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("markDelivered updates handoff in VFS file", async () => {
    const client = new MockNexusClient();
    const store = new NexusHandoffStore(client, "sess-1", "default");
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
    }
  });

  test("markReplied updates handoff with resolvedByCid in VFS file", async () => {
    const client = new MockNexusClient();
    const store = new NexusHandoffStore(client, "sess-1", "default");
    try {
      const h = await store.create({
        sourceCid: "blake3:abc",
        fromRole: "coder",
        toRole: "reviewer",
      });

      await store.markReplied(h.handoffId, "blake3:reply");
      const updated = await store.get(h.handoffId);
      expect(updated?.status).toBe(HandoffStatus.Replied);
      expect(updated?.resolvedByCid).toBe("blake3:reply");
    } finally {
      store.close();
    }
  });
});
