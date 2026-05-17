import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../agent-runtime.js";
import type { AgentTaskEntity, AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import type { BindPlugin, FilterPlugin, PermitPlugin, ScorePlugin } from "./framework.js";
import type { RuntimeProfile } from "./profile.js";
import { Scheduler } from "./scheduler.js";

const TASK_ID = "task-1";

function taskView(): AgentTaskView {
  return {
    spec: {
      id: TASK_ID,
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id: TASK_ID,
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(name: string, overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    name,
    platform: "claude-code",
    runtimeCommand: "claude",
    ...overrides,
  };
}

function emptyStore(): {
  listAgentTaskEntities: () => Promise<readonly AgentTaskEntity[]>;
  getAgentTask: () => Promise<undefined>;
} {
  return { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined };
}

function alwaysReject(name: string, reason: string): FilterPlugin {
  return { name, filter: async () => ({ admit: false, reason }) };
}

function alwaysAdmit(name: string): FilterPlugin {
  return { name, filter: async () => ({ admit: true }) };
}

function constantScore(name: string, value: number): ScorePlugin {
  return { name, score: async () => value };
}

function autoPermit(): PermitPlugin {
  return { name: "auto", permit: async () => ({ status: "granted" }) };
}

function staticBind(session: AgentSession): BindPlugin {
  return { name: "static", bind: async () => ({ session }) };
}

describe("Scheduler.schedule — unschedulable", () => {
  test("returns unschedulable when all profiles are rejected", async () => {
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysReject("deny-all", "blocked")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("unschedulable");
    if (result.kind === "unschedulable") {
      expect(result.rejections).toHaveLength(2);
      expect(result.rejections[0]?.rejections[0]?.reason).toBe("blocked");
    }
  });
});

describe("Scheduler.schedule — scoring", () => {
  test("highest weighted-sum score wins", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysAdmit("admit-all")],
      scores: [
        { plugin: constantScoreFor(profile("a").name, 20, profile("b").name, 80), weight: 1 },
      ],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("b");
  });

  test("tie broken by config declaration order", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("first"), profile("second")],
      filters: [alwaysAdmit("admit-all")],
      scores: [{ plugin: constantScore("flat", 50), weight: 1 }],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("first");
  });

  test("weights multiply per-score contributions", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysAdmit("admit-all")],
      scores: [
        { plugin: constantScoreFor("a", 100, "b", 0), weight: 1 },
        { plugin: constantScoreFor("a", 0, "b", 100), weight: 2 },
      ],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("b");
  });
});

function constantScoreFor(
  nameA: string,
  valueA: number,
  nameB: string,
  valueB: number,
): ScorePlugin {
  return {
    name: `pair-${nameA}-${nameB}`,
    score: async (_ctx, profile) => {
      if (profile.name === nameA) return valueA;
      if (profile.name === nameB) return valueB;
      return 0;
    },
  };
}

describe("Scheduler.schedule — permit stage", () => {
  test("permit wait short-circuits before bind", async () => {
    const bind = staticBind({ id: "s", role: "worker", status: "running" });
    const bindSpy = { called: false };
    const observingBind: BindPlugin = {
      name: "watch",
      bind: async (ctx, profile) => {
        bindSpy.called = true;
        return bind.bind(ctx, profile);
      },
    };
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        { name: "manual", permit: async () => ({ status: "wait", reason: "awaiting-user" }) },
      ],
      bindPlugin: observingBind,
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("wait");
    expect(bindSpy.called).toBe(false);
    if (result.kind === "wait") {
      expect(result.plugin).toBe("manual");
      expect(result.reason).toBe("awaiting-user");
      expect(result.profile.name).toBe("a");
    }
  });

  test("permit denied short-circuits before bind", async () => {
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        { name: "policy", permit: async () => ({ status: "denied", reason: "not-allowed" }) },
      ],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.plugin).toBe("policy");
      expect(result.reason).toBe("not-allowed");
    }
  });

  test("permit stage stops at first non-granted verdict", async () => {
    const calls: string[] = [];
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        {
          name: "first",
          permit: async () => {
            calls.push("first");
            return { status: "wait", reason: "later" };
          },
        },
        {
          name: "second",
          permit: async () => {
            calls.push("second");
            return { status: "granted" };
          },
        },
      ],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    await scheduler.schedule(taskView());

    expect(calls).toEqual(["first"]);
  });
});

describe("Scheduler.schedule — fallback profile", () => {
  test("synthesizes a single profile from task.spec.runtime when none configured", async () => {
    const bindCalls: RuntimeProfile[] = [];
    const scheduler = new Scheduler({
      profiles: [],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: {
        name: "capture",
        bind: async (_ctx, profile) => {
          bindCalls.push(profile);
          return { session: { id: "s", role: "worker", status: "running" } };
        },
      },
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0]?.name).toBe("fallback-claude");
    expect(bindCalls[0]?.runtimeCommand).toBe("claude");
  });
});
