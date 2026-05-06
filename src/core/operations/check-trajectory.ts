import { writeFile } from "node:fs/promises";
import { buildTranscriptIndex } from "../../trajectory/indexer.js";
import {
  formatAnnotatedEvents,
  formatJsonReport,
  formatMarkdownReport,
  summarizeReport,
} from "../../trajectory/report.js";
import { evaluateRules } from "../../trajectory/rules.js";
import { loadTrajectorySpecs } from "../../trajectory/spec-loader.js";
import type {
  GoalResult,
  ReportFormat,
  TrajectoryCheckReport,
  TrajectoryRuntimeInput,
} from "../../trajectory/types.js";
import type { OperationResult } from "./result.js";
import { err, OperationErrorCode, ok, validationErr } from "./result.js";

export interface CheckTrajectoryInput {
  readonly transcriptPath: string;
  readonly specPaths: readonly string[];
  readonly runtime: TrajectoryRuntimeInput;
  readonly format: ReportFormat;
  readonly annotatedLogPath?: string | undefined;
}

export interface CheckTrajectoryResult {
  readonly report: TrajectoryCheckReport;
  readonly output: string;
}

export async function checkTrajectoryOperation(
  input: CheckTrajectoryInput,
): Promise<OperationResult<CheckTrajectoryResult>> {
  if (input.transcriptPath.trim().length === 0) {
    return validationErr("transcriptPath is required");
  }
  if (input.specPaths.length === 0) {
    return validationErr("at least one specPath is required");
  }

  try {
    const index = await buildTranscriptIndex({
      transcriptPath: input.transcriptPath,
      runtime: input.runtime,
    });
    const spec = await loadTrajectorySpecs(input.specPaths);
    const ruleResults = evaluateRules(index, spec.rules);
    const goalResults: GoalResult[] = spec.goals.map((goal) => ({
      goalId: goal.id,
      status: "deferred",
      message: "LLM goal grading is deferred in this implementation slice",
    }));
    const summary = summarizeReport(ruleResults, goalResults);
    const report: TrajectoryCheckReport = {
      name: spec.name,
      transcriptPath: index.transcriptPath,
      runtime: index.runtime,
      eventCount: index.events.length,
      specPaths: spec.sourcePaths,
      ruleResults,
      goalResults,
      parserWarnings: index.warnings,
      summary,
    };

    if (input.annotatedLogPath !== undefined) {
      await writeFile(input.annotatedLogPath, formatAnnotatedEvents(index.events), "utf8");
    }

    return ok({
      report,
      output: input.format === "json" ? formatJsonReport(report) : formatMarkdownReport(report),
    });
  } catch (error) {
    return err({
      code: OperationErrorCode.ValidationError,
      message: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
