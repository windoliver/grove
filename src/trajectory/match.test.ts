import { describe, expect, test } from "bun:test";
import {
  fieldValue,
  matchesEvent,
  normalizeEventTypeName,
  patternMatches,
  valuesEqual,
} from "./match.js";
import { formatSeq, type TrajectoryEvent, TrajectoryEventType } from "./types.js";

const baseEvent: TrajectoryEvent = {
  seq: 7,
  type: TrajectoryEventType.ToolCall,
  runtime: "codex",
  tool: "apply_patch",
  input: { file_path: "src/app.ts", patch: "--- a/src/app.ts" },
  raw: { nested: { value: "alpha" } },
  source: { path: "transcript.jsonl", line: 3 },
};

describe("normalizeEventTypeName", () => {
  test("accepts canonical and lowercase event aliases", () => {
    expect(normalizeEventTypeName("TOOL_CALL")).toBe("TOOL_CALL");
    expect(normalizeEventTypeName("tool_call")).toBe("TOOL_CALL");
    expect(normalizeEventTypeName("permission_denied")).toBe("PERMISSION_DENIED");
    expect(normalizeEventTypeName("not_real")).toBeUndefined();
  });
});

describe("formatSeq", () => {
  test("pads sequence numbers for reports", () => {
    expect(formatSeq(7)).toBe("[seq:0007]");
  });
});

describe("fieldValue", () => {
  test("reads normalized fields and raw payload fields", () => {
    expect(fieldValue(baseEvent, "input.file_path")).toBe("src/app.ts");
    expect(fieldValue(baseEvent, "raw.nested.value")).toBe("alpha");
    expect(fieldValue(baseEvent, "missing.value")).toBeUndefined();
  });
});

describe("patternMatches", () => {
  test("supports glob wildcards and pipe alternation", () => {
    expect(patternMatches("apply_patch", "apply_patch|edit_file")).toBe(true);
    expect(patternMatches("--- a/src/app.ts", "--- a/*")).toBe(true);
    expect(patternMatches("read_file", "apply_patch|edit_file")).toBe(false);
  });
});

describe("valuesEqual", () => {
  test("compares structured values deeply", () => {
    expect(valuesEqual({ status: "ok" }, { status: "ok" })).toBe(true);
    expect(valuesEqual({ status: "ok" }, { status: "failed" })).toBe(false);
  });
});

describe("matchesEvent", () => {
  test("supports event alternation for canonical and lowercase event names", () => {
    const matcher = { event: "ASSISTANT_MESSAGE|agent_start" };
    const assistantMessage: TrajectoryEvent = {
      ...baseEvent,
      type: TrajectoryEventType.AssistantMessage,
    };
    const agentStart: TrajectoryEvent = {
      ...baseEvent,
      type: TrajectoryEventType.AgentStart,
    };
    const toolCall: TrajectoryEvent = {
      ...baseEvent,
      type: TrajectoryEventType.ToolCall,
    };

    expect(matchesEvent(assistantMessage, matcher)).toBe(true);
    expect(matchesEvent(agentStart, matcher)).toBe(true);
    expect(matchesEvent(toolCall, matcher)).toBe(false);
  });

  test("rejects event alternation containing unknown event names", () => {
    expect(matchesEvent(baseEvent, { event: "TOOL_CALL|not_real" })).toBe(false);
  });

  test("matches by event, tool, field_match, and field_not_match", () => {
    expect(
      matchesEvent(baseEvent, {
        event: "tool_call",
        tool: "apply_patch|edit_file",
        field_match: { "input.file_path": "src/*" },
        field_not_match: { "input.patch": "--- /dev/null*" },
      }),
    ).toBe(true);

    expect(
      matchesEvent(baseEvent, {
        event: "permission_denied",
      }),
    ).toBe(false);
  });
});
