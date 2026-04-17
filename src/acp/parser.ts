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
 * Extract a stable canonical tool identity from provider metadata if present.
 * Claude's ACP bridge puts the underlying tool name at
 * `_meta.claudeCode.toolName`; other providers may add similar hooks.
 */
function readCanonicalToolName(update: Record<string, unknown>): string | undefined {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const claudeCode = (meta as Record<string, unknown>).claudeCode;
  if (typeof claudeCode !== "object" || claudeCode === null) return undefined;
  const toolName = (claudeCode as Record<string, unknown>).toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : undefined;
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
            // Tool-call frames require a usable id to key the event. Without
            // it we cannot merge updates — surface as raw instead of fabricating
            // a synthetic "" id that would collapse unrelated frames together.
            if (typeof u.toolCallId !== "string" || u.toolCallId.length === 0) {
              return {
                kind: "message",
                message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
              };
            }
            // Unknown status string → raw (don't silently drop schema-drift info
            // by coercing to "pending" or to "missing"). Absent status is fine.
            if (
              u.status !== undefined &&
              (typeof u.status !== "string" || !VALID_STATUSES.has(u.status as ToolCallStatus))
            ) {
              return {
                kind: "message",
                message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
              };
            }
            const toolCall: ToolCallEvent = { id: u.toolCallId };
            // Canonical identity first: `_meta.claudeCode.toolName` is stable
            // across updates on Claude's ACP bridge (e.g. "Read", "Bash").
            // Fall back to `title` when no canonical field exists.
            const canonicalName = readCanonicalToolName(u);
            if (canonicalName !== undefined) {
              toolCall.name = canonicalName;
            } else if (typeof u.title === "string" && u.title.length > 0) {
              toolCall.name = u.title;
            }
            // Always preserve title separately — it mutates for display ("Read
            // /etc/hostname", shell command text) and consumers may want it.
            if (typeof u.title === "string" && u.title.length > 0) {
              toolCall.title = u.title;
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
// AcpParser — broadcast Messages from a Readable, resolves a Result
// ---------------------------------------------------------------------------
//
// Reading: eager. The parser begins consuming the stream immediately on
// construction and resolves `result` as soon as a terminal frame arrives,
// regardless of whether any consumer iterates `messages`. This keeps turn
// lifecycle independent of consumer liveness (see docs/superpowers/specs/...
// § "Slow consumer / backpressure").
//
// Fan-out: the `messages` AsyncIterable is a broadcast stream. Every call to
// `[Symbol.asyncIterator]()` creates a fresh subscriber with its own queue;
// each Message parsed from the stream is delivered to every active subscriber.
// Late joiners (subscribing mid-stream) see messages from their join point
// onwards and end-of-stream if the turn has already settled.
//
// Backpressure: each subscriber has an independent bounded queue. When a
// subscriber falls more than MAX_SUBSCRIBER_BUFFER messages behind, newly
// parsed messages are dropped for THAT subscriber (a warning is logged to
// stderr). The background reader still advances for other subscribers and the
// result resolver — one slow consumer cannot stall the turn.

const EOF_RESULT: Omit<Result, "turnId"> = {
  stopReason: "error",
  error: { code: "acpx_exit", message: "stream closed before result" },
};

/** Per-subscriber cap before we start dropping messages. */
const MAX_SUBSCRIBER_BUFFER = 8192;

class AcpSubscriber implements AsyncIterator<Message> {
  private readonly queue: Message[] = [];
  private waiters: Array<(r: IteratorResult<Message>) => void> = [];
  private dropped = 0;
  private overflowEmitted = false;
  private finished = false;
  private readonly onDetach: (() => void) | undefined;

  constructor(opts?: { onDetach?: () => void }) {
    this.onDetach = opts?.onDetach;
  }

  push(message: Message, turnId: string): void {
    // Hard no-op once finished — prevents zombie subscribers from receiving
    // messages after the consumer has called return()/break'd out of for-await.
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: message, done: false });
      return;
    }
    if (this.queue.length >= MAX_SUBSCRIBER_BUFFER) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        process.stderr.write(
          `[acp-parser] subscriber buffer full (${MAX_SUBSCRIBER_BUFFER}); dropped ${this.dropped} messages so far\n`,
        );
      }
      // Emit one in-band overflow marker so the consumer sees the drop.
      // Later drops update the counter but don't re-emit (avoid spamming).
      if (!this.overflowEmitted) {
        this.overflowEmitted = true;
        const marker: Message = {
          kind: "raw",
          turnId,
          acpMethod: "_overflow",
          params: { droppedAtLeast: 1 },
        };
        // Replace the tail so the marker is visible when the consumer eventually drains.
        this.queue[this.queue.length - 1] = marker;
      }
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      w({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<Message>> {
    const value = this.queue.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.finished) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<Message>> {
    // Detach before finishing so any race with a concurrent broadcast() call
    // finds the subscriber gone.
    this.onDetach?.();
    this.finish();
    return Promise.resolve({ value: undefined, done: true });
  }
}

export class AcpParser {
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;

  private readonly subscribers: Set<AcpSubscriber> = new Set();
  private streamFinished = false;
  private resolveResult!: (r: Result) => void;
  private readonly turnId: string;

  constructor({
    sessionId: _sessionId,
    turnId,
    stream,
  }: {
    sessionId: string;
    turnId: string;
    stream: Readable;
  }) {
    this.turnId = turnId;
    this.result = new Promise<Result>((resolve) => {
      this.resolveResult = resolve;
    });

    // Start eager background read — completion is independent of `messages` consumption.
    void this._readStream(stream, turnId);

    this.messages = {
      [Symbol.asyncIterator]: (): AsyncIterator<Message> => {
        if (this.streamFinished) {
          const finished = new AcpSubscriber();
          finished.finish();
          return finished;
        }
        const sub: AcpSubscriber = new AcpSubscriber({
          onDetach: () => {
            this.subscribers.delete(sub);
          },
        });
        this.subscribers.add(sub);
        return sub;
      },
    };
  }

  private broadcast(message: Message): void {
    for (const sub of this.subscribers) {
      sub.push(message, this.turnId);
    }
  }

  private finish(result: Result): void {
    this.resolveResult(result);
    this.streamFinished = true;
    const subs = Array.from(this.subscribers);
    this.subscribers.clear();
    for (const sub of subs) {
      sub.finish();
    }
  }

  private async _readStream(stream: Readable, turnId: string): Promise<void> {
    let buffer = "";
    let settled = false;

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
            settled = true;
            this.finish({ ...parsed.result, turnId });
            return;
          }
          this.broadcast(parsed.message);
        }
      }

      // Flush any trailing content without a newline
      if (buffer.trim().length > 0) {
        const parsed = parseAcpLine(buffer.trim(), turnId);
        if (parsed.kind === "result") {
          settled = true;
          this.finish({ ...parsed.result, turnId });
          return;
        }
        this.broadcast(parsed.message);
      }
    } catch (err) {
      // Stream error — surface as a terminal error result.
      settled = true;
      this.finish({
        turnId,
        stopReason: "error",
        error: {
          code: "stream_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    } finally {
      if (!settled) {
        this.finish({ ...EOF_RESULT, turnId });
      }
    }
  }
}
