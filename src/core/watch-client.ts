/**
 * WatchClient — list→watch loop with relist on Expired (#293).
 *
 * Drives the A5 handshake (#292) and translates server SSE events into
 * a typed callback. RELIST signals "snapshot, not delta" so consumers
 * can run K8s-informer-style Replace() reconciliation.
 */

import type { WatchEntity, WatchKind } from "./watch-events.js";

export type WatchClientOp =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "RELIST"
  | "RELIST_BEGIN"
  | "RELIST_END";

/**
 * Boundary events RELIST_BEGIN/RELIST_END fire even for empty snapshots so
 * consumers can atomically replace local state after compaction (drop entries
 * not present between BEGIN and END). Their entity is null.
 */
export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity | null;
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

type StreamExit =
  | { kind: "abort" }
  | { kind: "ended"; lastRv: bigint; observedData: boolean }
  | { kind: "relist" };

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
    let resumeFrom: bigint | null = null; // null → must (re)list

    while (!signal.aborted) {
      if (resumeFrom === null) {
        const list = await this.list(signal);
        const rv = BigInt(list.listResourceVersion);
        await onEvent({ op: "RELIST_BEGIN", rv, kind: this.kind, entity: null });
        for (const item of list.items) {
          if (signal.aborted) return;
          await onEvent({ op: "RELIST", rv, kind: this.kind, entity: item });
        }
        if (signal.aborted) return;
        await onEvent({ op: "RELIST_END", rv, kind: this.kind, entity: null });
        resumeFrom = rv;
      }
      const exit = await this.streamWatch(resumeFrom, onEvent, signal);
      if (exit.kind === "abort") return;
      if (exit.kind === "relist") {
        // Full relist on next iteration. Reset backoff (relist is a clean slate).
        resumeFrom = null;
        nextDelay = this.backoffCfg.minMs;
        await this.sleep(nextDelay, signal);
        nextDelay = this.advanceBackoff(nextDelay);
      } else {
        // exit.kind === "ended" — fast resume from lastRv (no relist).
        resumeFrom = exit.lastRv;
        // Reset backoff if the stream actually delivered events; otherwise keep
        // accumulating so a flapping/empty server gets exponentially throttled.
        if (exit.observedData) {
          nextDelay = this.backoffCfg.minMs;
        }
        await this.sleep(nextDelay, signal);
        nextDelay = this.advanceBackoff(nextDelay);
      }
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
    let lastRv = fromRv;
    let observedData = false;
    const url = `${this.baseUrl}/api/watch?kind=${this.kind}&resumeFrom=${fromRv}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: this.authHeader, Accept: "text/event-stream" },
        signal,
      });
    } catch (err) {
      // Transport error (connection reset, DNS, TLS). If the caller aborted,
      // unwind cleanly; otherwise treat as a transient close → fast resume.
      if (signal.aborted) return { kind: "abort" };
      console.warn(`watch: fetch failed (${(err as Error)?.message ?? err}); resuming`);
      return { kind: "ended", lastRv, observedData };
    }
    if (res.status === 410 || res.status === 503) {
      return { kind: "relist" };
    }
    if (!res.ok) {
      // 4xx/5xx other than 410/503 indicate the server is up and refusing
      // (auth/config/server bug). Make terminal so the caller surfaces it
      // instead of looping forever with a stale resumeFrom.
      throw new Error(`watch failed: ${res.status}`);
    }
    if (!res.body) return { kind: "ended", lastRv, observedData };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // Mid-stream transport failure (RST, stream reset). Same policy as
          // fetch reject: aborted → unwind, otherwise fast resume from lastRv.
          if (signal.aborted) return { kind: "abort" };
          console.warn(`watch: read failed (${(err as Error)?.message ?? err}); resuming`);
          return { kind: "ended", lastRv, observedData };
        }
        if (chunk.done) return { kind: "ended", lastRv, observedData };
        buf += decoder.decode(chunk.value, { stream: true });
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
            const payload = frame.data as { rv?: string; entity?: WatchEntity };
            if (!payload.rv || !/^[0-9]+$/.test(payload.rv) || !payload.entity) {
              // Malformed data frame: a subsequent BOOKMARK could otherwise
              // ack past this rv and silently drop the event. Force a relist
              // so the consumer atomically replaces state from a fresh snapshot.
              console.warn(`watch: malformed ${frame.event} frame → forcing relist`);
              return { kind: "relist" };
            }
            const rv = BigInt(payload.rv);
            lastRv = rv;
            observedData = true;
            await onEvent({
              op: frame.event as WatchClientOp,
              rv,
              kind: this.kind,
              entity: payload.entity,
            });
          } else if (frame.event === "BOOKMARK") {
            // BOOKMARK advances resume cursor without firing onEvent.
            const rv = (frame.data as { rv?: string })?.rv;
            if (rv && /^[0-9]+$/.test(rv)) lastRv = BigInt(rv);
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
      let onAbort: (() => void) | undefined;
      const t = setTimeout(() => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        resolve();
      }, actual);
      onAbort = (): void => {
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
