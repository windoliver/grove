import { describe, expect, test } from "bun:test";
import { AgentTaskConditionType } from "./agent-task.js";

describe("AgentTaskConditionType", () => {
  test("includes Unschedulable for scheduler-rejected tasks", () => {
    expect(AgentTaskConditionType.Unschedulable).toBe("Unschedulable");
  });

  test("includes PermitRequired for scheduler permit-wait", () => {
    expect(AgentTaskConditionType.PermitRequired).toBe("PermitRequired");
  });

  test("includes DoneSignaled for agent-signaled completion", () => {
    expect(AgentTaskConditionType.DoneSignaled).toBe("DoneSignaled");
  });
});
