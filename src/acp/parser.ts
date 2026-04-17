/**
 * Pure NDJSON → typed Message parser for ACP (Agent Client Protocol) streams.
 * See docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 *
 * Wire shape note: acpx nests sessionUpdate under params.update.sessionUpdate,
 * NOT params.sessionUpdate. All parsing here matches the observed wire shape.
 */

import type { Readable } from "node:stream";
import type { Message, Result, TokenUsage, ToolCall } from "./types.js";

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export type ParsedLine = { kind: "message"; message: Message } | { kind: "result"; result: Result };

// ---------------------------------------------------------------------------
// Helper: normalize tool_call status
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<ToolCall["status"]>([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

function normalizeStatus(raw: unknown): ToolCall["status"] {
  if (typeof raw === "string" && VALID_STATUSES.has(raw as ToolCall["status"])) {
    return raw as ToolCall["status"];
  }
  return "pending";
}

// ---------------------------------------------------------------------------
// Helper: map usage_update → TokenUsage
// ---------------------------------------------------------------------------

function parseTokenUsage(update: Record<string, unknown>): TokenUsage {
  // Codex uses: used, size
  // Claude adds: cost
  // Neither shape maps directly to TokenUsage fields — best-effort mapping:
  //   used  → outputTokens (tokens consumed in this turn)
  //   size  → inputTokens  (context window used / capacity)
  //   Claude's result.usage.inputTokens / outputTokens / cachedReadTokens / cachedWriteTokens
  //   are on the final result frame, not the usage_update frame.

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  return {
    inputTokens: num(update.size),
    outputTokens: num(update.used),
  };
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
      const stopReason = r.stopReason;
      if (
        stopReason === "end_turn" ||
        stopReason === "max_tokens" ||
        stopReason === "cancelled" ||
        stopReason === "error"
      ) {
        return {
          kind: "result",
          result: { turnId, stopReason },
        };
      }
    }
    // result frame with unexpected shape — treat as raw message
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
            const name = typeof u.title === "string" ? u.title : sessionUpdate;
            const status = normalizeStatus(u.status);
            const input: unknown = u.rawInput ?? {};
            const toolCall: ToolCall = { id, name, status, input };

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
                usage: parseTokenUsage(u),
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
