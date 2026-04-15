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

runHandoffStoreConformanceTests(
  "NexusHandoffStore",
  () => {
    const client = new MockNexusClient();
    return new NexusHandoffStore(client, "test-session", "default");
  },
);

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

  test("list scans all session files when no sessionId filter", async () => {
    const client = new MockNexusClient();
    // Create handoffs in two different sessions
    const store1 = new NexusHandoffStore(client, "sess-1", "default");
    const store2 = new NexusHandoffStore(client, "sess-2", "default");
    try {
      await store1.create({ sourceCid: "blake3:a", fromRole: "coder", toRole: "reviewer" });
      await store2.create({ sourceCid: "blake3:b", fromRole: "reviewer", toRole: "coder" });

      // A store should see handoffs from all sessions via readAllHandoffs
      const all = await store1.list();
      expect(all.length).toBeGreaterThanOrEqual(2);
    } finally {
      store1.close();
      store2.close();
    }
  });

  test("get falls back to scanning all files for cross-session lookups", async () => {
    const client = new MockNexusClient();
    const store1 = new NexusHandoffStore(client, "sess-1", "default");
    const store2 = new NexusHandoffStore(client, "sess-2", "default");
    try {
      const h = await store2.create({
        handoffId: "cross-session-id",
        sourceCid: "blake3:a",
        fromRole: "coder",
        toRole: "reviewer",
      });

      // store1 is scoped to sess-1 but should find sess-2's handoff via scanAll
      const found = await store1.get("cross-session-id");
      expect(found).toBeDefined();
      expect(found!.handoffId).toBe("cross-session-id");
    } finally {
      store1.close();
      store2.close();
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
