import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../../agent-runtime.js";
import type { AgentSessionEntity } from "../../entity.js";
import {
  BUILTIN_FILTER_FACTORIES,
  BUILTIN_SCORE_FACTORIES,
  BUILTIN_PERMIT_FACTORIES,
  BUILTIN_BIND_FACTORIES,
  builtinPluginNames,
} from "./index.js";

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

describe("builtin plugin registry", () => {
  test("filter factories include the three default filters", () => {
    expect(Object.keys(BUILTIN_FILTER_FACTORIES).sort()).toEqual([
      "BudgetRemaining",
      "RuntimeCapability",
      "WorktreeExclusivity",
    ]);
  });

  test("score factories include TaskAffinity", () => {
    expect(Object.keys(BUILTIN_SCORE_FACTORIES)).toContain("TaskAffinity");
  });

  test("permit factories include AutoPermit and UserConfirmPermit", () => {
    expect(Object.keys(BUILTIN_PERMIT_FACTORIES).sort()).toEqual(["AutoPermit", "UserConfirmPermit"]);
  });

  test("bind factories include DefaultBind", () => {
    expect(Object.keys(BUILTIN_BIND_FACTORIES)).toEqual(["DefaultBind"]);
  });

  test("builtinPluginNames lists every plugin", () => {
    expect(builtinPluginNames()).toEqual(
      expect.arrayContaining([
        "RuntimeCapability",
        "BudgetRemaining",
        "WorktreeExclusivity",
        "TaskAffinity",
        "AutoPermit",
        "UserConfirmPermit",
        "DefaultBind",
      ]),
    );
  });

  test("factories produce instances with the expected name", () => {
    const filter = BUILTIN_FILTER_FACTORIES.RuntimeCapability({});
    const score = BUILTIN_SCORE_FACTORIES.TaskAffinity({});
    const permit = BUILTIN_PERMIT_FACTORIES.AutoPermit({});
    const bind = BUILTIN_BIND_FACTORIES.DefaultBind({ runtime: fakeRuntime() });
    expect(filter.name).toBe("RuntimeCapability");
    expect(score.name).toBe("TaskAffinity");
    expect(permit.name).toBe("AutoPermit");
    expect(bind.name).toBe("DefaultBind");
  });
});
