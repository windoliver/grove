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
import type { HookEntry, HookResult, HookRunner } from "../hooks.js";
import { LocalEventBus } from "../local-event-bus.js";
import type { AgentTopology } from "../topology.js";
import { TopologyRouter } from "../topology-router.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import { makeInMemoryContributionStore } from "./test-helpers.js";

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
    const store = makeInMemoryContributionStore();

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
      expect(result.value.routedTo).toEqual(["reviewer"]);
    }

    bus.close();
  });

  test("reviewer contribution routes back to coder", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

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
    if (reviewResult.ok) {
      expect(reviewResult.value.routedTo).toEqual(["coder"]);
    }

    bus.close();
  });

  test("no routing when agent has no role", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

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
    if (result.ok) {
      expect(result.value.routedTo).toBeUndefined();
    }

    bus.close();
  });

  test("no routing when topologyRouter is not provided", async () => {
    const bus = new LocalEventBus();
    const store = makeInMemoryContributionStore();

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
    if (result.ok) {
      expect(result.value.routedTo).toBeUndefined();
    }

    bus.close();
  });

  test("stop condition triggers broadcastStop to all roles", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

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
    expect(result.value.routedTo).toEqual(["reviewer"]);

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
    const store = makeInMemoryContributionStore();

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
    if (result.ok) {
      expect(result.value.routedTo).toEqual(["reviewer"]);
    }

    bus.close();
  });
});

// ---------------------------------------------------------------------------
// Hook execution in contribute pipeline
// ---------------------------------------------------------------------------

describe("contributeOperation: hook execution", () => {
  test("after_contribute hook fires after successful contribution", async () => {
    const store = makeInMemoryContributionStore();
    const hookCalls: Array<{ entry: HookEntry; cwd: string }> = [];

    const hookRunner: HookRunner = {
      run: async (entry: HookEntry, cwd: string): Promise<HookResult> => {
        hookCalls.push({ entry, cwd });
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          command: "test",
          durationMs: 0,
        };
      },
    };

    const deps: OperationDeps = {
      contributionStore: store,
      hookRunner,
      hookCwd: "/tmp/test-cwd",
      contract: {
        contractVersion: 2,
        name: "hook-test",
        hooks: { after_contribute: "echo done" },
      },
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "Triggers hook",
        agent: { agentId: "agent-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Hook is fire-and-forget — wait a tick for it to execute
    await new Promise((r) => setTimeout(r, 10));

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.entry).toBe("echo done");
    expect(hookCalls[0]!.cwd).toBe("/tmp/test-cwd");
  });

  test("hook failure does not block the contribution", async () => {
    const store = makeInMemoryContributionStore();

    const hookRunner: HookRunner = {
      run: async (): Promise<HookResult> => {
        throw new Error("hook crashed");
      },
    };

    const deps: OperationDeps = {
      contributionStore: store,
      hookRunner,
      hookCwd: "/tmp/test-cwd",
      contract: {
        contractVersion: 2,
        name: "hook-fail-test",
        hooks: { after_contribute: "failing-command" },
      },
    };

    // Capture stderr to verify error is logged
    const stderrCapture: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      stderrCapture.push(msg);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await contributeOperation(
        {
          kind: "work",
          summary: "Works despite hook failure",
          agent: { agentId: "agent-1" },
        },
        deps,
      );

      expect(result.ok).toBe(true);

      // Wait for the fire-and-forget hook to settle
      await new Promise((r) => setTimeout(r, 20));

      // Error should be logged to stderr (via fireAndForget)
      expect(stderrCapture.some((s) => s.includes("hook") && s.includes("crashed"))).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("no hook execution when hookRunner or hookCwd is missing", async () => {
    const store = makeInMemoryContributionStore();
    const hookCalls: HookEntry[] = [];

    const hookRunner: HookRunner = {
      run: async (entry: HookEntry): Promise<HookResult> => {
        hookCalls.push(entry);
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          command: "test",
          durationMs: 0,
        };
      },
    };

    // Provide hookRunner but not hookCwd
    const deps: OperationDeps = {
      contributionStore: store,
      hookRunner,
      // hookCwd intentionally omitted
      contract: {
        contractVersion: 2,
        name: "no-cwd-test",
        hooks: { after_contribute: "echo should-not-run" },
      },
    };

    const result = await contributeOperation(
      {
        kind: "work",
        summary: "No hook without cwd",
        agent: { agentId: "agent-1" },
      },
      deps,
    );

    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(hookCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plan + ephemeral message routing semantics (Issues 1A + 13A + 12A)
// ---------------------------------------------------------------------------
//
// These tests pin down the per-kind routing rules locked in during the
// #228 review. They prevent 1A from being a silent behavior change.
//
//   kind            | handoffs | route event | stop conditions
//   plan            |    no    |     yes     |       no
//   ephemeral msg   |    no    |     no      |       no
//   work / discuss  |    yes   |     yes     |       yes
//
// Without these tests, anyone refactoring the kind-based skip logic
// in contribute.ts could silently change semantics.

describe("contributeOperation: plan and ephemeral routing rules", () => {
  test("plan kind fires the routing event but creates no handoff", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    // Spy handoff store: tracks any create() calls.
    const handoffCreates: unknown[] = [];
    const handoffStore = {
      create: async (input: unknown) => {
        handoffCreates.push(input);
        return { handoffId: "fake-handoff" };
      },
      get: async () => undefined,
      list: async () => [],
      markDelivered: async () => undefined,
      markReplied: async () => undefined,
      expireStale: async () => [],
      countPending: async () => 0,
      close: () => undefined,
    } as unknown as NonNullable<OperationDeps["handoffStore"]>;

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      handoffStore,
    };

    const result = await contributeOperation(
      {
        kind: "plan",
        mode: "exploration",
        summary: "Plan: routed but no handoff",
        context: { plan_title: "P", tasks: [] },
        agent: { agentId: "planner-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Plans skip handoffs entirely.
    expect(handoffCreates).toHaveLength(0);
    if (result.ok) {
      expect(result.value.handoffIds).toBeUndefined();
    }

    // But the routing event still fires (so live UIs can observe plan creation).
    // Wait a tick because the event is fire-and-forget.
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.kind).toBe("plan");

    bus.close();
  });

  test("ephemeral message kind skips both routing event AND handoffs", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const handoffCreates: unknown[] = [];
    const handoffStore = {
      create: async (input: unknown) => {
        handoffCreates.push(input);
        return { handoffId: "fake-handoff" };
      },
      get: async () => undefined,
      list: async () => [],
      markDelivered: async () => undefined,
      markReplied: async () => undefined,
      expireStale: async () => [],
      countPending: async () => 0,
      close: () => undefined,
    } as unknown as NonNullable<OperationDeps["handoffStore"]>;

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      handoffStore,
    };

    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: "exploration",
        summary: "chat",
        context: { ephemeral: true, recipients: ["@reviewer"], message_body: "hi" },
        agent: { agentId: "coder-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Ephemeral messages skip handoffs.
    expect(handoffCreates).toHaveLength(0);

    // And skip the routing event.
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);

    bus.close();
  });

  test("non-ephemeral discussion routes normally (creates handoff and event)", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const handoffCreates: unknown[] = [];
    const handoffStore = {
      create: async (input: unknown) => {
        handoffCreates.push(input);
        return { handoffId: "fake-handoff" };
      },
      get: async () => undefined,
      list: async () => [],
      markDelivered: async () => undefined,
      markReplied: async () => undefined,
      expireStale: async () => [],
      countPending: async () => 0,
      close: () => undefined,
    } as unknown as NonNullable<OperationDeps["handoffStore"]>;

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      handoffStore,
    };

    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: "exploration",
        summary: "structured discussion",
        // Note: NO ephemeral flag — this is a regular discussion contribution
        agent: { agentId: "coder-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Regular discussions DO generate handoffs and route events.
    expect(handoffCreates).toHaveLength(1);
    if (result.ok) {
      expect(result.value.handoffIds).toBeDefined();
      expect(result.value.handoffIds).toHaveLength(1);
    }

    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    expect(received[0]!.payload.kind).toBe("discussion");

    bus.close();
  });

  test("plan does not trigger broadcastStop (Issue 13A: stop conditions skipped)", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

    const coderStops: GroveEvent[] = [];
    const reviewerStops: GroveEvent[] = [];
    bus.subscribe("coder", (e) => {
      if (e.type === "stop") coderStops.push(e);
    });
    bus.subscribe("reviewer", (e) => {
      if (e.type === "stop") reviewerStops.push(e);
    });

    // Pre-populate so a budget=1 stop condition would normally fire.
    await store.put({
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000099",
      manifestVersion: 1,
      kind: "work",
      mode: "evaluation",
      summary: "pre-existing",
      artifacts: {},
      relations: [],
      tags: [],
      agent: { agentId: "agent-0" },
      createdAt: new Date().toISOString(),
    });

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      contract: {
        contractVersion: 2,
        name: "plan-skip-stop-test",
        stopConditions: { budget: { maxContributions: 1 } },
      },
    };

    // A plan write would normally cross the budget threshold and trigger
    // broadcastStop, but plans skip stop-condition evaluation per Issue 13A.
    const result = await contributeOperation(
      {
        kind: "plan",
        mode: "exploration",
        summary: "Plan: skip-stop",
        context: { plan_title: "Skip", tasks: [] },
        agent: { agentId: "planner-1", role: "coder" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // Wait for any fire-and-forget broadcast.
    await new Promise((r) => setTimeout(r, 5));

    // No stop events should have been broadcast — plans bypass stop conditions.
    expect(coderStops).toHaveLength(0);
    expect(reviewerStops).toHaveLength(0);
    if (result.ok) {
      expect(result.value.policy?.stopResult?.stopped).not.toBe(true);
    }

    bus.close();
  });

  // -------------------------------------------------------------------------
  // grove_done discussion: session terminator, not new work
  // -------------------------------------------------------------------------
  //
  // grove_done writes a kind=discussion contribution with context.done=true
  // plus context.ephemeral=true (see src/mcp/tools/done.ts). The ephemeral
  // flag routes it through the same skip path as ephemeral messages: no
  // handoff, no route event. This prevents the "[DONE] session complete"
  // marker from waking up downstream agents with phantom work-to-pick-up.
  //
  // Discovered during #228 E2E validation — before this fix, a completed
  // review loop left 2 pending_pickup handoffs (one for the review, one
  // for grove_done) instead of just the 1 for the review itself.
  test("grove_done discussion (ephemeral=true, done=true) skips handoff and event", async () => {
    const bus = new LocalEventBus();
    const router = new TopologyRouter(reviewLoopTopology, bus);
    const store = makeInMemoryContributionStore();

    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    const handoffCreates: unknown[] = [];
    const handoffStore = {
      create: async (input: unknown) => {
        handoffCreates.push(input);
        return { handoffId: "fake-handoff" };
      },
      get: async () => undefined,
      list: async () => [],
      markDelivered: async () => undefined,
      markReplied: async () => undefined,
      expireStale: async () => [],
      countPending: async () => 0,
      close: () => undefined,
    } as unknown as NonNullable<OperationDeps["handoffStore"]>;

    const deps: OperationDeps = {
      contributionStore: store,
      topologyRouter: router,
      eventBus: bus,
      handoffStore,
    };

    // Exact shape that src/mcp/tools/done.ts writes when a reviewer approves.
    const result = await contributeOperation(
      {
        kind: "discussion",
        mode: "exploration",
        summary: "[DONE] Approved — code meets standards",
        context: {
          done: true,
          reason: "Approved — code meets standards",
          ephemeral: true,
        },
        agent: { agentId: "reviewer-1", role: "reviewer" },
      },
      deps,
    );

    expect(result.ok).toBe(true);

    // No handoff created for the done marker.
    expect(handoffCreates).toHaveLength(0);

    // No routing event fired for the done marker.
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);

    bus.close();
  });
});
