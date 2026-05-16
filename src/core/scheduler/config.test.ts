import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentSessionEntity } from "../entity.js";
import { loadSchedulerConfig, SchedulerConfigSchema } from "./config.js";

function fakeRuntime(): AgentRuntime {
  return {
    spawn: async () => ({ id: "s", role: "r", status: "running" }),
    send: async () => {
      throw new Error("unused");
    },
    close: async () => {},
    onIdle: () => {},
    listSessions: async () => [],
    listSessionEntities: async () => [] as readonly AgentSessionEntity[],
    isAvailable: async () => true,
  };
}

describe("SchedulerConfigSchema", () => {
  test("accepts a minimal config", () => {
    const parsed = SchedulerConfigSchema.parse({
      profiles: [
        { name: "p", platform: "claude-code", runtimeCommand: "claude" },
      ],
      pipeline: {
        filters: ["RuntimeCapability"],
        scores: [{ name: "TaskAffinity", weight: 1 }],
        permits: ["AutoPermit"],
        bind: "DefaultBind",
      },
    });
    expect(parsed.profiles).toHaveLength(1);
  });

  test("rejects negative score weight", () => {
    expect(() =>
      SchedulerConfigSchema.parse({
        profiles: [],
        pipeline: {
          filters: [],
          scores: [{ name: "TaskAffinity", weight: -1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      }),
    ).toThrow();
  });

  test("rejects missing platform", () => {
    expect(() =>
      SchedulerConfigSchema.parse({
        profiles: [{ name: "p", runtimeCommand: "claude" }],
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      }),
    ).toThrow();
  });
});

describe("loadSchedulerConfig", () => {
  test("resolves plugin names against the built-in registry", () => {
    const opts = loadSchedulerConfig(
      {
        profiles: [
          { name: "p", platform: "claude-code", runtimeCommand: "claude" },
        ],
        pipeline: {
          filters: ["RuntimeCapability", "BudgetRemaining", "WorktreeExclusivity"],
          scores: [{ name: "TaskAffinity", weight: 1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime: fakeRuntime() },
    );
    expect(opts.filters.map((f) => f.name)).toEqual([
      "RuntimeCapability",
      "BudgetRemaining",
      "WorktreeExclusivity",
    ]);
    expect(opts.scores).toHaveLength(1);
    expect(opts.scores[0]?.plugin.name).toBe("TaskAffinity");
    expect(opts.scores[0]?.weight).toBe(1);
    expect(opts.permits[0]?.name).toBe("AutoPermit");
    expect(opts.bindPlugin.name).toBe("DefaultBind");
    expect(opts.profiles).toHaveLength(1);
  });

  test("unknown plugin name yields a descriptive error listing known plugins", () => {
    expect(() =>
      loadSchedulerConfig(
        {
          profiles: [],
          pipeline: {
            filters: ["NotARealFilter"],
            scores: [],
            permits: ["AutoPermit"],
            bind: "DefaultBind",
          },
        },
        { runtime: fakeRuntime() },
      ),
    ).toThrow(/NotARealFilter.*known plugins/i);
  });

  test("default ledger is permissive", () => {
    const opts = loadSchedulerConfig(
      {
        profiles: [],
        pipeline: {
          filters: ["BudgetRemaining"],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime: fakeRuntime() },
    );
    expect(opts.filters[0]?.name).toBe("BudgetRemaining");
  });
});
