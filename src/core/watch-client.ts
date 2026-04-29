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

const DEFAULT_BACKOFF = { minMs: 100, maxMs: 30_000, jitter: 0.3 };

type StreamExit = { kind: "abort" } | { kind: "ended" } | { kind: "relist" };

export class WatchClient {
  private readonly baseUrl: string;
  private readonly kind: WatchKind;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffCfg: NonNullable<WatchClientOptions["backoff"]>;
  /** Test-only hook called whenever the loop sleeps for `ms` after a failure. */
  onBackoff?: (ms: number) => void;

  constructor(opts: WatchClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.kind = opts.kind;
    this.authHeader = opts.authHeader;
    this.fetchImpl = opts.fetch ?? fetch;
    this.backoffCfg = opts.backoff ?? DEFAULT_BACKOFF;
  }

  async run(opts: {
    onEvent: (e: WatchClientEvent) => Promise<void> | void;
    signal: AbortSignal;
  }): Promise<void> {
    const { onEvent, signal } = opts;
    let nextDelay = this.backoffCfg.minMs;
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
      const exit = await this.streamWatch(BigInt(list.listResourceVersion), onEvent, signal);
      if (exit.kind === "abort") return;
      if (exit.kind === "relist") {
        await this.sleep(nextDelay, signal);
        nextDelay = this.advanceBackoff(nextDelay);
        continue;
      }
      // exit.kind === "ended" — Task 7 will introduce fast-resume here. For
      // Task 6, just sleep + restart loop with a fresh list.
      // Successful stream end: reset backoff.
      nextDelay = this.backoffCfg.minMs;
      await this.sleep(nextDelay, signal);
      nextDelay = this.advanceBackoff(nextDelay);
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
  ): Promise<StreamExit> {
    const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) return { kind: "ended" };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return { kind: "ended" };
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(block);
          if (!frame) {
            idx = buf.indexOf("\n\n");
            continue;
          }
          if (frame.event === "ERROR") {
            const code = (frame.data as { code?: number })?.code;
            if (code === 410 || code === 503) return { kind: "relist" };
            throw new Error(`watch terminal error: code=${code}`);
          }
          if (isDataOp(frame.event)) {
            const payload = frame.data as { rv: string; entity: WatchEntity };
            await onEvent({
              op: frame.event as WatchClientOp,
              rv: BigInt(payload.rv),
              kind: this.kind,
              entity: payload.entity,
            });
          }
          if (signal.aborted) return { kind: "abort" };
          idx = buf.indexOf("\n\n");
        }
      }
      return { kind: "abort" };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already cancelled */
      }
    }
  }

  private advanceBackoff(prev: number): number {
    return Math.min(this.backoffCfg.maxMs, Math.max(this.backoffCfg.minMs, prev * 2));
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.onBackoff?.(ms);
    if (ms <= 0 || signal.aborted) return;
    const jitter = this.backoffCfg.jitter;
    const actual = jitter > 0 ? ms * (1 + (Math.random() * 2 - 1) * jitter) : ms;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, actual);
      const onAbort = (): void => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
