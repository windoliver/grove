import { describe, expect, test } from "bun:test";
import { formatAnnotatedEvents, formatMarkdownReport, summarizeReport } from "./report.js";
import type { TrajectoryCheckReport, TrajectoryEvent } from "./types.js";

const report: TrajectoryCheckReport = {
  name: "common",
  transcriptPath: "transcript.jsonl",
  runtime: "codex",
  eventCount: 2,
  specPaths: ["spec/trajectory/common.yaml"],
  ruleResults: [
    { ruleId: "ok", status: "pass", violations: [] },
    {
      ruleId: "bad",
      status: "fail",
      violations: [{ ruleId: "bad", message: "Denied", seq: 2, seqRef: "[seq:0002]" }],
    },
  ],
  goalResults: [{ goalId: "goal", status: "deferred", message: "LLM goal grading is deferred" }],
  parserWarnings: ["line 5: invalid"],
  summary: { passed: 1, failed: 1, deferred: 1 },
};

describe("report formatting", () => {
  test("summarizes rule and goal statuses", () => {
    expect(summarizeReport(report.ruleResults, report.goalResults)).toEqual({
      passed: 1,
      failed: 1,
      deferred: 1,
    });
  });

  test("formats markdown with sequence references", () => {
    const markdown = formatMarkdownReport(report);
    expect(markdown).toContain("# Trajectory Check Report");
    expect(markdown).toContain("[seq:0002]");
    expect(markdown).toContain("Parser Warnings");
  });

  test("formats annotated event JSONL", () => {
    const events: TrajectoryEvent[] = [
      {
        seq: 1,
        type: "ASSISTANT_MESSAGE",
        runtime: "codex",
        message: "hi",
        source: { path: "t", line: 1 },
      },
    ];
    expect(formatAnnotatedEvents(events)).toContain('[seq:0001] {"seq":1');
  });
});
