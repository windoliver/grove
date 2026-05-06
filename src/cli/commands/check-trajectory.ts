import { parseArgs } from "node:util";
import type { CheckTrajectoryInput } from "../../core/operations/index.js";
import { checkTrajectoryOperation } from "../../core/operations/index.js";
import type { ReportFormat, TrajectoryRuntimeInput } from "../../trajectory/types.js";

const DEFAULT_SPEC_PATH = "spec/trajectory/common.yaml";
const VALID_RUNTIMES = [
  "auto",
  "acpx",
  "codex",
  "claude-stream-json",
  "subprocess",
  "unknown",
] as const;
const VALID_FORMATS = ["markdown", "json"] as const;

type Writer = (line: string) => void;

export function parseCheckTrajectoryArgs(argv: readonly string[]): CheckTrajectoryInput {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      transcript: { type: "string" },
      spec: { type: "string", multiple: true },
      runtime: { type: "string", default: "auto" },
      format: { type: "string", default: "markdown" },
      "annotated-log": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.transcript === undefined) {
    throw new Error("--transcript is required");
  }
  if (!isTrajectoryRuntimeInput(values.runtime)) {
    throw new Error(`Invalid --runtime: ${values.runtime}`);
  }
  if (!isReportFormat(values.format)) {
    throw new Error(`Invalid --format: ${values.format}`);
  }

  return {
    transcriptPath: values.transcript,
    specPaths: values.spec ?? [DEFAULT_SPEC_PATH],
    runtime: values.runtime,
    format: values.format,
    annotatedLogPath: values["annotated-log"],
  };
}

export async function runCheckTrajectory(
  input: CheckTrajectoryInput,
  writer: Writer = console.log,
): Promise<void> {
  const result = await checkTrajectoryOperation(input);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  writer(result.value.output.trimEnd());
}

function isTrajectoryRuntimeInput(value: string | undefined): value is TrajectoryRuntimeInput {
  return value !== undefined && VALID_RUNTIMES.includes(value as (typeof VALID_RUNTIMES)[number]);
}

function isReportFormat(value: string | undefined): value is ReportFormat {
  return value !== undefined && VALID_FORMATS.includes(value as ReportFormat);
}
