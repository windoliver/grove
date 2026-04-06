import { describe, expect, test } from "bun:test";
import { HandoffStatus } from "../handoff.js";
import { InMemoryHandoffStore } from "../in-memory-handoff-store.js";
import { LocalEventBus } from "../local-event-bus.js";
import { TopologyRouter } from "../topology-router.js";
import { contributeOperation } from "./contribute.js";
import { createTestOperationDeps } from "./test-helpers.js";

const reviewLoopTopology = {
  structure: "graph" as const,
  roles: [
    {
      name: "coder",
      edges: [{ target: "reviewer", edgeType: "delegates" as const }],
    },
    {
      name: "reviewer",
      edges: [],
    },
  ],
};

describe("handoff integration", () => {
  test("contributeOperation creates a handoff record when topology routes to a downstream role", async () => {
    const { deps, cleanup } = await createTestOperationDeps();
    const bus = new LocalEventBus();
    const depsWithRouter = {
      ...deps,
      topologyRouter: new TopologyRouter(reviewLoopTopology, bus),
    };

    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "Create downstream handoff",
          agent: { agentId: "agent-1", role: "coder" },
        },
        depsWithRouter,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const handoffs = await deps.handoffStore.list();
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]?.status).toBe(HandoffStatus.PendingPickup);
      expect(handoffs[0]?.fromRole).toBe("coder");
      expect(handoffs[0]?.toRole).toBe("reviewer");
      expect(handoffs[0]?.sourceCid).toBe(result.value.cid);
    } finally {
      bus.close();
      await cleanup();
    }
  });

  test("contributeOperation handoff has correct fields", async () => {
    const { deps, cleanup } = await createTestOperationDeps();
    const bus = new LocalEventBus();
    const depsWithRouter = {
      ...deps,
      topologyRouter: new TopologyRouter(reviewLoopTopology, bus),
    };

    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "Create handoff fields",
          agent: { agentId: "agent-1", role: "coder" },
        },
        depsWithRouter,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [handoff] = await deps.handoffStore.list();
      expect(handoff?.requiresReply).toBe(false);
      expect(typeof handoff?.handoffId).toBe("string");
      expect(handoff?.handoffId.length).toBeGreaterThan(0);
      expect(handoff?.createdAt).toBeDefined();
    } finally {
      bus.close();
      await cleanup();
    }
  });

  test("contributeOperation result includes handoffIds", async () => {
    const { deps, cleanup } = await createTestOperationDeps();
    const bus = new LocalEventBus();
    const depsWithRouter = {
      ...deps,
      topologyRouter: new TopologyRouter(reviewLoopTopology, bus),
    };

    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "Expose handoff ids",
          agent: { agentId: "agent-1", role: "coder" },
        },
        depsWithRouter,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [handoff] = await deps.handoffStore.list();
      expect(handoff).toBeDefined();
      if (handoff === undefined) return;
      expect(result.value.handoffIds).toEqual([handoff.handoffId]);
    } finally {
      bus.close();
      await cleanup();
    }
  });

  test("contributeOperation succeeds without handoffStore in deps", async () => {
    const { deps, cleanup } = await createTestOperationDeps();
    const bus = new LocalEventBus();
    const depsWithoutHandoffStore = {
      ...deps,
      topologyRouter: new TopologyRouter(reviewLoopTopology, bus),
      handoffStore: undefined,
    };

    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "No handoff store available",
          agent: { agentId: "agent-1", role: "coder" },
        },
        depsWithoutHandoffStore,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.handoffIds === undefined || result.value.handoffIds.length === 0).toBe(
        true,
      );
    } finally {
      bus.close();
      await cleanup();
    }
  });

  test("handoffStore.expireStale marks overdue pending_pickup handoffs as expired", async () => {
    const handoffStore = new InMemoryHandoffStore();
    const handoff = await handoffStore.create({
      sourceCid: "blake3:test",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const expired = await handoffStore.expireStale();
    const updated = await handoffStore.get(handoff.handoffId);

    expect(expired.map((item) => item.handoffId)).toContain(handoff.handoffId);
    expect(updated?.status).toBe(HandoffStatus.Expired);
  });
});
