/**
 * WatchClient — list→watch loop with relist on Expired (#293).
 *
 * Drives the A5 handshake (#292) and translates server SSE events into
 * a typed callback. RELIST signals "snapshot, not delta" so consumers
 * can run K8s-informer-style Replace() reconciliation.
 */

import type { WatchEntity, WatchKind } from "./watch-events.js";

export type WatchClientOp = "ADDED" | "MODIFIED" | "DELETED" | "RELIST";

export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity;
}

export interface WatchClientOptions {
  readonly baseUrl: string;
  readonly kind: WatchKind;
  readonly authHeader: string;
  readonly fetch?: typeof fetch;
  readonly backoff?: {
    readonly minMs: number;
    readonly maxMs: number;
    readonly jitter: number;
  };
}

interface ListResponse {
  readonly items: WatchEntity[];
  readonly listResourceVersion: string;
}

interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

export class WatchClient {
  private readonly baseUrl: string;
  private readonly kind: WatchKind;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WatchClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.kind = opts.kind;
    this.authHeader = opts.authHeader;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => Promise<void> | void;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    while (!signal.aborted) {
      const list = await this.list(signal);
      for (const item of list.items) {
        if (signal.aborted) return;
        await onEvent({
          op: "RELIST",
          rv: BigInt(list.listResourceVersion),
          kind: this.kind,
          entity: item,
        });
      }
      const resumed = await this.streamWatch(BigInt(list.listResourceVersion), onEvent, signal);
      if (resumed === "abort") return;
      // Future tasks: distinguish 410/503 (full relist, restart loop) from
      // TCP close (fast resume). For now any non-abort exit restarts the loop.
    }
  }

  private async list(signal: AbortSignal): Promise<ListResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/list?kind=${this.kind}`, {
      headers: { Authorization: this.authHeader },
      signal,
    });
    if (!res.ok) {
      throw new Error(`list failed: ${res.status}`);
    }
    return (await res.json()) as ListResponse;
  }

  private async streamWatch(
    fromRv: bigint,
    onEvent: (e: WatchClientEvent) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<"abort" | "ended"> {
    const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) return "ended";

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return "ended";
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(block);
          if (frame && isDataOp(frame.event)) {
            const payload = frame.data as { rv: string; entity: WatchEntity };
            await onEvent({
              op: frame.event as WatchClientOp,
              rv: BigInt(payload.rv),
              kind: this.kind,
              entity: payload.entity,
            });
          }
          if (signal.aborted) return "abort";
          idx = buf.indexOf("\n\n");
        }
      }
      return "abort";
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already cancelled */
      }
    }
  }
}

function parseSseFrame(block: string): SseFrame | null {
  const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
  const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
  const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
  if (!event) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(dataLine);
  } catch {
    data = dataLine;
  }
  return { id, event, data };
}

function isDataOp(event: string): boolean {
  return event === "ADDED" || event === "MODIFIED" || event === "DELETED";
}
