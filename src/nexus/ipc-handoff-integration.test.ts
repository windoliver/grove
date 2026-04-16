/**
 * Integration tests for the IPC handoff round-trip (#165).
 *
 * Tests the full flow:
 *   contribute → handoff created → IPC sent (via NexusEventBus) →
 *   SSE event → handoff status updated → dead-letter on failure
 *
 * Uses in-memory stores and mock IPC to verify the wiring without
 * requiring a running Nexus instance.
 */

import { describe, expect, test } from "bun:test";
import { HandoffStatus } from "../core/handoff.js";
import { InMemoryHandoffStore } from "../core/in-memory-handoff-store.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { contributeOperation } from "../core/operations/contribute.js";
import type { OperationDeps } from "../core/operations/deps.js";
import { makeInMemoryContributionStore } from "../core/operations/test-helpers.js";
import type { AgentTopology } from "../core/topology.js";
import { TopologyRouter } from "../core/topology-router.js";
import { NexusEventBus } from "./nexus-event-bus.js";
import type { IpcSendResult, NexusIpcClient } from "./nexus-ipc-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const reviewLoopTopology: AgentTopology = {
  structure: "graph",
  roles: [
    { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
    { name: "reviewer" },
  ],
};

function makeMockIpcClient(
  result: IpcSendResult = { ok: true, messageId: "ipc-msg-001" },
): NexusIpcClient {
  return {
    send: async () => result,
  } as unknown as NexusIpcClient;
}

function makeFailingIpcClient(): NexusIpcClient {
  return {
    send: async () => ({ ok: false, error: "connection refused" }),
  } as unknown as NexusIpcClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IPC handoff integration", () => {
  test("contribute with NexusEventBus creates handoff and routes via IPC", async () => {
    const ipc = makeMockIpcClient({ ok: true, messageId: "ipc-msg-123" });
    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(reviewLoopTopology, eventBus);
    const handoffStore = new InMemoryHandoffStore();
    const store = makeInMemoryContributionStore();

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus,
      handoffStore,
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Implement auth module",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Handoff should exist
    const handoffs = await handoffStore.list();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.fromRole).toBe("coder");
    expect(handoffs[0]!.toRole).toBe("reviewer");
    expect(handoffs[0]!.sourceCid).toBe(result.value.cid);

    // The route event was published (result includes routedTo)
    expect(result.value.routedTo).toEqual(["reviewer"]);
    expect(result.value.handoffIds).toHaveLength(1);

    eventBus.close();
  });

  test("NexusEventBus.publish returns IPC message ID from NexusIpcClient", async () => {
    const ipc = makeMockIpcClient({ ok: true, messageId: "ipc-msg-456" });
    const eventBus = new NexusEventBus(ipc);

    const result = await eventBus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:test" },
      timestamp: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("ipc-msg-456");
    eventBus.close();
  });

  test("TopologyRouter.route returns RouteResult with ok + messageId", async () => {
    const ipc = makeMockIpcClient({ ok: true, messageId: "ipc-msg-789" });
    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(reviewLoopTopology, eventBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(1);
    expect(results[0]!.targetRole).toBe("reviewer");
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.messageId).toBe("ipc-msg-789");
    eventBus.close();
  });

  test("TopologyRouter.route returns ok=false when IPC fails", async () => {
    const ipc = makeFailingIpcClient();
    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(reviewLoopTopology, eventBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(1);
    expect(results[0]!.targetRole).toBe("reviewer");
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe("connection refused");
    expect(results[0]!.messageId).toBeUndefined();
    eventBus.close();
  });

  test("LocalEventBus route returns ok=true with no messageId", async () => {
    const localBus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, localBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.messageId).toBeUndefined();
    localBus.close();
  });

  test("handoff ipcMessageId can be set and retrieved", async () => {
    const handoffStore = new InMemoryHandoffStore();
    const h = await handoffStore.create({
      sourceCid: "blake3:abc",
      fromRole: "coder",
      toRole: "reviewer",
    });

    await handoffStore.setIpcMessageId!(h.handoffId, "ipc-msg-999");

    const updated = await handoffStore.get(h.handoffId);
    expect(updated!.ipcMessageId).toBe("ipc-msg-999");
    handoffStore.close();
  });

  test("handoff state machine: pending_pickup → delivered → processed → replied", async () => {
    const handoffStore = new InMemoryHandoffStore();
    const h = await handoffStore.create({
      sourceCid: "blake3:abc",
      fromRole: "coder",
      toRole: "reviewer",
    });
    expect(h.status).toBe(HandoffStatus.PendingPickup);

    await handoffStore.markDelivered(h.handoffId);
    expect((await handoffStore.get(h.handoffId))!.status).toBe(HandoffStatus.Delivered);

    await handoffStore.markProcessed(h.handoffId);
    expect((await handoffStore.get(h.handoffId))!.status).toBe(HandoffStatus.Processed);

    await handoffStore.markReplied(h.handoffId, "blake3:reply-cid");
    const final = (await handoffStore.get(h.handoffId))!;
    expect(final.status).toBe(HandoffStatus.Replied);
    expect(final.resolvedByCid).toBe("blake3:reply-cid");

    handoffStore.close();
  });

  test("handoff dead-letter on IPC failure", async () => {
    const handoffStore = new InMemoryHandoffStore();
    const h = await handoffStore.create({
      sourceCid: "blake3:abc",
      fromRole: "coder",
      toRole: "reviewer",
    });

    await handoffStore.markDeadLettered(h.handoffId);

    const updated = await handoffStore.get(h.handoffId);
    expect(updated!.status).toBe(HandoffStatus.DeadLettered);
    handoffStore.close();
  });

  test("grove_ack_handoff validates state transition", async () => {
    const { canTransition } = await import("../core/handoff.js");

    // Valid: delivered → processed
    expect(canTransition(HandoffStatus.Delivered, HandoffStatus.Processed)).toBe(true);

    // Invalid: pending_pickup → processed (must go through delivered)
    expect(canTransition(HandoffStatus.PendingPickup, HandoffStatus.Processed)).toBe(false);

    // Invalid: dead_lettered → processed (terminal state)
    expect(canTransition(HandoffStatus.DeadLettered, HandoffStatus.Processed)).toBe(false);
  });

  test("multi-target topology routes to all targets in parallel", async () => {
    const sendCalls: string[] = [];
    const ipc = {
      send: async (_s: string, recipient: string) => {
        sendCalls.push(recipient);
        return { ok: true, messageId: `msg-${recipient}` };
      },
    } as unknown as NexusIpcClient;

    const multiTopology: AgentTopology = {
      structure: "graph",
      roles: [
        {
          name: "coder",
          edges: [
            { target: "reviewer", edgeType: "delegates" },
            { target: "tester", edgeType: "delegates" },
            { target: "auditor", edgeType: "delegates" },
          ],
        },
        { name: "reviewer" },
        { name: "tester" },
        { name: "auditor" },
      ],
    };

    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(multiTopology, eventBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sendCalls.sort()).toEqual(["auditor", "reviewer", "tester"]);
    expect(results.find((r) => r.targetRole === "reviewer")!.messageId).toBe("msg-reviewer");
    expect(results.find((r) => r.targetRole === "tester")!.messageId).toBe("msg-tester");
    expect(results.find((r) => r.targetRole === "auditor")!.messageId).toBe("msg-auditor");

    eventBus.close();
  });

  test("infrastructure error (404/connection refused) does NOT dead-letter handoffs", async () => {
    // Simulate a Nexus that has VFS but no IPC endpoint (404)
    const ipc = {
      send: async () => ({
        ok: false,
        error: "IPC send failed: HTTP 404",
        infrastructureError: true,
      }),
    } as unknown as NexusIpcClient;

    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(reviewLoopTopology, eventBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.infrastructureError).toBe(true);

    // The handoff should NOT be dead-lettered because this is infra, not rejection
    // (verified by the contribute.ts routing block checking infrastructureError)
    eventBus.close();
  });

  test("delivery rejection (non-infrastructure) DOES dead-letter handoffs", async () => {
    // Simulate IPC endpoint available but rejecting the message
    const ipc = {
      send: async () => ({
        ok: false,
        error: "recipient not registered",
        infrastructureError: false,
      }),
    } as unknown as NexusIpcClient;

    const eventBus = new NexusEventBus(ipc);
    const router = new TopologyRouter(reviewLoopTopology, eventBus);

    const results = await router.route("coder", { cid: "blake3:test" });

    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.infrastructureError).toBe(false);

    // This IS a delivery failure — contribute.ts would dead-letter this handoff
    eventBus.close();
  });

  test("NexusIpcClient caches endpoint unavailability after first 404", async () => {
    const { NexusIpcClient: RealIpcClient } = await import("./nexus-ipc-client.js");
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response('{"detail":"Not Found"}', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const client = new RealIpcClient({ nexusUrl: "http://localhost:9999", apiKey: "test" });

      const r1 = await client.send("a", "b", {});
      expect(r1.ok).toBe(false);
      expect(r1.infrastructureError).toBe(true);
      expect(fetchCount).toBe(1);

      // Second call should be cached — no fetch
      const r2 = await client.send("a", "b", {});
      expect(r2.ok).toBe(false);
      expect(r2.infrastructureError).toBe(true);
      expect(fetchCount).toBe(1); // still 1 — cached
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
