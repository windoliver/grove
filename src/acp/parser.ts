/**
 * Pure NDJSON → typed Message parser for ACP (Agent Client Protocol) streams.
 * See docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 *
 * Wire shape note: acpx nests sessionUpdate under params.update.sessionUpdate,
 * NOT params.sessionUpdate. All parsing here matches the observed wire shape.
 */

import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
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

// ---------------------------------------------------------------------------
// Helpers: map ACP usage shapes → TokenUsage
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
 * Returns undefined when required canonical fields are missing/invalid so
 * callers don't silently fabricate zero-token usage under schema drift.
 */
function parseResultUsage(usage: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  const out: TokenUsage = {
    inputTokens,
    outputTokens,
  };
  const cachedReadTokens = finiteNumber(usage.cachedReadTokens);
  if (cachedReadTokens !== undefined) {
    out.cachedReadTokens = cachedReadTokens;
  }
  const cachedWriteTokens = finiteNumber(usage.cachedWriteTokens);
  if (cachedWriteTokens !== undefined) {
    out.cachedWriteTokens = cachedWriteTokens;
  }
  const totalTokens = finiteNumber(usage.totalTokens);
  if (totalTokens !== undefined) {
    out.totalTokens = totalTokens;
  }
  if (usage.cost && typeof usage.cost === "object") {
    const c = usage.cost as Record<string, unknown>;
    const amount = finiteNumber(c.amount);
    const currency =
      typeof c.currency === "string" && c.currency.length > 0 ? c.currency : undefined;
    if (amount !== undefined && currency !== undefined) {
      out.cost = { amount, currency };
    }
  }
  return out;
}

/**
 * Session-binding signals extracted from a raw NDJSON line, without
 * committing to full parsing. Used by `AcpParser` during the bootstrap
 * window (before a trust anchor is established) to (a) track outgoing
 * `session/new`/`session/load` request ids, (b) bind on the matching
 * `result.sessionId` response, (c) quarantine `session/update` frames that
 * arrive before a binding, (d) let any other frame parse normally.
 *
 * Rationale (issue #319): the caller's grove label (`grove-<role>-<n>--...`)
 * does not match acpx's internal UUID, so we can't hard-bind at construction
 * time. Learning from the first `session/update` would let a foreign first
 * frame poison the binding. Learning from any `result.sessionId` would let
 * a foreign `result` frame poison the binding. Only by correlating a result
 * frame's id to a previously observed `session/new`/`session/load` request
 * id do we have a trusted anchor.
 */
type SessionBindingHint =
  | {
      readonly kind: "session-request";
      /** JSON-RPC request id — used to correlate with a later response. */
      readonly id: string | number;
    }
  | {
      readonly kind: "session-response";
      readonly id: string | number;
      /** Non-empty `result.sessionId` from a JSON-RPC result frame. */
      readonly sessionId: string;
    }
  | {
      readonly kind: "session-update";
      /** Raw params — preserved on quarantine for audit. */
      readonly params: unknown;
    }
  | { readonly kind: "other" };

/**
 * Canonicalize a JSON-RPC id to a string key. Tolerates providers or
 * intermediaries that normalize numeric ids to strings (or vice versa) so
 * that a request with `id: 0` still correlates to a response with `id: "0"`
 * — otherwise strict equality leaves the parser unbound and the turn fails
 * `session_unbound` under benign upstream drift (round 5 finding).
 */
function canonicalRpcId(id: string | number): string {
  return typeof id === "number" ? String(id) : id;
}

function peekSessionBindingHint(line: string): SessionBindingHint {
  try {
    const frame = JSON.parse(line) as unknown;
    if (typeof frame !== "object" || frame === null) return { kind: "other" };
    const f = frame as Record<string, unknown>;
    const id = f.id;
    const hasRpcId = typeof id === "string" || typeof id === "number";

    // Outgoing `session/new` or `session/load` request: these are authored
    // by acpx (or by grove through acpx) and their response `id` is the
    // correlation token we need to trust a later `result.sessionId`.
    const method = f.method;
    if (
      hasRpcId &&
      (method === "session/new" || method === "session/load") &&
      f.result === undefined
    ) {
      return { kind: "session-request", id: id as string | number };
    }

    // JSON-RPC result frame with a non-empty string sessionId. Only trusted
    // if its id matches a previously seen session-request (checked upstream).
    const r = f.result;
    if (hasRpcId && typeof r === "object" && r !== null) {
      const sid = (r as Record<string, unknown>).sessionId;
      if (typeof sid === "string" && sid.length > 0) {
        return { kind: "session-response", id: id as string | number, sessionId: sid };
      }
    }

    if (method === "session/update") {
      return { kind: "session-update", params: f.params };
    }

    return { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

// ---------------------------------------------------------------------------
// parseAcpLine — pure, synchronous, never throws
// ---------------------------------------------------------------------------

export function parseAcpLine(line: string, turnId: string, sessionId?: string): ParsedLine {
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
          const usage = parseResultUsage(r.usage as Record<string, unknown>);
          if (usage !== undefined) {
            result.usage = usage;
          }
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
      // Session guard: if we know which session this parser is bound to,
      // REQUIRE params.sessionId to be a matching string. A multiplexed
      // stdio stream, stale provider output, or schema-drifted frame could
      // otherwise bleed foreign data into this turn's snapshot. Demote any
      // frame that doesn't present a valid matching sessionId (including
      // absent/non-string cases) to raw so auditors see the drift.
      if (
        sessionId !== undefined &&
        (typeof p.sessionId !== "string" || p.sessionId !== sessionId)
      ) {
        return {
          kind: "message",
          message: { kind: "raw", turnId, acpMethod: "_sessionMismatch", params: f.params },
        };
      }
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
            let validatedStatus: ToolCallStatus | undefined;
            if (u.status !== undefined) {
              if (typeof u.status !== "string" || !VALID_STATUSES.has(u.status as ToolCallStatus)) {
                return {
                  kind: "message",
                  message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
                };
              }
              validatedStatus = u.status as ToolCallStatus;
            }
            const toolCall: ToolCallEvent = { id: u.toolCallId };
            // Canonical identity ONLY: `_meta.claudeCode.toolName` is a
            // provider-authenticated field that is stable across updates
            // (e.g. "Read", "Bash"). Do NOT fall back to `title` — title is
            // mutable display text ("Read /etc/hostname", shell command) and
            // under version skew or a non-Claude provider could fragment
            // permission/audit decisions by routing what is really one tool
            // (e.g. Bash) across many synthetic "names". If no canonical
            // metadata is present, leave `name` undefined — the compactor
            // routes the call into incompleteToolCalls instead of fabricating
            // a canonical identity from untrusted display text.
            const canonicalName = readCanonicalToolName(u);
            if (canonicalName !== undefined) {
              toolCall.name = canonicalName;
            }
            // Always preserve title separately — display-only, may mutate.
            if (typeof u.title === "string" && u.title.length > 0) {
              toolCall.title = u.title;
            }
            if (validatedStatus !== undefined) {
              toolCall.status = validatedStatus;
            }
            if (u.rawInput !== undefined) {
              // Claude's initial `tool_call` frame carries `rawInput: {}` as a
              // placeholder; the canonical args arrive on a later
              // `tool_call_update`. If we accept the placeholder here, a
              // truncated turn (overflow, EOF, lost update) leaves us with a
              // tool call whose finalized `input` is `{}` — indistinguishable
              // from canonical data in an audit log. Treat empty-object
              // placeholders on the INITIAL frame as "not yet observed" so the
              // compactor routes the call into incompleteToolCalls until a
              // non-placeholder input arrives. Updates may still legitimately
              // set an empty object (rare but possible) — only the initial
              // placeholder is filtered.
              const isEmptyObjectPlaceholder =
                sessionUpdate === "tool_call" &&
                typeof u.rawInput === "object" &&
                u.rawInput !== null &&
                !Array.isArray(u.rawInput) &&
                Object.keys(u.rawInput as Record<string, unknown>).length === 0;
              if (!isEmptyObjectPlaceholder) {
                toolCall.input = u.rawInput;
              }
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

          case "permission_request": {
            const id = typeof u.id === "string" ? u.id : "";
            const tool = typeof u.tool === "string" ? u.tool : "";
            if (id.length === 0 || tool.length === 0) {
              // Missing identity — route to raw so auditors can inspect.
              return {
                kind: "message",
                message: { kind: "raw", turnId, acpMethod: sessionUpdate, params: update },
              };
            }
            return {
              kind: "message",
              message: {
                kind: "permission_request",
                turnId,
                request: { id, tool, input: u.input },
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

/**
 * Head-indexed FIFO. Using `Array.shift()` on a backlog of up to
 * MAX_SUBSCRIBER_BUFFER messages is O(N) per drain and O(N²) across a full
 * drain — large enough (8192² ≈ 67M) to show up as latency when an overflow-
 * class burst is finally read. `head` advances instead of reshifting; the
 * array periodically compacts when head drifts far from index 0.
 */
class AcpSubscriber implements AsyncIterator<Message> {
  private queue: Message[] = [];
  private head = 0;
  private waiters: Array<(r: IteratorResult<Message>) => void> = [];
  private dropped = 0;
  private finished = false;
  private readonly onDetach: (() => void) | undefined;

  constructor(opts?: { onDetach?: () => void }) {
    this.onDetach = opts?.onDetach;
  }

  /**
   * Seed replay/backlog messages into a brand-new subscriber before it is
   * exposed to callers. This is used for the parser's first-subscriber
   * start-of-turn replay path.
   */
  seedReplay(messages: readonly Message[], dropped: number): void {
    if (messages.length === 0) return;
    this.queue = messages.slice();
    this.head = 0;
    this.dropped = dropped;
  }

  private get size(): number {
    return this.queue.length - this.head;
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
    if (this.size >= MAX_SUBSCRIBER_BUFFER) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        process.stderr.write(
          `[acp-parser] subscriber buffer full (${MAX_SUBSCRIBER_BUFFER}); dropped ${this.dropped} messages so far\n`,
        );
      }
      const marker: Message = {
        kind: "raw",
        turnId,
        acpMethod: "_overflow",
        params: { droppedAtLeast: this.dropped },
      };
      const tail = this.queue[this.queue.length - 1];
      // Keep emitted messages immutable: never mutate an already-enqueued
      // marker object in place. If an overflow marker is already the tail,
      // replace it with a fresh frame carrying the latest drop count.
      if (tail && tail.kind === "raw" && tail.acpMethod === "_overflow") {
        this.queue[this.queue.length - 1] = marker;
      } else if (this.size === MAX_SUBSCRIBER_BUFFER) {
        // First overflow while at exact capacity: append marker so a
        // subscriber can observe truncation in-band.
        this.queue.push(marker);
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
    if (this.head < this.queue.length) {
      const value = this.queue[this.head] as Message;
      // Drop the reference from the backing array so retained messages don't
      // pin their payloads alive after they've been handed to the consumer.
      this.queue[this.head] = undefined as unknown as Message;
      this.head += 1;
      if (this.head === this.queue.length) {
        // Fully drained — reset in O(1) so the backing array doesn't grow
        // unbounded over a long-running subscriber.
        this.queue.length = 0;
        this.head = 0;
      } else if (this.head > 256 && this.head * 2 > this.queue.length) {
        // Half-drained — periodic compaction keeps the backing array size
        // proportional to live items without paying O(N) every drain.
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
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
    // Discard backlog — the consumer has explicitly unsubscribed and must not
    // receive more events, even from what was already in-flight.
    this.queue = [];
    this.head = 0;
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
  /**
   * Session binding used to demote foreign `session/update` frames to
   * `_sessionMismatch`. Set either:
   *   - at construction time (explicit hard-bind — tests, multiplexed callers),
   *   - OR at runtime via request/response correlation: we see
   *     `{method:"session/new"|"session/load", id:N}` pass through the
   *     stream, track N in `pendingSessionRequestIds`, and bind when a
   *     later `{id:N, result:{sessionId:"..."}}` frame arrives. Any other
   *     `result.sessionId` (foreign, uncorrelated) is NOT trusted.
   *
   * See issue #319. The caller-supplied grove label (`grove-<role>-<n>--...`)
   * does not match acpx's internal UUID, so we can't hard-bind upfront.
   */
  private sessionId: string | undefined;
  /**
   * Ids of `session/new`/`session/load` requests seen so far — trusted
   * anchors. Stored as canonical string keys (via `canonicalRpcId`) so
   * correlation tolerates provider id-type skew (`0` vs `"0"`): both sides
   * of the round-trip resolve to the same key.
   */
  private readonly pendingSessionRequestIds: Set<string> = new Set();
  /**
   * True iff at least one `session/update` arrived while the parser was
   * unbound (before any correlated handshake had landed). Drives fail-closed:
   * any quarantined update is a data-loss signal — we override the terminal
   * stopReason to `error` so the caller can't mistake a silent truncation
   * for a successful run, whether the binding never happened OR arrived
   * later (late-binding silent truncation is the round-4 finding).
   */
  private sawUnboundSessionUpdate = false;
  /**
   * True iff a second correlated handshake arrived with a sessionId that
   * differs from an already-locked binding — i.e. a foreign handshake
   * reached us before the real one and poisoned the binding. Drives
   * fail-closed so the caller does NOT receive a `stopReason: end_turn`
   * that papers over cross-session contamination (round 4 finding).
   */
  private sessionBindingAmbiguous = false;
  /**
   * True iff the current `sessionId` was learned via an in-band handshake
   * (round 3 correlation path). False when bound at construction time by
   * an explicit caller-supplied sessionId — in that case the caller is
   * the trust authority, so foreign `result.sessionId` noise on a
   * multiplexed/shared stream must NOT escalate to `session_ambiguous`.
   * See round-5 finding on explicit-bound regression.
   */
  private sessionBoundFromHandshake = false;

  /**
   * Start-of-turn replay buffer. The parser reads eagerly on construction,
   * so a short turn can fully complete before any caller subscribes to
   * `messages`. Without a backlog, those pre-subscription events would be
   * lost and the audit log for a fast turn would look empty. This buffer
   * holds all broadcast messages until the FIRST subscriber attaches, then
   * drains into that subscriber so it sees the turn from the start.
   *
   * Only the first subscriber gets the replay — subsequent subscribers
   * still observe live-only, consistent with the broadcast semantics
   * documented in the class header. Bounded by MAX_SUBSCRIBER_BUFFER so a
   * runaway provider with no attached consumer cannot OOM the host.
   */
  private readonly preSubscriptionBuffer: Message[] = [];
  private firstSubscriberAttached = false;
  private preDropped = 0;

  /**
   * True as soon as a terminal result has been produced. Flipped synchronously
   * inside `finish()` — do NOT rely on `.then()` handlers on `result` for this
   * signal, because a caller running in the same tick as the resolution
   * would still observe `false` there. Used by AcpxTurnImpl to gate cancel().
   */
  get settled(): boolean {
    return this.streamFinished;
  }

  /**
   * The acpx-internal wire sessionId this parser is (or became) bound to.
   * Undefined if no binding was ever established. Read by the runtime
   * after turn settle to propagate the learned id to the next turn's
   * parser (issue #319).
   */
  get wireSessionId(): string | undefined {
    return this.sessionId;
  }

  constructor({
    sessionId,
    turnId,
    stream,
  }: {
    /**
     * Optional. When provided, session/update frames whose params.sessionId
     * does not match are demoted to raw _sessionMismatch — defense for
     * multiplexed/shared streams. Per-turn acpx stdout is single-session and
     * acpx emits its own internal UUID (not the caller's label), so callers
     * wrapping a single acpx child (AcpxTurnImpl) should leave this undefined
     * to avoid demoting every legitimate frame. See issue #319.
     */
    sessionId?: string | undefined;
    turnId: string;
    stream: Readable;
  }) {
    this.turnId = turnId;
    this.sessionId = sessionId;
    this.result = new Promise<Result>((resolve) => {
      this.resolveResult = resolve;
    });

    // Start eager background read — completion is independent of `messages` consumption.
    void this._readStream(stream, turnId);

    this.messages = {
      [Symbol.asyncIterator]: (): AsyncIterator<Message> => {
        const sub: AcpSubscriber = new AcpSubscriber({
          onDetach: () => {
            this.subscribers.delete(sub);
          },
        });
        // First subscriber gets the full start-of-turn replay, regardless of
        // whether the stream has already finished. Without this, any turn
        // that completes before a consumer attaches would compact to an
        // empty log — scheduling-dependent audit history.
        if (!this.firstSubscriberAttached) {
          this.firstSubscriberAttached = true;
          if (this.preSubscriptionBuffer.length > 0) {
            sub.seedReplay(this.preSubscriptionBuffer, this.preDropped);
            this.preSubscriptionBuffer.length = 0;
            this.preDropped = 0;
          }
        }
        if (this.streamFinished) {
          sub.finish();
          return sub;
        }
        this.subscribers.add(sub);
        return sub;
      },
    };
  }

  private broadcast(message: Message): void {
    if (!this.firstSubscriberAttached) {
      // Buffer until first subscriber attaches (start-of-turn replay).
      // Bounded to prevent OOM if no consumer ever attaches.
      if (this.preDropped === 0) {
        if (this.preSubscriptionBuffer.length < MAX_SUBSCRIBER_BUFFER) {
          this.preSubscriptionBuffer.push(message);
          return;
        }
        // First overflow: append an in-band marker (buffer temporarily holds
        // MAX+1 items) so delayed first subscribers still receive a clear
        // truncation signal.
        this.preDropped = 1;
        this.preSubscriptionBuffer.push({
          kind: "raw",
          turnId: this.turnId,
          acpMethod: "_overflow",
          params: { droppedAtLeast: this.preDropped, pre: true },
        });
        return;
      }
      this.preDropped += 1;
      const marker: Message = {
        kind: "raw",
        turnId: this.turnId,
        acpMethod: "_overflow",
        params: { droppedAtLeast: this.preDropped, pre: true },
      };
      const tail = this.preSubscriptionBuffer[this.preSubscriptionBuffer.length - 1];
      // Keep messages immutable: replace the queued marker object rather than
      // mutating an already-emitted/queued object in place.
      if (tail && tail.kind === "raw" && tail.acpMethod === "_overflow") {
        this.preSubscriptionBuffer[this.preSubscriptionBuffer.length - 1] = marker;
      } else if (this.preSubscriptionBuffer.length === MAX_SUBSCRIBER_BUFFER) {
        this.preSubscriptionBuffer.push(marker);
      }
      return;
    }
    for (const sub of this.subscribers) {
      sub.push(message, this.turnId);
    }
  }

  private finish(result: Result): void {
    // Fail-closed (issue #319 adversarial review rounds 3 & 4). Surface a
    // hard error whenever the turn's session-binding integrity is in doubt,
    // so callers do NOT see `stopReason: end_turn` over a stream that
    // silently lost or commingled content. Two failure modes:
    //   (a) `sawUnboundSessionUpdate`: at least one `session/update` arrived
    //       before binding was established. Whether binding never happened
    //       OR arrived later, the early updates are irrecoverably missing
    //       from the semantic stream (they are only in the audit log as
    //       `_sessionUnbound`). Round-4 added the late-binding arm: before
    //       this, a late handshake masked early truncation.
    //   (b) `sessionBindingAmbiguous`: a second correlated handshake landed
    //       with a different wire sessionId — cross-session contamination.
    // Already-terminal errors are preserved unchanged (the upstream error
    // is more informative than our generic session_unbound wrapper).
    let finalResult = result;
    if (
      result.stopReason !== "error" &&
      (this.sawUnboundSessionUpdate || this.sessionBindingAmbiguous)
    ) {
      const code = this.sessionBindingAmbiguous ? "session_ambiguous" : "session_unbound";
      const message = this.sessionBindingAmbiguous
        ? "turn ended with conflicting session bindings — multiple correlated handshakes observed with different wire sessionIds"
        : "turn observed session/update frames before a trusted session binding was established — early content was quarantined as _sessionUnbound";
      finalResult = {
        turnId: result.turnId,
        stopReason: "error",
        error: { code, message },
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      };
    }
    this.resolveResult(finalResult);
    this.streamFinished = true;
    const subs = Array.from(this.subscribers);
    this.subscribers.clear();
    for (const sub of subs) {
      sub.finish();
    }
  }

  /**
   * Parse one NDJSON line, applying session-binding discipline (issue #319).
   *
   * Binding lifecycle:
   *   1. Explicit constructor sessionId → bound from line 1.
   *   2. Otherwise, bind only when a `result.sessionId` frame correlates to
   *      a previously observed `session/new`/`session/load` request id. This
   *      defeats foreign `result` frames that would otherwise poison the
   *      binding (adversarial review round 3).
   *   3. Until bound, any `session/update` is surfaced as `_sessionUnbound`
   *      raw rather than parsed as semantic content.
   *   4. If the turn terminates without a binding AND we quarantined at
   *      least one `session/update`, `finish` degrades `stopReason` to
   *      `error` so the caller sees a hard failure, not silent data loss.
   *
   * @returns `true` iff a terminal result frame was parsed (caller should stop reading).
   */
  private handleLine(line: string, turnId: string): boolean {
    const hint = peekSessionBindingHint(line);

    // Session-request: always track the id (canonical key), even after
    // binding, so a later correlated response can be detected for
    // ambiguity checks.
    if (hint.kind === "session-request") {
      this.pendingSessionRequestIds.add(canonicalRpcId(hint.id));
    }

    // Session-response: ambiguity escalation only applies when the parser
    // is handshake-bound. Constructor-bound callers (multiplexed / shared
    // streams with explicit trust authority) must NOT be forced into
    // `session_ambiguous` by foreign `result.sessionId` noise — that
    // would be a DoS vector for legitimate multiplexed parsing.
    if (hint.kind === "session-response") {
      const key = canonicalRpcId(hint.id);
      const correlated = this.pendingSessionRequestIds.has(key);
      if (correlated) {
        this.pendingSessionRequestIds.delete(key);
        if (this.sessionId === undefined) {
          // First correlated handshake → bind.
          this.sessionId = hint.sessionId;
          this.sessionBoundFromHandshake = true;
        } else if (this.sessionBoundFromHandshake && this.sessionId !== hint.sessionId) {
          // A second correlated handshake disagrees with the learned
          // binding — cross-session contamination. Not applicable to
          // constructor-bound parsers (see flag comment above).
          this.sessionBindingAmbiguous = true;
        }
      } else if (
        this.sessionBoundFromHandshake &&
        this.sessionId !== undefined &&
        this.sessionId !== hint.sessionId
      ) {
        // Round-5 hardening: uncorrelated response disagrees with a
        // handshake-learned binding. A conflicting `result.sessionId`
        // may legitimately lack its echoed request line (schema drift,
        // partial stream, or provider suppressing the request echo).
        // Flag only when the binding itself came from in-band learning.
        this.sessionBindingAmbiguous = true;
      }
      // Uncorrelated response when unbound OR when constructor-bound: do
      // NOT bind, do NOT escalate. Frame flows through as raw `_result`.
    }

    // Quarantine pre-bind session/update as raw anomaly.
    if (hint.kind === "session-update" && this.sessionId === undefined) {
      this.sawUnboundSessionUpdate = true;
      this.broadcast({
        kind: "raw",
        turnId,
        acpMethod: "_sessionUnbound",
        params: hint.params,
      });
      return false;
    }

    const parsed = parseAcpLine(line, turnId, this.sessionId);
    if (parsed.kind === "result") {
      this.finish({ ...parsed.result, turnId });
      return true;
    }
    this.broadcast(parsed.message);
    return false;
  }

  private async _readStream(stream: Readable, turnId: string): Promise<void> {
    // StringDecoder holds partial multi-byte sequences across chunk
    // boundaries. Without it, `(chunk as Buffer).toString("utf8")` called
    // per-chunk silently produces U+FFFD replacement characters whenever a
    // 2/3/4-byte UTF-8 glyph straddles a chunk — corrupting emoji / CJK /
    // accented text in assistant output and breaking JSON.parse on tool
    // call titles or inputs that contain non-ASCII. Pipes on upstream
    // acpx stdout are raw Buffers (see acpx-runtime), so this is a real
    // wire-shape concern, not a theoretical one.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;

    try {
      for await (const chunk of stream) {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);

        // Skip split/pop when no complete line is available yet — avoids
        // reallocating lines[] every chunk when the stream dribbles in
        // sub-line fragments.
        if (buffer.indexOf("\n") === -1) continue;

        // Split on newlines — emit complete lines.
        const lines = buffer.split("\n");
        // Last element is incomplete (no trailing newline yet) — keep in buffer.
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          if (this.handleLine(line, turnId)) {
            settled = true;
            return;
          }
        }
      }

      // Flush any trailing bytes the decoder still holds (incomplete
      // multi-byte sequence at EOF) + any buffered text without a newline.
      buffer += decoder.end();
      if (buffer.trim().length > 0) {
        if (this.handleLine(buffer.trim(), turnId)) {
          settled = true;
          return;
        }
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
