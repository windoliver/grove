import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { matchesEvent, patternMatches, valuesEqual } from "../match.js";
import { formatSeq, isTrajectoryEventType } from "../types.js";
import { parseCodexLine } from "./codex.js";

describe("parseCodexLine", () => {
  test("maps Codex transcript records to trajectory events", async () => {
    const text = await readFile("tests/fixtures/trajectory/codex-transcript.jsonl", "utf8");
    const lines = text.trimEnd().split("\n");
    const events = lines.flatMap(
      (line, index) => parseCodexLine(line, "codex-transcript.jsonl", index + 1).events,
    );

    expect(events.map((event) => event.type)).toEqual([
      "AGENT_START",
      "TOOL_CALL",
      "TOOL_RESULT",
      "ASSISTANT_MESSAGE",
    ]);
    expect(events[1]?.tool).toBe("apply_patch");
    expect(events[2]?.spanId).toBe("call-1");
  });

  test("delegates Codex ACP records and keeps invalid records as RAW", () => {
    const delegated = parseCodexLine(
      '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess-2"}}',
      "codex.jsonl",
      1,
    );
    const uppercase = parseCodexLine('{"event":"TOOL_CALL","spanId":"span-1"}', "codex.jsonl", 2);
    const invalid = parseCodexLine("[1]", "codex.jsonl", 3);
    const unknown = parseCodexLine('{"source":"codex"}', "codex.jsonl", 4);

    expect(delegated.events[0]?.runtime).toBe("codex");
    expect(delegated.events[0]?.type).toBe("AGENT_START");
    expect(uppercase.events[0]?.type).toBe("TOOL_CALL");
    expect(invalid.events[0]?.type).toBe("RAW");
    expect(invalid.events[0]?.error).toBe(invalid.warnings[0]);
    expect(unknown.events[0]?.type).toBe("RAW");
  });

  test("covers matcher helpers loaded by trajectory parsers", () => {
    const event = {
      seq: 1,
      type: "TOOL_CALL" as const,
      runtime: "codex" as const,
      tool: "apply_patch",
      spanId: "span-1",
      input: { file_path: "src/app.ts" },
      source: { path: "codex.jsonl", line: 1 },
    };

    expect(patternMatches("apply_patch", "apply_*")).toBe(true);
    expect(patternMatches(undefined, "*")).toBe(false);
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(matchesEvent(event, { event: "TOOL_CALL", tool: "apply_*" })).toBe(true);
    expect(matchesEvent(event, { event: "missing" })).toBe(false);
    expect(matchesEvent(event, { field_match: { "input.file_path": "src/*" } })).toBe(true);
    expect(matchesEvent(event, { field_not_match: { tool: "Read" } })).toBe(true);
    expect(isTrajectoryEventType("TOOL_CALL")).toBe(true);
    expect(formatSeq(3)).toBe("[seq:0003]");
  });
});
