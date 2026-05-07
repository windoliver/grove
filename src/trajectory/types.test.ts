import { describe, expect, test } from "bun:test";
import { formatSeq, isTrajectoryEventType, TrajectoryEventType } from "./types.js";

describe("TrajectoryEventType", () => {
  test("includes deterministic issue #339 event types and timeline-compatible event families", () => {
    expect(TrajectoryEventType.ToolCall).toBe("TOOL_CALL");
    expect(TrajectoryEventType.PermissionDenied).toBe("PERMISSION_DENIED");
    expect(TrajectoryEventType.WorkBlockStarted).toBe("WORK_BLOCK_STARTED");
    expect(TrajectoryEventType.TaskScheduled).toBe("TASK_SCHEDULED");
    expect(TrajectoryEventType.HealthRecovered).toBe("HEALTH_RECOVERED");
    expect(TrajectoryEventType.Raw).toBe("RAW");
  });

  test("validates event type values", () => {
    expect(isTrajectoryEventType("TOOL_CALL")).toBe(true);
    expect(isTrajectoryEventType("tool_call")).toBe(false);
    expect(isTrajectoryEventType("NOT_REAL")).toBe(false);
  });
});

describe("formatSeq", () => {
  test("formats sequence markers with four digits until values exceed four digits", () => {
    expect(formatSeq(1)).toBe("[seq:0001]");
    expect(formatSeq(42)).toBe("[seq:0042]");
    expect(formatSeq(12_345)).toBe("[seq:12345]");
  });
});
