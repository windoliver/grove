import type { ParsedTrajectoryEvent } from "../types.js";
import { TrajectoryEventType, TrajectoryRuntime } from "../types.js";

export function parseClaudeStreamJsonLine(
  line: string,
  path: string,
  lineNumber: number,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return raw(
        line,
        path,
        lineNumber,
        `line ${lineNumber}: non-object Claude stream-json record kept as RAW`,
      );
    }

    const record = parsed as Record<string, unknown>;
    return {
      events: [eventFromRecord(record, path, lineNumber)],
      warnings: [],
    };
  } catch {
    return raw(
      line,
      path,
      lineNumber,
      `line ${lineNumber}: non-JSON Claude stream-json output kept as RAW`,
    );
  }
}

function eventFromRecord(
  record: Readonly<Record<string, unknown>>,
  path: string,
  lineNumber: number,
): ParsedTrajectoryEvent {
  const type = stringField(record, "type");
  const spanId =
    stringField(record, "id") ??
    stringField(record, "tool_use_id") ??
    stringField(record, "tool_call_id") ??
    stringField(record, "spanId") ??
    stringField(record, "span_id");
  const parentSpanId =
    stringField(record, "parent_tool_use_id") ??
    stringField(record, "parentSpanId") ??
    stringField(record, "parent_span_id");
  const tool =
    stringField(record, "name") ?? stringField(record, "tool") ?? stringField(record, "tool_name");

  return {
    type: inferType(record, type, tool, parentSpanId),
    runtime: TrajectoryRuntime.ClaudeStreamJson,
    timestamp: stringField(record, "timestamp"),
    spanId,
    parentSpanId,
    tool,
    status: stringField(record, "status"),
    input: record.input,
    output: record.output ?? record.content,
    message: assistantMessage(record),
    error: stringField(record, "error"),
    raw: record,
    source: { path, line: lineNumber },
  };
}

function inferType(
  record: Readonly<Record<string, unknown>>,
  type: string | undefined,
  tool: string | undefined,
  parentSpanId: string | undefined,
): ParsedTrajectoryEvent["type"] {
  if (type === "assistant") {
    return TrajectoryEventType.AssistantMessage;
  }

  if (type === "tool_use" || type === "tool_call") {
    return isDelegationTool(tool) ? TrajectoryEventType.Delegation : TrajectoryEventType.ToolCall;
  }

  if (type === "tool_result") {
    return parentSpanId === undefined && hasDelegationReturnEvidence(record)
      ? TrajectoryEventType.DelegationReturn
      : TrajectoryEventType.ToolResult;
  }

  if (type === "permission_denied") {
    return TrajectoryEventType.PermissionDenied;
  }

  return TrajectoryEventType.Raw;
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
        runtime: TrajectoryRuntime.ClaudeStreamJson,
        message: line,
        error: warning,
        raw: line,
        source: { path, line: lineNumber },
      },
    ],
    warnings: [warning],
  };
}

function assistantMessage(record: Readonly<Record<string, unknown>>): string | undefined {
  const message = record.message;
  if (typeof message === "string") {
    return message;
  }

  if (!Array.isArray(message)) {
    return stringField(record, "text");
  }

  const parts: string[] = [];
  for (const part of message) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      continue;
    }
    const text = stringField(part as Record<string, unknown>, "text");
    if (text !== undefined) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

function isDelegationTool(tool: string | undefined): boolean {
  if (tool === undefined) {
    return false;
  }
  const normalized = tool.toLowerCase();
  return normalized === "task" || normalized.includes("subagent");
}

function hasDelegationReturnEvidence(record: Readonly<Record<string, unknown>>): boolean {
  return (
    hasDelegationText(record.content) ||
    hasDelegationText(record.message) ||
    hasDelegationText(record.tool) ||
    hasDelegationText(record.name) ||
    hasDelegationText(record.id)
  );
}

function hasDelegationText(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("delegation") ||
      normalized.includes("subagent") ||
      normalized.includes("task")
    );
  }

  if (Array.isArray(value)) {
    return value.some(hasDelegationText);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasDelegationText);
  }

  return false;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
