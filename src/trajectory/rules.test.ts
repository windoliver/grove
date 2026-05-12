import { describe, expect, test } from "bun:test";
import { evaluateRules } from "./rules.js";
import type { RuleSpec, TrajectoryEvent, TranscriptIndex } from "./types.js";

function event(seq: number, overrides: Partial<TrajectoryEvent>): TrajectoryEvent {
  return {
    seq,
    type: "TOOL_CALL",
    runtime: "codex",
    source: { path: "t.jsonl", line: seq },
    ...overrides,
  };
}

function index(events: readonly TrajectoryEvent[]): TranscriptIndex {
  return {
    runtime: "codex",
    transcriptPath: "t.jsonl",
    events,
    warnings: [],
    bySeq: new Map(events.map((item) => [item.seq, item])),
    bySpanId: new Map(),
    childrenByParentSpanId: new Map(),
  };
}

describe("evaluateRules", () => {
  test("must_exist fails when no event matches", () => {
    const result = evaluateRules(index([event(1, { type: "TOOL_CALL" })]), [
      { id: "requires-denial", kind: "must_exist", match: { event: "PERMISSION_DENIED" } },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.message).toContain("requires-denial");
  });

  test("must_not_exist reports matching event sequence refs", () => {
    const result = evaluateRules(index([event(1, { type: "PERMISSION_DENIED" })]), [
      { id: "no-denials", kind: "must_not_exist", match: { event: "PERMISSION_DENIED" } },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.seqRef).toBe("[seq:0001]");
  });

  test("allowed_tools fails disallowed tool calls", () => {
    const result = evaluateRules(index([event(2, { tool: "rm" })]), [
      { id: "tools", kind: "allowed_tools", allowed: ["Read", "apply_patch"] },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.message).toContain("rm");
  });

  test("allowed_tools fails missing tool names", () => {
    const result = evaluateRules(index([event(2, {})]), [
      { id: "tools", kind: "allowed_tools", allowed: ["Read", "apply_patch"] },
    ]);

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.message).toContain("<missing>");
  });

  test("field_constraint validates existence and glob matches", () => {
    const rules: RuleSpec[] = [
      {
        id: "has-tool",
        kind: "field_constraint",
        match: { event: "TOOL_CALL" },
        field: "tool",
        exists: true,
      },
      {
        id: "src-file",
        kind: "field_constraint",
        match: { event: "TOOL_CALL" },
        field: "input.file_path",
        match_value: "src/*",
      },
    ];
    const result = evaluateRules(
      index([event(3, { tool: "Read", input: { file_path: "src/app.ts" } })]),
      rules,
    );

    expect(result.every((item) => item.status === "pass")).toBe(true);
  });

  test("field_constraint reports failed constraint variants", () => {
    const result = evaluateRules(
      index([event(4, { tool: "Read", input: { file_path: "src/app.ts" } })]),
      [
        { id: "missing", kind: "field_constraint", field: "input.missing", exists: true },
        { id: "exists-false", kind: "field_constraint", field: "tool", exists: false },
        { id: "not-exists", kind: "field_constraint", field: "tool", not_exists: true },
        { id: "equals", kind: "field_constraint", field: "tool", equals: "Write" },
        { id: "not-equals", kind: "field_constraint", field: "tool", not_equals: "Read" },
        { id: "match", kind: "field_constraint", field: "input.file_path", match_value: "lib/*" },
        { id: "not-match", kind: "field_constraint", field: "input.file_path", not_match: "src/*" },
      ],
    );

    expect(result.every((item) => item.status === "fail")).toBe(true);
    expect(result.every((item) => item.violations.length === 1)).toBe(true);
  });

  test("invalid rule configuration returns failures", () => {
    const result = evaluateRules(index([]), [
      { id: "allowed-config", kind: "allowed_tools" },
      { id: "field-config", kind: "field_constraint" },
      { id: "precedes-trigger-config", kind: "precedes", required: { event: "TOOL_CALL" } },
      { id: "precedes-required-config", kind: "precedes", trigger: { event: "TOOL_CALL" } },
    ]);

    expect(result.every((item) => item.status === "fail")).toBe(true);
    expect(result.map((item) => item.violations[0]?.message)).toEqual([
      "allowed_tools rule requires an allowed list.",
      "field_constraint rule requires a field.",
      "precedes rule requires a trigger matcher.",
      "precedes rule requires a required matcher.",
    ]);
  });

  test("precedes requires prior matching evidence with same field", () => {
    const result = evaluateRules(
      index([
        event(1, { tool: "backup_file", input: { file_path: "src/app.ts" } }),
        event(2, { tool: "apply_patch", input: { file_path: "src/app.ts" } }),
        event(3, { tool: "apply_patch", input: { file_path: "src/other.ts" } }),
      ]),
      [
        {
          id: "backup-before-edit",
          kind: "precedes",
          trigger: { event: "TOOL_CALL", tool: "apply_patch" },
          required: { event: "TOOL_CALL", tool: "backup_file", match_field: "input.file_path" },
        },
      ],
    );

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations).toHaveLength(1);
    expect(result[0]?.violations[0]?.seq).toBe(3);
  });

  test("precedes accepts any prior required event without match_field", () => {
    const result = evaluateRules(
      index([event(1, { tool: "backup_file" }), event(2, { tool: "apply_patch" })]),
      [
        {
          id: "backup-before-edit",
          kind: "precedes",
          trigger: { event: "TOOL_CALL", tool: "apply_patch" },
          required: { event: "TOOL_CALL", tool: "backup_file" },
        },
      ],
    );

    expect(result[0]?.status).toBe("pass");
  });

  test("precedes includes truncated message snippets on violations", () => {
    const longMessage = "x".repeat(140);
    const result = evaluateRules(
      index([event(1, { tool: "Read" }), event(2, { tool: "apply_patch", message: longMessage })]),
      [
        {
          id: "backup-before-edit",
          kind: "precedes",
          trigger: { event: "TOOL_CALL", tool: "apply_patch" },
          required: { event: "TOOL_CALL", tool: "backup_file" },
        },
      ],
    );

    expect(result[0]?.status).toBe("fail");
    expect(result[0]?.violations[0]?.messageSnippet).toHaveLength(120);
  });
});
