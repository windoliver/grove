import { describe, expect, test } from "bun:test";
import { fieldValue, matchesEvent, normalizeEventTypeName, patternMatches } from "./match.js";
import { type TrajectoryEvent, TrajectoryEventType } from "./types.js";

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

describe("matchesEvent", () => {
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
