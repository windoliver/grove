import { BoundedEventChannel } from "./bounded-channel.js";
import { classifyMessage } from "./turn.js";
import type { AcpxTurn, Message, Result } from "./types.js";

const DEFAULT_CAPACITY = 256;

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

const TEXT_THINKING: readonly string[] = ["text", "thinking"];

function invalidatesCoalesceKeyFor(m: Message): string | readonly string[] | null {
  if ((m.kind === "text" || m.kind === "thinking") && !m.chunk) return m.kind;
  if (m.kind === "tool_call" || m.kind === "permission_request") return TEXT_THINKING;
  return null;
}

export class AcpTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private readonly channel: BoundedEventChannel<Message>;
  private pendingCancel: Promise<void> | null = null;
  private closed = false;

  constructor(opts: {
    sessionId: string;
    turnId: string;
    result: Promise<Result>;
    cancelFn: () => Promise<void>;
    channelCapacity?: number;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    this.channel = new BoundedEventChannel<Message>({
      capacity: opts.channelCapacity ?? DEFAULT_CAPACITY,
      classify: classifyMessage,
      coalesceKey: coalesceKeyFor,
      coalesce: coalesceMessage,
      invalidatesCoalesceKey: invalidatesCoalesceKeyFor,
    });
    this.messages = this.channel;
    this.result = opts.result.finally(() => {
      if (!this.closed) {
        this.closed = true;
        this.channel.close();
      }
    });
  }

  ingest(m: Message): void {
    if (this.closed) return;
    this.channel.push(m);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
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
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
  }
}
