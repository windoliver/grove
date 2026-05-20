import { describe, expect, test } from "bun:test";
import { AgentTaskConditionType, AgentTaskPhase, type AgentTaskView } from "./agent-task.js";
import type { Condition } from "./entity.js";
import { type Handoff, HandoffStatus } from "./handoff.js";
import {
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  HandoffOperatorAction,
  HandoffOperatorState,
  healthSignalsFromAgentFailures,
  healthSignalsFromAgentTasks,
} from "./handoff-operator-state.js";

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    handoffId: "handoff-1",
    sourceCid: "blake3:source",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.PendingPickup,
    requiresReply: true,
    createdAt: "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

function condition(overrides: Partial<Condition> = {}): Condition {
  return {
    type: AgentTaskConditionType.Blocked,
    status: "True",
    observedGeneration: 1,
    lastTransitionTime: "2026-05-20T10:00:00.000Z",
    reason: "depends-on",
    message: "Waiting for dependency",
    ...overrides,
  };
}

function agentTask(overrides: Partial<AgentTaskView> = {}): AgentTaskView {
  return {
    spec: {
      id: "task-1",
      worktree: "/tmp/worktree",
      runtime: "codex",
      role: "reviewer",
      prompt: "Review the change",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-20T09:00:00.000Z",
    },
    status: {
      id: "task-1",
      phase: AgentTaskPhase.Running,
      sessionId: "session-1",
      contributions: [],
      conditions: [],
      observedGeneration: 1,
      lastTransitionAt: "2026-05-20T10:00:00.000Z",
      revision: 1,
    },
    ...overrides,
  };
}

describe("deriveHandoffOperatorProjection", () => {
  test("pending unresolved handoff projects to pending", () => {
    const projection = deriveHandoffOperatorProjection(handoff(), {
      now: "2026-05-20T10:01:00.000Z",
    });

    expect(projection.handoff.handoffId).toBe("handoff-1");
    expect(projection.state).toBe(HandoffOperatorState.Pending);
    expect(projection.reason).toBe("waiting for target role");
    expect(projection.actions).toEqual([
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Cancel,
    ]);
  });

  test("past unresolved deadline projects to overdue", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({ replyDueAt: "2026-05-20T10:00:30.000Z" }),
      { now: "2026-05-20T10:01:00.000Z" },
    );

    expect(projection.state).toBe(HandoffOperatorState.Overdue);
    expect(projection.reason).toBe("deadline passed");
  });

  test("deadline at now projects unresolved handoff to overdue", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({ status: HandoffStatus.Delivered, replyDueAt: "2026-05-20T10:01:00.000Z" }),
      { now: "2026-05-20T10:01:00.000Z" },
    );

    expect(projection.state).toBe(HandoffOperatorState.Overdue);
  });

  test("unhealthy target projects unresolved handoff to blocked", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({ status: HandoffStatus.Processed }),
      {
        healthSignals: [{ role: "reviewer", healthy: false, reason: "agent task failed" }],
        now: "2026-05-20T10:01:00.000Z",
      },
    );

    expect(projection.state).toBe(HandoffOperatorState.Blocked);
    expect(projection.reason).toBe("agent task failed");
  });

  test("blocked reason falls back when the matching health signal has no reason", () => {
    const projection = deriveHandoffOperatorProjection(handoff(), {
      healthSignals: [{ role: "reviewer", healthy: false, reason: "" }],
    });

    expect(projection.state).toBe(HandoffOperatorState.Blocked);
    expect(projection.reason).toBe("target unavailable");
  });

  test("dead_lettered wins over health and deadline", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({
        status: HandoffStatus.DeadLettered,
        replyDueAt: "2026-05-20T10:00:30.000Z",
      }),
      {
        healthSignals: [{ role: "reviewer", healthy: false, reason: "agent task failed" }],
        now: "2026-05-20T10:01:00.000Z",
      },
    );

    expect(projection.state).toBe(HandoffOperatorState.DeadLettered);
    expect(projection.reason).toBe("delivery failed");
  });

  test("terminal statuses project to final operator states", () => {
    expect(
      deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.Replied })),
    ).toMatchObject({
      state: HandoffOperatorState.Resolved,
      reason: "reply received",
      actions: [],
    });
    expect(
      deriveHandoffOperatorProjection(
        handoff({ status: HandoffStatus.Cancelled, terminalReason: "operator stopped waiting" }),
      ),
    ).toMatchObject({
      state: HandoffOperatorState.Cancelled,
      reason: "operator stopped waiting",
      actions: [],
    });
    expect(
      deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.ManuallyResolved })),
    ).toMatchObject({
      state: HandoffOperatorState.ManuallyResolved,
      reason: "operator resolved",
      actions: [],
    });
  });

  test("blocked and dead-lettered projections expose action affordances", () => {
    const blocked = deriveHandoffOperatorProjection(handoff(), {
      healthSignals: [{ role: "reviewer", healthy: false, reason: "target session missing" }],
    });
    expect(blocked.actions).toEqual([
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Reroute,
      HandoffOperatorAction.Cancel,
      HandoffOperatorAction.ManualResolve,
    ]);

    const dead = deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.DeadLettered }));
    expect(dead.actions).toEqual([
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Reroute,
      HandoffOperatorAction.ManualResolve,
    ]);
  });
});

describe("countHandoffOperatorStates", () => {
  test("counts pending, overdue, blocked, and dead-lettered states", () => {
    const counts = countHandoffOperatorStates([
      deriveHandoffOperatorProjection(handoff({ handoffId: "p" })),
      deriveHandoffOperatorProjection(
        handoff({ handoffId: "o", replyDueAt: "2026-05-20T10:00:00.000Z" }),
        { now: "2026-05-20T10:01:00.000Z" },
      ),
      deriveHandoffOperatorProjection(handoff({ handoffId: "b" }), {
        healthSignals: [{ role: "reviewer", healthy: false, reason: "missing" }],
      }),
      deriveHandoffOperatorProjection(
        handoff({ handoffId: "d", status: HandoffStatus.DeadLettered }),
      ),
      deriveHandoffOperatorProjection(handoff({ handoffId: "r", status: HandoffStatus.Replied })),
    ]);

    expect(counts).toEqual({
      pending: 1,
      overdue: 1,
      blocked: 1,
      deadLettered: 1,
    });
  });
});

describe("health signal helpers", () => {
  test("agent task failures and unhealthy conditions become health signals", () => {
    const failed = agentTask({
      spec: { ...agentTask().spec, id: "task-failed", role: "reviewer" },
      status: { ...agentTask().status, id: "task-failed", phase: AgentTaskPhase.Failed },
    });
    const unschedulable = agentTask({
      spec: { ...agentTask().spec, id: "task-unschedulable", role: "tester" },
      status: {
        ...agentTask().status,
        id: "task-unschedulable",
        conditions: [
          condition({
            type: AgentTaskConditionType.Unschedulable,
            reason: "no-runner",
            message: "No runner available",
          }),
        ],
      },
    });
    const healthy = agentTask({
      spec: { ...agentTask().spec, id: "task-healthy", role: "auditor" },
    });

    expect(healthSignalsFromAgentTasks([failed, unschedulable, healthy])).toEqual([
      { role: "reviewer", healthy: false, reason: "agent task failed" },
      { role: "tester", healthy: false, reason: "no-runner" },
    ]);
  });

  test("failure maps become unhealthy role signals", () => {
    const signals = healthSignalsFromAgentFailures(
      new Map([
        ["reviewer", "SSE stream unhealthy"],
        ["tester", "process exited"],
      ]),
    );

    expect(signals).toEqual([
      { role: "reviewer", healthy: false, reason: "SSE stream unhealthy" },
      { role: "tester", healthy: false, reason: "process exited" },
    ]);
    expect(healthSignalsFromAgentFailures(undefined)).toEqual([]);
  });
});
