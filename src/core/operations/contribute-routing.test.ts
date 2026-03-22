/**
 * Tests for EventBus/TopologyRouter integration in contributeOperation.
 *
 * Verifies that:
 * 1. Events are routed to downstream roles after a contribution is written
 * 2. Stop condition triggers broadcastStop to all roles
 * 3. No routing occurs when topologyRouter is not provided
 * 4. No routing occurs when the contributing agent has no role
 */

import { describe, expect, test } from "bun:test";

import type { GroveEvent } from "../event-bus.js";
import { LocalEventBus } from "../local-event-bus.js";
import type { Contribution } from "../models.js";
import type { ContributionStore } from "../store.js";
import type { AgentTopology } from "../topology.js";
import { TopologyRouter } from "../topology-router.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal in-memory contribution store. */
function makeStore(items: Contribution[] = []): ContributionStore {
  const store = [...items];
  return {
    storeIdentity: undefined,
    put: async (c: Contribution) => {
      if (!store.find((x) => x.cid === c.cid)) store.push(c);
    },
    putMany: async (cs: readonly Contribution[]) => {
      for (const c of cs) {
        if (!store.find((x) => x.cid === c.cid)) store.push(c);
      }
    },
    get: async (cid: string) => store.find((c) => c.cid === cid),
    getMany: async (cids: readonly string[]) => {
      const cidSet = new Set(cids);
      const result = new Map<string, Contribution>();
      for (const c of store) {
        if (cidSet.has(c.cid)) result.set(c.cid, c);
      }
      return result;
    },
    list: async (query?) => {
      let result = [...store];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      if (query?.agentId) result = result.filter((c) => c.agent.agentId === query.agentId);
      if (query?.limit) result = result.slice(0, query.limit);
      return result;
    },
    children: async () => [],
    ancestors: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    search: async () => [],
    findExisting: async () => [],
    count: async (query?) => {
      let result = [...store];
      if (query?.kind) result = result.filter((c) => c.kind === query.kind);
      if (query?.mode) result = result.filter((c) => c.mode === query.mode);
      return result.length;
    },
    countSince: async (query) => {
      return store.filter((c) => {
        if (query.agentId && c.agent.agentId !== query.agentId) return false;
        return c.createdAt >= query.since;
      }).length;
    },
    thread: async () => [],
    incomingSources: async () => [],
    replyCounts: async () => new Map(),
    hotThreads: async () => [],
    close: () => {},
  };
}

/** A simple two-role topology: coder -> reviewer -> coder. */
const reviewLoopTopology: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "coder",
      edges: [{ target: "reviewer", edgeType: "delegates" }],
    },
    {
      name: "reviewer",
      edges: [{ target: "coder", edgeType: "feedback" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contributeOperation: event routing", () => {
  test("routes contribution event to downstream role via topology", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Implement feature X",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("contribution");
    expect(received[0]!.sourceRole).toBe("coder");
    expect(received[0]!.targetRole).toBe("reviewer");
    expect(received[0]!.payload.kind).toBe("work");
    expect(received[0]!.payload.summary).toBe("Implement feature X");
    expect(received[0]!.payload.agentId).toBe("agent-1");
    if (result.ok) {
      expect(received[0]!.payload.cid).toBe(result.value.cid);
    }

    bus.close();
  });

  test("reviewer contribution routes back to coder", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeStore();

    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
    };

    // First create a work contribution to review
    const workResult = await contributeOperation(
      {
        kind: "work",
        summary: "Initial work",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );
    expect(workResult.ok).toBe(true);
    if (!workResult.ok) return;

    // Clear received (the work contribution routed to reviewer)
    received.length = 0;

    const reviewResult = await contributeOperation(
      {
        kind: "review",
        summary: "LGTM",
        relations: [{ targetCid: workResult.value.cid, relationType: "reviews" }],
        agent: { agentId: "agent-2", role: "reviewer" },
      },
      deps,
    );

    expect(reviewResult.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("contribution");
    expect(received[0]!.sourceRole).toBe("reviewer");
    expect(received[0]!.targetRole).toBe("coder");

    bus.close();
  });

  test("no routing when agent has no role", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));
    bus.subscribe("coder", (e) => received.push(e));

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Work without role",
        agent: { agentId: "agent-no-role" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(0);

    bus.close();
  });

  test("no routing when topologyRouter is not provided", async () => {
    const bus = new LocalEventBus();
    const store = makeStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));
    bus.subscribe("coder", (e) => received.push(e));

    const deps: OperationDeps = {
      contributionStore: store,
      // No topologyRouter provided
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Work without topology",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(0);

    bus.close();
  });

  test("stop condition triggers broadcastStop to all roles", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeStore();

    const coderEvents: GroveEvent[] = [];
    const reviewerEvents: GroveEvent[] = [];
    bus.subscribe("coder", (e) => coderEvents.push(e));
    bus.subscribe("reviewer", (e) => reviewerEvents.push(e));

    // Use a contract with a budget stop condition: maxContributions = 1
    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      contract: {
        contractVersion: 2,
        name: "stop-test",
        stopConditions: {
          budget: { maxContributions: 1 },
        },
      },
    };

    // Pre-populate store so the stop condition is met on the next contribution
    await store.put({
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000001",
      manifestVersion: 1,
      kind: "work",
      mode: "evaluation",
      summary: "Existing contribution",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "agent-0" },
      createdAt: new Date().toISOString(),
    });

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Triggers stop",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have the policy result with stop
    expect(result.value.policy).toBeDefined();
    expect(result.value.policy?.stopResult?.stopped).toBe(true);

    // Check that stop events were broadcast to both roles
    const coderStops = coderEvents.filter((e) => e.type === "stop");
    const reviewerStops = reviewerEvents.filter((e) => e.type === "stop");

    expect(coderStops).toHaveLength(1);
    expect(coderStops[0]!.sourceRole).toBe("system");
    expect(reviewerStops).toHaveLength(1);
    expect(reviewerStops[0]!.sourceRole).toBe("system");

    bus.close();
  });

  test("no broadcastStop when stop condition is not met", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeStore();

    const allEvents: GroveEvent[] = [];
    bus.subscribe("coder", (e) => allEvents.push(e));
    bus.subscribe("reviewer", (e) => allEvents.push(e));

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      contract: {
        contractVersion: 2,
        name: "no-stop-test",
        stopConditions: {
          budget: { maxContributions: 100 },
        },
      },
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Normal contribution",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Should have a contribution routing event to reviewer, but no stop events
    const stopEvents = allEvents.filter((e) => e.type === "stop");
    expect(stopEvents).toHaveLength(0);

    // Contribution event should still be routed
    const contribEvents = allEvents.filter((e) => e.type === "contribution");
    expect(contribEvents).toHaveLength(1);
    expect(contribEvents[0]!.targetRole).toBe("reviewer");

    bus.close();
  });
});
