import { normalizeEventTypeName } from "../match.js";
import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";
import { parseAcpxLine } from "./acpx.js";

export function parseCodexLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return raw(line, path, lineNumber, `line ${lineNumber}: non-object Codex record kept as RAW`);
    }

    const record = parsed as Record<string, unknown>;
    if (record.jsonrpc !== undefined || record.method === "session/update") {
      return parseAcpxLine(line, path, lineNumber, TrajectoryRuntime.Codex);
    }

    return {
      events: [
        {
          type: inferType(record),
          runtime: TrajectoryRuntime.Codex,
          timestamp: stringField(record, "timestamp"),
          sessionId: stringField(record, "sessionId") ?? stringField(record, "session_id"),
          agentId: stringField(record, "agentId") ?? stringField(record, "agent_id"),
          spanId:
            stringField(record, "spanId") ??
            stringField(record, "span_id") ??
            stringField(record, "call_id") ??
            stringField(record, "callId"),
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
    return raw(line, path, lineNumber, `line ${lineNumber}: non-JSON Codex output kept as RAW`);
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
        runtime: TrajectoryRuntime.Codex,
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
  if (explicit === undefined) {
    return TrajectoryEventType.Raw;
  }

  const alias = codexAlias(explicit);
  if (alias !== undefined) {
    return alias;
  }

  return normalizeEventTypeName(explicit) ?? TrajectoryEventType.Raw;
}

function codexAlias(value: string): ParsedTrajectoryEvent["type"] | undefined {
  switch (value.trim().toLowerCase()) {
    case "agent_start":
      return TrajectoryEventType.AgentStart;
    case "assistant_message":
      return TrajectoryEventType.AssistantMessage;
    case "tool_call":
      return TrajectoryEventType.ToolCall;
    case "tool_result":
      return TrajectoryEventType.ToolResult;
    default:
      return undefined;
  }
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
