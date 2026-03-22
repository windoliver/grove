import { describe, expect, test } from "bun:test";
import { LocalEventBus } from "./local-event-bus.js";
import { TopologyRouter } from "./topology-router.js";
import type { AgentTopology } from "./topology.js";
import type { GroveEvent } from "./event-bus.js";

// --- LocalEventBus tests ---

describe("LocalEventBus", () => {
  test("publish delivers to subscriber of target role", () => {
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: { cid: "blake3:abc" },
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.sourceRole).toBe("coder");
    bus.close();
  });

  test("publish does not deliver to wrong role", () => {
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(0);
    bus.close();
  });

  test("unsubscribe stops delivery", () => {
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    const handler = (e: GroveEvent) => received.push(e);
    bus.subscribe("reviewer", handler);
    bus.unsubscribe("reviewer", handler);

    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(0);
    bus.close();
  });

  test("multiple subscribers on same role all receive", () => {
    const bus = new LocalEventBus();
    let count = 0;
    bus.subscribe("reviewer", () => count++);
    bus.subscribe("reviewer", () => count++);

    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(count).toBe(2);
    bus.close();
  });

  test("close removes all listeners", () => {
    const bus = new LocalEventBus();
    let count = 0;
    bus.subscribe("reviewer", () => count++);
    bus.close();

    bus.publish({
      type: "contribution",
      sourceRole: "coder",
      targetRole: "reviewer",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(count).toBe(0);
  });
});

// --- TopologyRouter tests ---

describe("TopologyRouter", () => {
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

  test("routes from coder to reviewer via delegates edge", () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const targets = router.route("coder", { cid: "blake3:abc" });

    expect(targets).toEqual(["reviewer"]);
    expect(received).toHaveLength(1);
    expect(received[0]!.payload).toEqual({ cid: "blake3:abc" });
    bus.close();
  });

  test("routes from reviewer to coder via feedback edge", () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    const targets = router.route("reviewer", { verdict: "changes_requested" });

    expect(targets).toEqual(["coder"]);
    expect(received).toHaveLength(1);
    bus.close();
  });

  test("no edges for unknown role -> empty targets", () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const targets = router.route("unknown-role", {});
    expect(targets).toHaveLength(0);
    bus.close();
  });

  test("flat topology (no edges) -> no routing", () => {
    const flat: AgentTopology = {
      structure: "flat",
      roles: [{ name: "worker1" }, { name: "worker2" }],
    };
    const bus = new LocalEventBus();
    const router = new TopologyRouter(flat, bus);

    const targets1 = router.route("worker1", {});
    const targets2 = router.route("worker2", {});

    expect(targets1).toHaveLength(0);
    expect(targets2).toHaveLength(0);
    bus.close();
  });

  test("tree topology: parent routes to children", () => {
    const tree: AgentTopology = {
      structure: "tree",
      roles: [
        {
          name: "coordinator",
          edges: [
            { target: "worker1", edgeType: "delegates" },
            { target: "worker2", edgeType: "delegates" },
          ],
        },
        { name: "worker1" },
        { name: "worker2" },
      ],
    };
    const bus = new LocalEventBus();
    const router = new TopologyRouter(tree, bus);
    const received1: GroveEvent[] = [];
    const received2: GroveEvent[] = [];
    bus.subscribe("worker1", (e) => received1.push(e));
    bus.subscribe("worker2", (e) => received2.push(e));

    const targets = router.route("coordinator", { plan: "implement auth" });

    expect(targets).toEqual(["worker1", "worker2"]);
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    bus.close();
  });

  test("broadcastStop sends to all roles", () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const coderEvents: GroveEvent[] = [];
    const reviewerEvents: GroveEvent[] = [];
    bus.subscribe("coder", (e) => coderEvents.push(e));
    bus.subscribe("reviewer", (e) => reviewerEvents.push(e));

    router.broadcastStop("Budget exceeded");

    expect(coderEvents).toHaveLength(1);
    expect(coderEvents[0]!.type).toBe("stop");
    expect(coderEvents[0]!.payload).toEqual({ reason: "Budget exceeded" });
    expect(reviewerEvents).toHaveLength(1);
    expect(reviewerEvents[0]!.type).toBe("stop");
    bus.close();
  });

  test("targetsFor returns correct targets", () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    expect(router.targetsFor("coder")).toEqual(["reviewer"]);
    expect(router.targetsFor("reviewer")).toEqual(["coder"]);
    expect(router.targetsFor("unknown")).toEqual([]);
    bus.close();
  });

  test("duplicate edges are deduplicated", () => {
    const duped: AgentTopology = {
      structure: "graph",
      roles: [
        {
          name: "coder",
          edges: [
            { target: "reviewer", edgeType: "delegates" },
            { target: "reviewer", edgeType: "feeds" },
          ],
        },
        { name: "reviewer" },
      ],
    };
    const bus = new LocalEventBus();
    const router = new TopologyRouter(duped, bus);
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const targets = router.route("coder", {});

    // Should only route once to reviewer despite two edges
    expect(targets).toEqual(["reviewer"]);
    expect(received).toHaveLength(1);
    bus.close();
  });
});
