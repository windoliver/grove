import { describe, expect, test } from "bun:test";
import { readAgentTaskContext } from "./agent-task-context.js";

describe("readAgentTaskContext", () => {
  test("returns context when both env vars set", () => {
    const ctx = readAgentTaskContext({
      GROVE_AGENT_TASK_ID: "task-1",
      GROVE_AGENT_TASK_GENERATION: "3",
    });
    expect(ctx).toEqual({ taskId: "task-1", generation: 3 });
  });

  test("returns undefined when taskId missing", () => {
    const ctx = readAgentTaskContext({ GROVE_AGENT_TASK_GENERATION: "1" });
    expect(ctx).toBeUndefined();
  });

  test("returns undefined when generation missing", () => {
    const ctx = readAgentTaskContext({ GROVE_AGENT_TASK_ID: "x" });
    expect(ctx).toBeUndefined();
  });

  test("returns undefined when generation is non-numeric", () => {
    const ctx = readAgentTaskContext({
      GROVE_AGENT_TASK_ID: "x",
      GROVE_AGENT_TASK_GENERATION: "abc",
    });
    expect(ctx).toBeUndefined();
  });
});
