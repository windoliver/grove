import { normalizeEventTypeName } from "../match.js";
import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";

export function parseSubprocessLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return raw(line, path, lineNumber, `line ${lineNumber}: non-object JSONL record kept as RAW`);
    }

    const record = parsed as Record<string, unknown>;
    const type = inferType(record);
    return {
      events: [
        {
          type,
          runtime: TrajectoryRuntime.Subprocess,
          timestamp: stringField(record, "timestamp"),
          spanId: stringField(record, "spanId") ?? stringField(record, "span_id"),
          parentSpanId:
            stringField(record, "parentSpanId") ?? stringField(record, "parent_span_id"),
          tool: stringField(record, "tool") ?? stringField(record, "tool_name"),
          status: stringField(record, "status"),
          input: record.input,
          output: record.output,
          message: stringField(record, "message") ?? stringField(record, "text"),
          error: stringField(record, "error"),
          raw: record,
          source: { path, line: lineNumber },
        },
      ],
      warnings: [],
    };
  } catch {
    return raw(
      line,
      path,
      lineNumber,
      `line ${lineNumber}: non-JSON subprocess output kept as RAW`,
    );
  }
}

function raw(
  line: string,
  path: string,
  lineNumber: number,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      {
        type: TrajectoryEventType.Raw,
        runtime: TrajectoryRuntime.Subprocess,
        message: line,
        error: warning,
        raw: line,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [warning],
  };
}

function inferType(record: Readonly<Record<string, unknown>>): ParsedTrajectoryEvent["type"] {
  const explicit =
    stringField(record, "event") ?? stringField(record, "type") ?? stringField(record, "kind");
  if (explicit !== undefined) {
    return normalizeEventTypeName(explicit) ?? TrajectoryEventType.Raw;
  }

  const stream = stringField(record, "stream");
  if (stream === "stdout" || stream === "stderr") {
    return TrajectoryEventType.AssistantMessage;
  }

  if (record.command !== undefined || record.pid !== undefined) {
    return TrajectoryEventType.AgentStart;
  }

  return TrajectoryEventType.Raw;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
