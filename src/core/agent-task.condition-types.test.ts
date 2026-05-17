import { describe, expect, test } from "bun:test";

import { AgentTaskConditionType } from "./agent-task.js";

describe("AgentTaskConditionType", () => {
  test("includes Unschedulable", () => {
    expect(AgentTaskConditionType.Unschedulable).toBe("Unschedulable");
  });

  test("includes PermitRequired", () => {
    expect(AgentTaskConditionType.PermitRequired).toBe("PermitRequired");
  });

  test("includes DoneSignaled for agent-signaled completion", () => {
    expect(AgentTaskConditionType.DoneSignaled).toBe("DoneSignaled");
  });
});
