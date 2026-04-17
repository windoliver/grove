/**
 * Pure NDJSON → typed Message parser for ACP (Agent Client Protocol) streams.
 * See docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 *
 * Wire shape note: acpx nests sessionUpdate under params.update.sessionUpdate,
 * NOT params.sessionUpdate. All parsing here matches the observed wire shape.
 */

import type { Readable } from "node:stream";
import type {
  Message,
  Result,
  StopReason,
  TokenUsage,
  ToolCallEvent,
  ToolCallStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export type ParsedLine = { kind: "message"; message: Message } | { kind: "result"; result: Result };

// ---------------------------------------------------------------------------
// Helper: normalize tool_call status
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<ToolCallStatus>(["pending", "in_progress", "completed", "failed"]);

/** Returns the status if it's a known ToolCallStatus, else undefined (signals "not in this frame"). */
function normalizeStatus(raw: unknown): ToolCallStatus | undefined {
  if (typeof raw === "string" && VALID_STATUSES.has(raw as ToolCallStatus)) {
    return raw as ToolCallStatus;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers: map ACP usage shapes → TokenUsage
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Advisory progress snapshot from a `usage_update` frame. These fields are
 * context-meter style (used/size of the rolling window, cost so far) and are
 * NOT canonical per-turn token counts. Compaction prefers `result.usage` when
 * both are present.
 */
function parseAdvisoryUsage(update: Record<string, unknown>): TokenUsage {
  const out: TokenUsage = {
    inputTokens: num(update.size),
    outputTokens: num(update.used),
  };
  if (update.cost && typeof update.cost === "object") {
    const c = update.cost as Record<string, unknown>;
    if (typeof c.amount === "number" && typeof c.currency === "string") {
      out.cost = { amount: c.amount, currency: c.currency };
    }
  }
  return out;
}

/**
 * Canonical per-turn token accounting from a JSON-RPC `result.usage` object.
 * Maps the fields observed on Claude's ACP bridge; extra fields are ignored.
 */
function parseResultUsage(usage: Record<string, unknown>): TokenUsage {
  const out: TokenUsage = {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
  };
  if (usage.cachedReadTokens !== undefined) {
    out.cachedReadTokens = num(usage.cachedReadTokens);
  }
  if (usage.cachedWriteTokens !== undefined) {
    out.cachedWriteTokens = num(usage.cachedWriteTokens);
  }
  if (usage.totalTokens !== undefined) {
    out.totalTokens = num(usage.totalTokens);
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseAcpLine — pure, synchronous, never throws
// ---------------------------------------------------------------------------

export function parseAcpLine(line: string, turnId: string): ParsedLine {
  // --- Parse JSON ---
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return {
      kind: "message",
      message: {
        kind: "raw",
        turnId,
        acpMethod: "_parseError",
        params: line,
      },
    };
  }

  if (typeof frame !== "object" || frame === null) {
    return {
      kind: "message",
      message: { kind: "raw", turnId, acpMethod: "_parseError", params: line },
    };
  }

  const f = frame as Record<string, unknown>;

  // --- JSON-RPC result frame ---
  if ("result" in f) {
    const res = f.result;
    if (typeof res === "object" && res !== null) {
      const r = res as Record<string, unknown>;
      if (typeof r.stopReason === "string" && r.stopReason.length > 0) {
        const result: Result = { turnId, stopReason: r.stopReason as StopReason };
        if (r.usage && typeof r.usage === "object") {
          result.usage = parseResultUsage(r.usage as Record<string, unknown>);
        }
        return { kind: "result", result };
      }
    }
    // result frame without a usable stopReason — treat as raw message
    return {
      kind: "message",
      message: { kind: "raw", turnId, acpMethod: "_result", params: f.result },
    };
  }

  // --- JSON-RPC error frame ---
  if ("error" in f) {
    const err = f.error;
    if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      return {
        kind: "result",
        result: {
          turnId,
          stopReason: "error",
          error: {
            code: typeof e.code === "string" ? e.code : String(e.code ?? "unknown"),
            message: typeof e.message === "string" ? e.message : String(e.message ?? ""),
          },
        },
      };
    }
  }

  // --- session/update frame ---
  const method = f.method;
  if (method === "session/update") {
    const params = f.params;
    if (typeof params === "object" && params !== null) {
      const p = params as Record<string, unknown>;
      const update = p.update;
      if (typeof update === "object" && update !== null) {
        const u = update as Record<string, unknown>;
        const sessionUpdate = u.sessionUpdate;

        if (typeof sessionUpdate !== "string") {
          return {
            kind: "message",
            message: { kind: "raw", turnId, acpMethod: "session/update", params: update },
          };
        }

        switch (sessionUpdate) {
          case "agent_message_chunk": {
            const content = u.content as Record<string, unknown> | undefined;
            if (content?.type === "text" && typeof content.text === "string") {
              return {
                kind: "message",
                message: { kind: "text", turnId, text: content.text, chunk: true },
              };
            }
            // non-text content variant — raw
            return {
              kind: "message",
              message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
            };
          }

          case "agent_thought_chunk": {
            const content = u.content as Record<string, unknown> | undefined;
            if (content?.type === "text" && typeof content.text === "string") {
              return {
                kind: "message",
                message: { kind: "thinking", turnId, text: content.text, chunk: true },
              };
            }
            return {
              kind: "message",
              message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
            };
          }

          case "tool_call":
          case "tool_call_update": {
            const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
            const toolCall: ToolCallEvent = { id };
            if (typeof u.title === "string" && u.title.length > 0) {
              toolCall.name = u.title;
            }
            const status = normalizeStatus(u.status);
            if (status !== undefined) {
              toolCall.status = status;
            }
            if (u.rawInput !== undefined) {
              toolCall.input = u.rawInput;
            }
            if ("rawOutput" in u && u.rawOutput !== undefined) {
              toolCall.output = u.rawOutput;
            }
            return {
              kind: "message",
              message: { kind: "tool_call", turnId, toolCall },
            };
          }

          case "usage_update": {
            return {
              kind: "message",
              message: {
                kind: "token_usage",
                turnId,
                usage: parseAdvisoryUsage(u),
              },
            };
          }

          default: {
            // Forward-compat: unknown sessionUpdate kinds → raw
            return {
              kind: "message",
              message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
            };
          }
        }
      }
    }
    // session/update with unexpected params structure
    return {
      kind: "message",
      message: { kind: "raw", turnId, acpMethod: "session/update", params: f.params },
    };
  }

  // --- All other JSON-RPC frames (initialize, session/new, session/prompt, etc.) → raw ---
  return {
    kind: "message",
    message: {
      kind: "raw",
      turnId,
      acpMethod: typeof method === "string" ? method : "_unknown",
      params: f.params ?? f,
    },
  };
}

// ---------------------------------------------------------------------------
// AcpParser — streams Messages from a Readable, resolves a Result
// ---------------------------------------------------------------------------

const EOF_RESULT: Result = {
  turnId: "",
  stopReason: "error",
  error: { code: "acpx_exit", message: "stream closed before result" },
};

export class AcpParser {
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;

  constructor({
    sessionId: _sessionId,
    turnId,
    stream,
  }: {
    sessionId: string;
    turnId: string;
    stream: Readable;
  }) {
    // Shared state between the two async consumers
    let resolveResult!: (r: Result) => void;
    this.result = new Promise<Result>((resolve) => {
      resolveResult = resolve;
    });

    // Build the messages async generator + wire up the result resolver
    this.messages = AcpParser._makeMessages(stream, turnId, resolveResult);
  }

  private static async *_makeMessages(
    stream: Readable,
    turnId: string,
    resolveResult: (r: Result) => void,
  ): AsyncGenerator<Message> {
    let buffer = "";
    let resultSeen = false;

    try {
      for await (const chunk of stream) {
        buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

        // Split on newlines — emit complete lines
        const lines = buffer.split("\n");
        // Last element is incomplete (no trailing newline yet) — keep in buffer
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;

          const parsed = parseAcpLine(line, turnId);
          if (parsed.kind === "result") {
            // Attach turnId (it was set inside parseAcpLine but may need override for EOF)
            const result = { ...parsed.result, turnId };
            resultSeen = true;
            resolveResult(result);
            return; // done
          }
          yield parsed.message;
        }
      }

      // Flush any trailing content without newline
      if (buffer.trim()) {
        const parsed = parseAcpLine(buffer.trim(), turnId);
        if (parsed.kind === "result") {
          resolveResult({ ...parsed.result, turnId });
          return;
        }
        yield parsed.message;
      }
    } finally {
      if (!resultSeen) {
        resolveResult({ ...EOF_RESULT, turnId });
      }
    }
  }
}
