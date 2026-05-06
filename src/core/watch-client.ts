/**
 * WatchClient — list→watch loop with relist on Expired (#293).
 *
 * Drives the A5 handshake (#292) and translates server SSE events into
 * a typed callback. RELIST signals "snapshot, not delta" so consumers
 * can run K8s-informer-style Replace() reconciliation.
 */

import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchStream } from "./watch-stream.js";

export type WatchClientOp =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "RELIST"
  | "RELIST_BEGIN"
  | "RELIST_END"
  | "RELIST_ABORTED";

/**
 * Boundary events fire even for empty snapshots so consumers can atomically
 * replace local state after compaction (drop entries not present between
 * BEGIN and END). Their entity is null.
 *
 * The boundary contract is:
 * - RELIST_BEGIN: enter replace mode.
 * - RELIST_END: snapshot fully delivered → commit replace transaction.
 * - RELIST_ABORTED: snapshot was interrupted (abort or onEvent throw mid-
 *   snapshot) → roll back; do NOT commit a partial replace.
 *
 * Exactly one terminal event (RELIST_END or RELIST_ABORTED) follows every
 * RELIST_BEGIN. Consumers can rely on receiving one or the other but
 * never both.
 */
export interface WatchClientEvent {
  readonly op: WatchClientOp;
  readonly rv: bigint;
  readonly kind: WatchKind;
  readonly entity: WatchEntity | null;
  /** Server-stamped ISO-8601 wall-clock; see `WatchEvent.emittedAt`. */
  readonly emittedAt?: string;
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

export class WatchClient implements WatchStream {
  private readonly baseUrl: string;
  private readonly kind: WatchKind;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffCfg: NonNullable<WatchClientOptions["backoff"]>;
  /**
   * Snapshot dedup window. The /api/list handshake captures the watch RV
   * before the store query, so a write that commits between rv-capture and
   * list-return appears in BOTH the snapshot and the watch replay (rv >
   * listResourceVersion). Track {entityId → resourceVersion} from the most
   * recent RELIST so an immediately-following ADDED/MODIFIED with the same
   * (id, rv) tuple is suppressed instead of double-delivered to the consumer.
   */
  private snapshotWindow = new Map<string, string>();
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
        let list: ListResponse;
        try {
          list = await this.list(signal);
        } catch (err) {
          if (signal.aborted) return;
          // Transient errors (network reject, 5xx) retry with backoff so a
          // brief server restart during compaction recovery doesn't kill
          // the watcher. HTTP 4xx (auth/config) stays terminal.
          if (isTransientListError(err)) {
            console.warn(`watch: list failed (${(err as Error)?.message ?? err}); retrying`);
            await this.sleep(nextDelay, signal);
            nextDelay = this.advanceBackoff(nextDelay);
            continue;
          }
          throw err;
        }
        const rv = BigInt(list.listResourceVersion);
        const newWindow = new Map<string, string>();
        // Boundary invariant: once RELIST_BEGIN has been delivered, exactly
        // one terminal — RELIST_END (full snapshot delivered) or
        // RELIST_ABORTED (interrupted) — always fires. Consumers can
        // commit on RELIST_END and rollback on RELIST_ABORTED without
        // ambiguity.
        let relistOpen = false;
        let primaryError: unknown;
        try {
          await onEvent({ op: "RELIST_BEGIN", rv, kind: this.kind, entity: null });
          relistOpen = true;
          for (const item of list.items) {
            if (signal.aborted) break;
            newWindow.set(item.id, item.resourceVersion);
            await onEvent({ op: "RELIST", rv, kind: this.kind, entity: item });
          }
        } catch (err) {
          primaryError = err;
        }
        if (relistOpen) {
          // RELIST_END only when snapshot fully delivered AND no error/abort.
          // Otherwise RELIST_ABORTED so consumers know to discard staged state
          // instead of committing a partial replace.
          const interrupted = primaryError !== undefined || signal.aborted;
          const closeOp: WatchClientOp = interrupted ? "RELIST_ABORTED" : "RELIST_END";
          try {
            await onEvent({ op: closeOp, rv, kind: this.kind, entity: null });
          } catch (err) {
            // Terminal-event handler failures: only propagate when this is
            // a clean commit (RELIST_END) and no earlier error/abort
            // already triggered teardown.
            if (closeOp === "RELIST_END" && primaryError === undefined && !signal.aborted) {
              primaryError = err;
            }
          }
        }
        if (primaryError !== undefined) throw primaryError;
        if (signal.aborted) return;
        // Install the dedup window AFTER RELIST_END so the snapshot itself
        // can't accidentally be deduped against itself by re-entrant code.
        this.snapshotWindow = newWindow;
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
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/list?kind=${this.kind}`, {
        headers: { Authorization: this.authHeader },
        signal,
      });
    } catch (err) {
      // Transport rejection — surface as transient via a marked error so
      // run() can distinguish it from HTTP-level failures.
      throw new TransientListTransportError((err as Error)?.message ?? String(err));
    }
    if (!res.ok) {
      throw new ListHttpError(res.status, `list failed: ${res.status}`);
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
        let chunk: { done: boolean; value: Uint8Array | undefined };
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
            const payload = frame.data as {
              rv?: string;
              entity?: WatchEntity;
              emittedAt?: string;
            };
            if (!payload.rv || !/^[0-9]+$/.test(payload.rv) || !payload.entity) {
              // Malformed data frame: a subsequent BOOKMARK could otherwise
              // ack past this rv and silently drop the event. Force a relist
              // so the consumer atomically replaces state from a fresh snapshot.
              console.warn(`watch: malformed ${frame.event} frame → forcing relist`);
              return { kind: "relist" };
            }
            const rv = BigInt(payload.rv);
            const entity = payload.entity;
            // Snapshot-dedup with high-water mark. The /api/list handshake
            // captures listResourceVersion *before* querying the store, so
            // a write whose hub-rv lands during the list window appears in
            // BOTH the snapshot and the watch replay. Drop replay frames
            // whose entity version is ≤ the snapshot's version for that
            // id; forward strictly newer versions and DELETED. Treat the
            // window as a high-water mark — never delete on a stale match,
            // since further stale frames could still arrive in the same
            // race window.
            const seenRv = this.snapshotWindow.get(entity.id);
            if (seenRv !== undefined && frame.event !== "DELETED") {
              if (isStaleVersion(entity.resourceVersion, seenRv)) {
                lastRv = rv;
                observedData = true;
                idx = buf.indexOf("\n\n");
                continue;
              }
              // Strictly newer real update — clear the entry so subsequent
              // events for this entity bypass dedup entirely.
              this.snapshotWindow.delete(entity.id);
            } else if (seenRv !== undefined) {
              // DELETED tombstone supersedes any prior snapshot version.
              this.snapshotWindow.delete(entity.id);
            }
            lastRv = rv;
            observedData = true;
            await onEvent({
              op: frame.event as WatchClientOp,
              rv,
              kind: this.kind,
              entity,
              ...(payload.emittedAt !== undefined ? { emittedAt: payload.emittedAt } : {}),
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

/**
 * Compare two `entity.resourceVersion` values. Returns true when `eventRv`
 * is older-or-equal to `snapshotRv` (i.e. should be treated as a stale
 * replay during snapshot-dedup). Format is normally `String(rev)` but the
 * Claim entity also encodes lease state as `${rev}-lease-expired` —
 * extract the leading numeric prefix on both sides for a robust ordering.
 * Falls back to exact string equality when no numeric prefix is present.
 */
export function isStaleVersion(eventRv: string, snapshotRv: string): boolean {
  const a = parseRvPrefix(snapshotRv);
  const b = parseRvPrefix(eventRv);
  if (a !== null && b !== null) return b <= a;
  return eventRv === snapshotRv;
}

function parseRvPrefix(s: string): number | null {
  const m = /^(\d+)/.exec(s);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Marker for /api/list transport rejections (network reset, DNS, TLS).
 * Always retryable.
 */
class TransientListTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientListTransportError";
  }
}

/**
 * Marker for /api/list non-OK HTTP responses. 5xx is retryable; 4xx is
 * terminal (auth/config/server-side validation failure).
 */
class ListHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ListHttpError";
    this.status = status;
  }
}

function isTransientListError(err: unknown): boolean {
  if (err instanceof TransientListTransportError) return true;
  if (err instanceof ListHttpError) {
    // Only retry on infrastructure-class transients. 500 (generic server
    // error) and 501 (NOT_CONFIGURED — e.g. AgentSession watcher hits
    // an unsupported kind) are permanent: retrying would loop forever.
    return err.status === 502 || err.status === 503 || err.status === 504;
  }
  return false;
}
