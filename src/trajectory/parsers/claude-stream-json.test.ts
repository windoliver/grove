import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseClaudeStreamJsonLine } from "./claude-stream-json.js";

describe("parseClaudeStreamJsonLine", () => {
  test("maps Claude stream-json tool nesting to delegation events", async () => {
    const text = await readFile("tests/fixtures/trajectory/claude-stream-json.jsonl", "utf8");
    const lines = text.trimEnd().split("\n");
    const events = lines.flatMap(
      (line, index) =>
        parseClaudeStreamJsonLine(line, "claude-stream-json.jsonl", index + 1).events,
    );

    expect(events.map((event) => event.type)).toEqual([
      "ASSISTANT_MESSAGE",
      "DELEGATION",
      "TOOL_CALL",
      "TOOL_RESULT",
      "DELEGATION_RETURN",
    ]);
    expect(events[2]?.parentSpanId).toBe("tool-parent");
  });

  test("maps permission denial and non-array assistant text", () => {
    const assistant = parseClaudeStreamJsonLine(
      '{"type":"assistant","message":"hello"}',
      "claude.jsonl",
      1,
    );
    const denied = parseClaudeStreamJsonLine(
      '{"type":"permission_denied","error":"no"}',
      "claude.jsonl",
      2,
    );
    const unknown = parseClaudeStreamJsonLine('{"type":"unknown"}', "claude.jsonl", 3);

    expect(assistant.events[0]?.type).toBe("ASSISTANT_MESSAGE");
    expect(assistant.events[0]?.message).toBe("hello");
    expect(denied.events[0]?.type).toBe("PERMISSION_DENIED");
    expect(denied.events[0]?.error).toBe("no");
    expect(unknown.events[0]?.type).toBe("RAW");
  });

  test("maps tool_call_id to Claude stream-json span ids", () => {
    const call = parseClaudeStreamJsonLine(
      '{"type":"tool_call","tool_call_id":"call-1","name":"Read"}',
      "claude.jsonl",
      6,
    );

    expect(call.events[0]?.type).toBe("TOOL_CALL");
    expect(call.events[0]?.spanId).toBe("call-1");
  });

  test("keeps invalid and non-object stream-json records as RAW warnings", () => {
    const invalid = parseClaudeStreamJsonLine("not-json", "claude.jsonl", 4);
    const nonObject = parseClaudeStreamJsonLine("false", "claude.jsonl", 5);

    expect(invalid.events[0]?.type).toBe("RAW");
    expect(invalid.events[0]?.error).toBe(invalid.warnings[0]);
    expect(nonObject.events[0]?.type).toBe("RAW");
    expect(nonObject.warnings[0]).toContain("non-object");
  });
});
