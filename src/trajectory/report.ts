import type { GoalResult, RuleResult, TrajectoryCheckReport, TrajectoryEvent } from "./types.js";
import { formatSeq } from "./types.js";

export function summarizeReport(
  ruleResults: readonly RuleResult[],
  goalResults: readonly GoalResult[],
): TrajectoryCheckReport["summary"] {
  return {
    passed: ruleResults.filter((result) => result.status === "pass").length,
    failed: ruleResults.filter((result) => result.status === "fail").length,
    deferred: goalResults.length,
  };
}

export function formatMarkdownReport(report: TrajectoryCheckReport): string {
  const lines: string[] = [
    "# Trajectory Check Report",
    "",
    `- Name: ${report.name}`,
    `- Transcript: ${report.transcriptPath}`,
    `- Runtime: ${report.runtime}`,
    `- Specs: ${report.specPaths.join(", ")}`,
    `- Events: ${report.eventCount}`,
    "",
    "## Summary",
    "",
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Deferred: ${report.summary.deferred}`,
    "",
  ];

  const failedRules = report.ruleResults.filter((result) => result.status === "fail");
  lines.push("## Failed Rules", "");
  if (failedRules.length === 0) {
    lines.push("- None", "");
  } else {
    for (const result of failedRules) {
      lines.push(`- ${result.ruleId}`);
      for (const violation of result.violations) {
        const seqRef =
          violation.seqRef ?? (violation.seq === undefined ? undefined : formatSeq(violation.seq));
        const prefix = seqRef === undefined ? "" : `${seqRef} `;
        lines.push(`  - ${prefix}${violation.message}`);
      }
    }
    lines.push("");
  }

  const passedRules = report.ruleResults.filter((result) => result.status === "pass");
  lines.push("## Passed Rules", "");
  if (passedRules.length === 0) {
    lines.push("- None", "");
  } else {
    lines.push(...passedRules.map((result) => `- ${result.ruleId}`), "");
  }

  lines.push("## Deferred Goals", "");
  if (report.goalResults.length === 0) {
    lines.push("- None", "");
  } else {
    for (const result of report.goalResults) {
      lines.push(`- ${result.goalId}: ${result.message}`);
    }
    lines.push("");
  }

  if (report.parserWarnings.length > 0) {
    lines.push("## Parser Warnings", "");
    lines.push(...report.parserWarnings.map((warning) => `- ${warning}`), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatJsonReport(report: TrajectoryCheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatAnnotatedEvents(events: readonly TrajectoryEvent[]): string {
  if (events.length === 0) return "";
  return `${events.map((event) => `${formatSeq(event.seq)} ${JSON.stringify(compactEvent(event))}`).join("\n")}\n`;
}

function compactEvent(event: TrajectoryEvent): Readonly<Record<string, unknown>> {
  return {
    seq: event.seq,
    type: event.type,
    runtime: event.runtime,
    source: event.source,
    ...optionalField("tool", event.tool),
    ...optionalField("status", event.status),
    ...optionalField("spanId", event.spanId),
    ...optionalField("parentSpanId", event.parentSpanId),
    ...optionalField("message", event.message),
  };
}

function optionalField(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
