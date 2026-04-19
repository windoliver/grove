/**
 * AcpxTurn — owns a single prompt's message stream and final result.
 * Constructed by AcpxRuntime from the acpx child's stdout Readable.
 */

import type { Readable } from "node:stream";
import { BoundedEventChannel, type Policy } from "./bounded-channel.js";
import { AcpParser } from "./parser.js";
import type { AcpxTurn, Message, Result } from "./types.js";

const DEFAULT_CHANNEL_CAPACITY = 256;

function classifyMessage(m: Message): Policy {
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

function invalidatesCoalesceKeyFor(m: Message): string | null {
  if ((m.kind === "text" || m.kind === "thinking") && !m.chunk) return m.kind;
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
    turnId: string;
    stdout: Readable;
    cancelFn: () => Promise<void>;
    /** Override the default 256-event channel capacity. Pass `Infinity` to bypass eviction. */
    channelCapacity?: number;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    this.parser = new AcpParser({
      sessionId: opts.sessionId,
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
    void (async () => {
      try {
        for await (const m of parser.messages) {
          channel.push(m);
        }
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
}
