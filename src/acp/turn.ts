/**
 * AcpxTurn — owns a single prompt's message stream and final result.
 * Constructed by AcpxRuntime from the acpx child's stdout Readable.
 */

import type { Readable } from "node:stream";
import { BoundedEventChannel, type Policy } from "./bounded-channel.js";
import { AcpParser } from "./parser.js";
import type { AcpxTurn, Message, Result } from "./types.js";

const DEFAULT_CHANNEL_CAPACITY = 256;

export function classifyMessage(m: Message): Policy {
  switch (m.kind) {
    case "tool_call":
    case "permission_request":
      return "never";
    case "text":
    case "thinking":
      return m.chunk ? "coalesce_text_deltas" : "never";
    case "token_usage":
    case "raw":
      return "drop_oldest_on_full";
    default:
      return "drop_oldest_on_full";
  }
}

function coalesceKeyFor(m: Message): string | null {
  if ((m.kind === "text" || m.kind === "thinking") && m.chunk) return m.kind;
  return null;
}

function coalesceMessage(existing: Message, incoming: Message): Message {
  if (
    (existing.kind === "text" && incoming.kind === "text") ||
    (existing.kind === "thinking" && incoming.kind === "thinking")
  ) {
    return { ...existing, text: existing.text + incoming.text };
  }
  return existing;
}

const TEXT_THINKING_KEYS: readonly string[] = ["text", "thinking"];

function invalidatesCoalesceKeyFor(m: Message): string | readonly string[] | null {
  if ((m.kind === "text" || m.kind === "thinking") && !m.chunk) return m.kind;
  // tool_call / permission_request are chronological boundaries between
  // text/thinking runs. Without invalidation, a later text chunk would
  // coalesce into the pre-tool_call slot and visibly reorder the stream
  // (text-after-tool would surface as text-before-tool to the consumer).
  if (m.kind === "tool_call" || m.kind === "permission_request") return TEXT_THINKING_KEYS;
  return null;
}

export class AcpxTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private readonly parser: AcpParser;
  private readonly channel: BoundedEventChannel<Message>;
  private pendingCancel: Promise<void> | null = null;

  constructor(opts: {
    sessionId: string;
    /**
     * Optional acpx-internal wire sessionId. Pass the UUID learned from the
     * first turn's `session/new` handshake to hard-bind subsequent turns
     * that reuse the same acpx child — those turns don't see the handshake
     * again on stdout, so without this the parser would fail-closed (issue
     * #319). Leave undefined on the first turn to let AcpParser auto-learn
     * via in-band correlation.
     */
    wireSessionId?: string | undefined;
    turnId: string;
    stdout: Readable;
    cancelFn: () => Promise<void>;
    /** Override the default 256-event channel capacity. Pass `Infinity` to bypass eviction. */
    channelCapacity?: number;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    // Do NOT forward the caller's grove label (`opts.sessionId`) to
    // AcpParser — acpx's wire sessionId is a different value (see #319).
    // Forward `opts.wireSessionId` when the caller knows acpx's UUID (e.g.
    // on a second+ turn of the same child); otherwise AcpParser auto-learns
    // via correlated `session/new` handshake.
    this.parser = new AcpParser({
      sessionId: opts.wireSessionId,
      turnId: opts.turnId,
      stream: opts.stdout,
    });
    this.channel = new BoundedEventChannel<Message>({
      capacity: opts.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY,
      classify: classifyMessage,
      coalesceKey: coalesceKeyFor,
      coalesce: coalesceMessage,
      invalidatesCoalesceKey: invalidatesCoalesceKeyFor,
    });
    this.result = this.parser.result;
    this.messages = this.channel;

    const parser = this.parser;
    const channel = this.channel;
    const sid = this.sessionId;
    const tid = this.turnId;
    void (async () => {
      try {
        for await (const m of parser.messages) {
          channel.push(m);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[acpx-turn] pump error for session=${sid} turn=${tid}: ${msg}\n`);
      } finally {
        channel.close();
      }
    })();
  }

  async cancel(): Promise<void> {
    if (this.parser.settled) return;
    if (this.pendingCancel !== null) return this.pendingCancel;
    const attempt = (async () => {
      try {
        await this.cancelFn();
      } finally {
        this.pendingCancel = null;
      }
    })();
    this.pendingCancel = attempt;
    return attempt;
  }

  async close(): Promise<void> {
    // Parser closes when stdout EOFs; nothing extra to release here.
  }

  /**
   * The acpx-internal wire sessionId the parser ended up bound to (if any).
   * `AcpxRuntime` reads this after a turn settles and caches it so the next
   * turn on the same child can be hard-bound (issue #319).
   */
  get wireSessionId(): string | undefined {
    return this.parser.wireSessionId;
  }
}
