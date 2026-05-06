import type { ParsedTrajectoryEvent, TrajectoryRuntime } from "../types.js";
import { TrajectoryEventType } from "../types.js";

export function parseAcpxLine(
  line: string,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return raw(
        line,
        path,
        lineNumber,
        runtime,
        `line ${lineNumber}: non-object ACP record kept as RAW`,
      );
    }

    const record = parsed as Record<string, unknown>;
    if (record.error !== undefined) {
      return {
        events: [
          baseEvent(TrajectoryEventType.PermissionDenied, runtime, path, lineNumber, {
            error: errorMessage(record.error),
            raw: record,
          }),
        ],
        warnings: [],
      };
    }

    const result = objectField(record, "result");
    const sessionId = stringField(result, "sessionId");
    if (sessionId !== undefined) {
      return {
        events: [
          baseEvent(TrajectoryEventType.AgentStart, runtime, path, lineNumber, {
            sessionId,
            raw: record,
          }),
        ],
        warnings: [],
      };
    }

    if (record.method === "session/update") {
      return parseSessionUpdate(record, path, lineNumber, runtime);
    }

    return { events: [], warnings: [] };
  } catch {
    return raw(
      line,
      path,
      lineNumber,
      runtime,
      `line ${lineNumber}: non-JSON ACP output kept as RAW`,
    );
  }
}

function parseSessionUpdate(
  record: Readonly<Record<string, unknown>>,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  const params = objectField(record, "params");
  const update = objectField(params, "update");
  const sessionUpdate = stringField(update, "sessionUpdate");
  const sessionId = stringField(params, "sessionId");

  if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "user_message_chunk") {
    return {
      events: [
        baseEvent(TrajectoryEventType.AssistantMessage, runtime, path, lineNumber, {
          sessionId,
          message: contentText(update.content),
          raw: record,
        }),
      ],
      warnings: [],
    };
  }

  if (sessionUpdate === "tool_call") {
    return {
      events: [
        baseEvent(TrajectoryEventType.ToolCall, runtime, path, lineNumber, {
          sessionId,
          spanId: stringField(update, "toolCallId"),
          tool: toolName(update),
          status: stringField(update, "status"),
          input: update.rawInput,
          raw: record,
        }),
      ],
      warnings: [],
    };
  }

  if (sessionUpdate === "tool_call_update") {
    return {
      events: [
        baseEvent(TrajectoryEventType.ToolResult, runtime, path, lineNumber, {
          sessionId,
          spanId: stringField(update, "toolCallId"),
          tool: toolName(update),
          status: stringField(update, "status"),
          input: update.rawInput,
          output: update.rawOutput ?? claudeToolOutput(update),
          raw: record,
        }),
      ],
      warnings: [],
    };
  }

  if (sessionUpdate === "permission_request") {
    return {
      events: [
        baseEvent(TrajectoryEventType.PermissionWait, runtime, path, lineNumber, {
          sessionId,
          spanId:
            stringField(update, "toolCallId") ??
            stringField(update, "permissionRequestId") ??
            stringField(update, "id"),
          tool: toolName(update) ?? stringField(update, "tool"),
          input: update.input ?? update,
          raw: record,
        }),
      ],
      warnings: [],
    };
  }

  const warning = `line ${lineNumber}: unmapped ACP session update kept as RAW`;
  return {
    events: [
      baseEvent(TrajectoryEventType.Raw, runtime, path, lineNumber, {
        error: warning,
        raw: record,
      }),
    ],
    warnings: [warning],
  };
}

function baseEvent(
  type: ParsedTrajectoryEvent["type"],
  runtime: TrajectoryRuntime,
  path: string,
  lineNumber: number,
  fields: Omit<Partial<ParsedTrajectoryEvent>, "type" | "runtime" | "source">,
): ParsedTrajectoryEvent {
  return {
    type,
    runtime,
    ...fields,
    source: { path, line: lineNumber },
  };
}

function raw(
  line: string,
  path: string,
  lineNumber: number,
  runtime: TrajectoryRuntime,
  warning: string,
): { readonly events: readonly ParsedTrajectoryEvent[]; readonly warnings: readonly string[] } {
  return {
    events: [
      baseEvent(TrajectoryEventType.Raw, runtime, path, lineNumber, {
        message: line,
        error: warning,
        raw: line,
      }),
    ],
    warnings: [warning],
  };
}

function objectField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function toolName(update: Readonly<Record<string, unknown>>): string | undefined {
  const meta = objectField(update, "_meta");
  const claudeCode = objectField(meta, "claudeCode");
  return stringField(claudeCode, "toolName") ?? stringField(update, "title");
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return stringField(record, "text");
}

function claudeToolOutput(update: Readonly<Record<string, unknown>>): unknown {
  const meta = objectField(update, "_meta");
  const claudeCode = objectField(meta, "claudeCode");
  const response = objectField(claudeCode, "toolResponse");
  if (Object.keys(response).length > 0) {
    return response;
  }
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  return stringField(record, "message") ?? stringField(record, "code");
}
