/**
 * Informer<K> — K8s-informer-style local cache with event fanout (#294).
 *
 * Consumes a WatchStream to maintain a Map<id, Entity> that tracks server state
 * via the list→watch handshake. One Informer per kind is shared across all
 * subscribers via InformerFactory.
 *
 * HasSynced() returns true only after the first RELIST_END so the TUI can
 * gate first render on a fully-populated cache (no empty-flash).
 */

import type { AgentTaskEntity } from "./agent-task.js";
import type {
  AgentSessionEntity,
  ClaimEntity,
  ContributionEntity,
  TimelineEventEntity,
  WorkBlockEntity,
} from "./entity.js";
import { LocalWatchClient } from "./local-watch-client.js";
import { WatchClient, type WatchClientOp, type WatchClientOptions } from "./watch-client.js";
import type { WatchEntity, WatchKind } from "./watch-events.js";
import type { WatchHub } from "./watch-hub.js";
import type { WatchClientEvent, WatchStream } from "./watch-stream.js";

export type EntityForKind<K extends WatchKind> = K extends "Contribution"
  ? ContributionEntity
  : K extends "Claim"
    ? ClaimEntity
    : K extends "AgentSession"
      ? AgentSessionEntity
      : K extends "AgentTask"
        ? AgentTaskEntity
        : K extends "WorkBlock"
          ? WorkBlockEntity
          : K extends "TimelineEvent"
            ? TimelineEventEntity
            : never;

export type InformerOp = "ADDED" | "MODIFIED" | "DELETED";

export type EventHandlerFn<K extends WatchKind = WatchKind> = (
  op: InformerOp,
  entity: EntityForKind<K>,
  meta?: { readonly emittedAt?: string },
) => void | Promise<void>;

export type SyncHandlerFn = () => void;

/**
 * Reduced, immutable projection delivered to RAW event handlers. It
 * deliberately does NOT carry the entity reference: the raw tap fires
 * before the coalesced path freezes/stores the entity, so handing out
 * the live object would let a subscriber corrupt the cache. All fields
 * are primitives copied off the event, so this is cheap (one small
 * alloc, no recursive freeze) and safe by construction. `statusPhase`
 * is the AgentTask `status.phase` when present (undefined for kinds
 * without it) — the only nested field any raw consumer needs.
 */
export interface RawInformerEvent {
  readonly op: InformerOp;
  readonly id: string;
  readonly statusPhase?: string | undefined;
  readonly emittedAt?: string | undefined;
}

export type RawEventHandlerFn = (e: RawInformerEvent) => void;

export interface InformerOptions {
  /** Max distinct entity ids buffered between drain cycles. Default 1000. */
  readonly queueLimit?: number;
  /** Fired exactly once per overflow event. Wired by InformerFactory to factory.relist(kind). */
  readonly onOverflow?: (kind: WatchKind) => void;
}

function isControlEvent(op: WatchClientOp): boolean {
  return op === "RELIST_BEGIN" || op === "RELIST" || op === "RELIST_END" || op === "RELIST_ABORTED";
}

export class Informer<K extends WatchKind = WatchKind> {
  private readonly stream: WatchStream;
  private readonly kind: WatchKind;
  private readonly queueLimit: number;
  private readonly onOverflow: ((kind: WatchKind) => void) | null;
  private readonly store = new Map<string, EntityForKind<K>>();
  private readonly handlers: Array<EventHandlerFn<K>> = [];
  private readonly rawHandlers: Array<RawEventHandlerFn> = [];
  private readonly syncHandlers: Array<SyncHandlerFn> = [];
  private _synced = false;
  private staging: Map<string, EntityForKind<K>> | null = null;
  private _running = false;
  // Set during run() so dispatch can race handlers against the abort signal.
  private _signal: AbortSignal | null = null;
  private queue = new Map<string, WatchClientEvent>();
  private overflows = 0;
  private flushScheduled = false;

  constructor(stream: WatchStream, kind: WatchKind, opts?: InformerOptions) {
    this.stream = stream;
    this.kind = kind;
    this.queueLimit = opts?.queueLimit ?? 1000;
    this.onOverflow = opts?.onOverflow ?? null;
  }

  /**
   * Register an event handler. Returns an unsubscribe function — call it to
   * stop the handler from receiving further events (e.g. when a TUI panel
   * unmounts). Stale handlers that throw are isolated but still waste memory
   * and CPU, so always call the returned cleanup.
   */
  addEventHandler(fn: EventHandlerFn<K>): () => void {
    this.handlers.push(fn);
    return () => {
      const idx = this.handlers.indexOf(fn);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Register a RAW event handler — fires synchronously in `enqueue()` for
   * EVERY delta event (ADDED/MODIFIED/DELETED), BEFORE the per-id queue
   * coalescing and BEFORE overflow `clear()`. Use this (not
   * `addEventHandler`) for lossless rate/transition metrics: the normal
   * handler path runs after `drain()`, by which point a same-id burst
   * (e.g. Running→AwaitingReview→Running→AwaitingReview) has collapsed to
   * the final state in the `Map<id,event>` queue and overflow may have
   * dropped the batch entirely.
   *
   * Handlers receive a {@link RawInformerEvent} — a small immutable
   * primitive projection, NOT the entity — so a raw subscriber cannot
   * mutate the object that later enters the cache, and there is no
   * recursive deep-freeze on the ingest hot path. Contract: raw
   * handlers MUST be cheap and synchronous (void return); a thrown
   * error is isolated so one handler can't break ingest, but a slow
   * handler will backpressure the watch stream.
   */
  addRawEventHandler(fn: RawEventHandlerFn): () => void {
    this.rawHandlers.push(fn);
    return () => {
      const idx = this.rawHandlers.indexOf(fn);
      if (idx >= 0) this.rawHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a sync handler that fires on every RELIST_END, including empty
   * snapshots and snapshots that produce no per-entity deltas. Required so
   * hooks can flip hasSynced and recompute filtered views even when the
   * snapshot is identical to the prior cache state.
   *
   * @param fireIfSynced when true (default) and the informer is already
   *   synced at registration time, fire `fn` immediately so newly-mounted
   *   consumers don't have to wait for the next RELIST_END to learn the
   *   cache is populated. Pass false to subscribe only to FUTURE RELIST_END
   *   events — used by the factory's recovery handler so a stale `_synced
   *   === true` from a prior run can't clear an error owned by the new run.
   */
  addSyncHandler(fn: SyncHandlerFn, fireIfSynced = true): () => void {
    this.syncHandlers.push(fn);
    if (fireIfSynced && this._synced) {
      try {
        fn();
      } catch (err) {
        console.error("Informer: sync handler threw, continuing fanout:", err);
      }
    }
    return () => {
      const idx = this.syncHandlers.indexOf(fn);
      if (idx >= 0) this.syncHandlers.splice(idx, 1);
    };
  }

  hasSynced(): boolean {
    return this._synced;
  }

  getById(id: string): EntityForKind<K> | undefined {
    return this.store.get(id);
  }

  list(): ReadonlyArray<EntityForKind<K>> {
    return Array.from(this.store.values());
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this._running) {
      throw new Error(
        "Informer.run() called while already running; only one concurrent run is allowed",
      );
    }
    this._running = true;
    this._signal = signal;
    try {
      await this.stream.run({ onEvent: (e) => this.enqueue(e), signal });
    } finally {
      this._signal = null;
      this._running = false;
    }
  }

  /**
   * Enqueue path used by `stream.run`'s `onEvent` callback.
   *
   * Return type is `void | Promise<void>` by design:
   * - Delta events (ADDED/MODIFIED/DELETED): returns void synchronously.
   *   Hot path under burst — avoiding async at this layer means a 100k/s
   *   stream doesn't pay one microtask per event in the WatchClient's
   *   `await onEvent(e)` loop.
   * - Control events (RELIST_BEGIN/RELIST/RELIST_END/RELIST_ABORTED):
   *   returns the Promise from `enqueueControl`, which drains pending
   *   deltas BEFORE applying the control event so the staging-Map
   *   invariant in `applyEvent` holds across snapshot boundaries.
   *
   * Caller MUST await the return. WatchClient/LocalWatchClient already
   * `await onEvent(e)` per the `WatchStream.run` contract; the arrow
   * `(e) => this.enqueue(e)` in `run()` propagates that promise.
   * Skipping the await would let a delta arriving immediately after
   * RELIST_END be applied before the snapshot replace, breaking the
   * drain-then-apply barrier.
   */
  private enqueue(e: WatchClientEvent): void | Promise<void> {
    if (isControlEvent(e.op)) return this.enqueueControl(e);
    const id = e.entity?.id;
    if (id === undefined) return;
    // Raw, pre-coalesce, overflow-immune tap. Fires for every delta before
    // the Map<id,event> queue collapses same-id bursts and before overflow
    // clear(). Lossless metrics (PulseAggregator) subscribe here.
    //
    // Handlers get a small immutable primitive projection (op/id/
    // statusPhase/emittedAt) — never the entity. This is safe by
    // construction (a raw subscriber cannot reach the object that later
    // enters the cache) AND cheap (one tiny alloc, no recursive freeze
    // on the ingest hot path). Snapshot the handler list so an
    // unsubscribe mid-fanout can't skip a sibling; isolate throws.
    if (this.rawHandlers.length > 0) {
      const ent = e.entity as { status?: { phase?: string } } | null;
      // Runtime-freeze the shared projection: TS `readonly` is erased at
      // runtime, and the same object is handed to every handler in the
      // fanout — without this, a misbehaving handler could rewrite a
      // field and make a later handler miscount by registration order.
      // O(1): a flat 4-primitive object, not the recursive entity freeze
      // rejected earlier for hot-path cost.
      const raw: RawInformerEvent = Object.freeze({
        op: e.op as InformerOp,
        id,
        statusPhase: ent?.status?.phase,
        emittedAt: e.emittedAt,
      });
      for (const h of [...this.rawHandlers]) {
        try {
          h(raw);
        } catch (err) {
          console.error(`Informer[${this.kind}]: raw handler threw, continuing ingest:`, err);
        }
      }
    }
    if (this.queue.has(id)) {
      this.queue.set(id, e);
      return;
    }
    if (this.queue.size >= this.queueLimit) {
      this.queue.clear();
      this.overflows += 1;
      if (this.onOverflow) {
        try {
          this.onOverflow(this.kind);
        } catch (err) {
          console.error(
            `Informer[${this.kind}]: onOverflow callback threw, recovery skipped:`,
            err,
          );
        }
      }
      return;
    }
    this.queue.set(id, e);
    this.scheduleDrain();
  }

  private async enqueueControl(e: WatchClientEvent): Promise<void> {
    if (this.queue.size > 0) {
      // Swap-and-iterate (vs `clear()`) is intentional and mirrors `drain()`'s
      // re-entry guard: a delta enqueued during `await applyEvent(ev)` lands
      // in the new map and is picked up by the next iteration / next drain,
      // not silently dropped.
      const pending = this.queue;
      this.queue = new Map();
      for (const ev of pending.values()) await this.applyEvent(ev);
    }
    await this.applyEvent(e);
  }

  private scheduleDrain(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    // Keep flushScheduled=true for the duration of the drain so concurrent
    // enqueues don't schedule a second microtask that races us; they instead
    // accumulate in this.queue and we sweep them in the next loop iteration.
    // This preserves serialized fanout: a slow handler in one batch blocks
    // delivery of the next batch.
    try {
      while (this.queue.size > 0) {
        const pending = this.queue;
        this.queue = new Map();
        for (const ev of pending.values()) {
          await this.applyEvent(ev);
        }
      }
    } finally {
      this.flushScheduled = false;
    }
  }

  getQueueStats(): {
    readonly depth: number;
    readonly limit: number;
    readonly overflows: number;
  } {
    return { depth: this.queue.size, limit: this.queueLimit, overflows: this.overflows };
  }

  private async applyEvent(e: WatchClientEvent): Promise<void> {
    switch (e.op) {
      case "RELIST_BEGIN":
        this.staging = new Map();
        break;

      case "RELIST":
        if (this.staging && e.entity) {
          this.staging.set(e.entity.id, freeze(e.entity as EntityForKind<K>));
        }
        break;

      case "RELIST_END":
        if (!this.staging) break;
        this._synced = true;
        await this.commitReplace(this.staging);
        this.staging = null;
        this.fireSync();
        break;

      case "RELIST_ABORTED":
        this.staging = null;
        break;

      case "ADDED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          await this.dispatch(
            "ADDED",
            entity,
            e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined,
          );
        }
        break;

      case "MODIFIED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          await this.dispatch(
            "MODIFIED",
            entity,
            e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined,
          );
        }
        break;

      case "DELETED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.delete(entity.id);
          await this.dispatch(
            "DELETED",
            entity,
            e.emittedAt !== undefined ? { emittedAt: e.emittedAt } : undefined,
          );
        }
        break;
    }
  }

  private async commitReplace(incoming: Map<string, EntityForKind<K>>): Promise<void> {
    const deleted: Array<EntityForKind<K>> = [];
    const added: Array<EntityForKind<K>> = [];
    const modified: Array<EntityForKind<K>> = [];

    for (const [id, old] of this.store) {
      if (!incoming.has(id)) deleted.push(old);
    }
    for (const [id, entity] of incoming) {
      const existing = this.store.get(id);
      if (!existing) {
        added.push(entity);
      } else if (existing.resourceVersion !== entity.resourceVersion) {
        modified.push(entity);
      }
    }

    // Atomic replace — handlers see consistent post-update state.
    this.store.clear();
    for (const [id, entity] of incoming) {
      this.store.set(id, entity);
    }

    for (const e of deleted) await this.dispatch("DELETED", e, undefined);
    for (const e of added) await this.dispatch("ADDED", e, undefined);
    for (const e of modified) await this.dispatch("MODIFIED", e, undefined);
  }

  private fireSync(): void {
    // Snapshot before iterating so a handler that calls its own unsubscribe
    // mid-iteration does not skip the next handler.
    for (const handler of [...this.syncHandlers]) {
      try {
        handler();
      } catch (err) {
        console.error("Informer: sync handler threw, continuing fanout:", err);
      }
    }
  }

  private async dispatch(
    op: InformerOp,
    entity: EntityForKind<K>,
    meta?: { readonly emittedAt?: string },
  ): Promise<void> {
    // Snapshot before iterating so a handler that calls its own unsubscribe
    // (which splices the live array) does not cause the next handler to be
    // skipped by the iterator advancing past the shifted index.
    // Handlers are awaited sequentially so WatchClient's per-event serialization
    // extends through the full fanout chain — a slow handler blocks the next event.
    // Each handler is raced against the run() abort signal so a non-settling
    // async handler cannot permanently wedge the loop or leave _running = true.
    // Note: raceAbort only aborts when the signal fires WHILE the handler is
    // still pending. A sync handler that calls abort() and returns immediately
    // resolves before the abort listener can fire (per AbortSignal semantics),
    // so subsequent handlers in the snapshot still receive the same event.
    const signal = this._signal;
    for (const handler of [...this.handlers]) {
      try {
        await raceAbort(Promise.resolve(handler(op, entity, meta)), signal);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("Informer: event handler threw or rejected, continuing fanout:", err);
      }
    }
  }
}

/** Deep-freeze an entity so no field at any nesting depth can be mutated externally. */
function freeze<T>(val: T): T {
  if (val === null || typeof val !== "object" || Object.isFrozen(val)) return val;
  for (const v of Object.values(val as object)) freeze(v);
  Object.freeze(val);
  return val;
}

/**
 * Race a promise against an abort signal. Rejects with AbortError if the
 * signal fires WHILE the promise is still pending. Crucially, does NOT
 * check signal.aborted upfront — AbortSignal event listeners registered
 * on an already-aborted signal do not re-fire, so a sync handler that
 * calls abort() and returns immediately will resolve before the abort can
 * race it. Pass null signal to skip the race entirely.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export type Backoff = NonNullable<WatchClientOptions["backoff"]>;

interface InformerFactoryBaseOptions {
  /**
   * Per-kind override for `InformerOptions.queueLimit`. Kinds not present
   * in the map fall back to the Informer default (1000). Wired into each
   * factory-created Informer's constructor along with an `onOverflow`
   * callback that triggers `factory.relist(kind)` to recover from drops.
   */
  readonly queueLimits?: Partial<Record<WatchKind, number>>;
}

export type InformerFactoryOptions = InformerFactoryBaseOptions &
  (
    | {
        readonly mode: "remote";
        readonly baseUrl: string;
        readonly authHeader: string;
        readonly fetch?: typeof fetch;
        readonly backoff?: Backoff;
      }
    | {
        readonly mode: "local";
        readonly hub: WatchHub;
        readonly namespace: string;
        /**
         * Snapshot source per kind. Sync and async shapes both supported so
         * Promise-returning local stores (`ContributionStore.listEntities`,
         * `ClaimStore.listEntities`) can be wired without forcing callers to
         * pre-await. LocalWatchClient awaits the result before iteration.
         */
        readonly listFn: (
          kind: WatchKind,
        ) => readonly WatchEntity[] | Promise<readonly WatchEntity[]>;
      }
  );

export type FactoryErrorListener = (kind: WatchKind, err: Error | null) => void;

interface RunningInformer {
  readonly informer: Informer;
  controller: AbortController;
  runPromise: Promise<void> | null;
  /** Generation token: incremented every (re)start. Lets a settling run
   * identify whether the runPromise it owns is still the live one before
   * clearing factory state, so a concurrent restart can't be undone by a
   * late `runPromise = null` from a previous generation. */
  generation: number;
  /** Last terminal error from `informer.run()`, if any. Cleared on next start. */
  lastError: Error | null;
  /** Serialization lock: relist/startKind operations chain on this so two
   * overlapping calls don't race on controller/runPromise state. */
  lifecycleLock: Promise<void>;
}

/**
 * Kinds the factory will start eagerly via `startAll()` AND the only kinds
 * `informerFor` will accept — split per-mode.
 *
 * Remote: AgentSession is excluded because the grove-server `/api/list`
 * route currently returns 501 NOT_CONFIGURED for it (handler exists, list
 * source not wired). AgentTask is backed by the server task store when
 * configured.
 *
 * Local: AgentSession and AgentTask are supported — the in-process
 * `WatchHub` plus caller-provided list snapshots cover them without any
 * server route.
 *
 * Asking for an unsupported kind throws — louder than handing back an
 * informer that would silently never sync.
 */
const REMOTE_KINDS: readonly WatchKind[] = [
  "Contribution",
  "Claim",
  "AgentTask",
  "WorkBlock",
  "TimelineEvent",
];
const LOCAL_KINDS: readonly WatchKind[] = [
  "Contribution",
  "Claim",
  "AgentSession",
  "AgentTask",
  "WorkBlock",
  "TimelineEvent",
];

const REMOTE_SUPPORTED = new Set<WatchKind>(REMOTE_KINDS);
const LOCAL_SUPPORTED = new Set<WatchKind>(LOCAL_KINDS);

/**
 * InformerFactory memoizes one Informer per kind for a single namespace
 * scope (the namespace is encoded in `authHeader` via the server's auth
 * middleware). For multiple namespaces, create one factory per namespace
 * with the corresponding auth credentials.
 */
export class InformerFactory {
  private readonly opts: InformerFactoryOptions;
  private readonly running = new Map<string, RunningInformer>();
  private readonly errorListeners: Array<FactoryErrorListener> = [];

  constructor(opts: InformerFactoryOptions) {
    this.opts = opts;
  }

  get mode(): "remote" | "local" {
    return this.opts.mode;
  }

  /**
   * Whether the constructed mode supports the given kind. Used by hook
   * call sites that gate AgentSession migrations: in remote mode the
   * factory does not yet support AgentSession (server returns 501), so
   * views must fall back to a non-reactive path (e.g. tmux poller). In
   * local mode all three kinds are supported.
   */
  supportsKind(kind: WatchKind): boolean {
    return this.supportedKinds().has(kind);
  }

  private supportedKinds(): ReadonlySet<WatchKind> {
    return this.opts.mode === "remote" ? REMOTE_SUPPORTED : LOCAL_SUPPORTED;
  }

  private allKinds(): readonly WatchKind[] {
    return this.opts.mode === "remote" ? REMOTE_KINDS : LOCAL_KINDS;
  }

  /**
   * Subscribe to terminal `informer.run()` rejections. Fires with the
   * captured Error after a kind's run loop rejects, and again with `null`
   * when a subsequent restart succeeds (i.e. clears the error). Hooks use
   * this to surface auth/config/server failures instead of leaving
   * consumers stuck at `hasSynced=false` with no error.
   */
  addErrorListener(fn: FactoryErrorListener): () => void {
    this.errorListeners.push(fn);
    return () => {
      const idx = this.errorListeners.indexOf(fn);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  private fireError(kind: WatchKind, err: Error | null): void {
    for (const fn of [...this.errorListeners]) {
      try {
        fn(kind, err);
      } catch (e) {
        console.error("InformerFactory: error listener threw, continuing fanout:", e);
      }
    }
  }

  /**
   * Returns the Informer for a kind. Lazily constructs it on first call,
   * but does NOT start `run()` — call `startAll()` to start watching.
   * Throws for kinds the server does not yet support — see SUPPORTED_KINDS
   * comment for the AgentSession rationale.
   */
  informerFor<K extends WatchKind>(kind: K): Informer<K> {
    const supported = this.supportedKinds();
    if (!supported.has(kind)) {
      throw new Error(
        `InformerFactory.informerFor(${kind}): kind not supported in mode=${this.opts.mode}. Supported: ${[
          ...supported,
        ].join(", ")}.`,
      );
    }
    const existing = this.running.get(kind);
    if (existing) return existing.informer as Informer<K>;
    const stream = this.makeStream(kind);
    const informer = new Informer<K>(stream, kind, {
      queueLimit: this.opts.queueLimits?.[kind] ?? 1000,
      onOverflow: (k) => {
        void this.relist(k);
      },
    });
    this.running.set(kind, {
      informer: informer as Informer,
      controller: new AbortController(),
      runPromise: null,
      generation: 0,
      lastError: null,
      lifecycleLock: Promise.resolve(),
    });
    return informer;
  }

  /**
   * Start `run()` on all known kinds. Idempotent — already-started kinds
   * are skipped. Caller is responsible for `stopAll()` (or aborting the
   * parent signal) on shutdown.
   */
  startAll(): void {
    for (const kind of this.allKinds()) {
      this.startKind(kind);
    }
  }

  /**
   * Abort all running informers. After this returns, the run() promises
   * have settled and the factory is reusable.
   */
  async stopAll(): Promise<void> {
    // Serialize against in-flight relist/startKind so a concurrent restart
    // can't replace the controller after we've aborted but before we await.
    const stops = [...this.running.values()].map((r) => this.withLock(r, () => this.stopOne(r)));
    await Promise.all(stops);
  }

  /**
   * Force a relist on a single kind (or all kinds when undefined). Aborts
   * the current run, awaits its settlement, then starts a new run with a
   * fresh AbortController. Per-kind serialized so two overlapping callers
   * don't lose track of the live controller or runPromise.
   */
  async relist(kind?: WatchKind): Promise<void> {
    const kinds: WatchKind[] = kind ? [kind] : [...this.allKinds()];
    const targets = kinds
      .map((k) => this.running.get(k))
      .filter((r): r is RunningInformer => r !== undefined);

    await Promise.all(
      kinds.map((k) => {
        const r = this.running.get(k);
        if (!r) return Promise.resolve();
        return this.withLock(r, async () => {
          await this.stopOne(r);
          r.controller = new AbortController();
          this.startOne(k, r);
        });
      }),
    );
    // Reference targets so unused-var lints don't trip — this is the
    // pre-filtered list used to avoid creating informers for unknown kinds.
    void targets;
  }

  /** Last terminal error captured from a kind's `run()`, if any. */
  getLastError(kind: WatchKind): Error | null {
    return this.running.get(kind)?.lastError ?? null;
  }

  private startKind(kind: WatchKind): void {
    let r = this.running.get(kind);
    if (!r) {
      this.informerFor(kind);
      r = this.running.get(kind);
      if (!r) throw new Error(`unreachable: informerFor(${kind}) did not register a running entry`);
    }
    const entry = r;
    void this.withLock(entry, async () => {
      this.startOne(kind, entry);
    });
  }

  /**
   * Relist a single kind via internal lock — used by the in-process
   * `RefreshContext` button (and PR2 hook bindings).
   */

  /**
   * Start a fresh `run()` if not already running. Wraps the run promise so
   * terminal errors clear `runPromise` (allowing future restart), record
   * `lastError`, fire the factory's error listeners, and never bubble as
   * unhandled rejections. The generation token guards against a settling
   * run from a prior generation clearing state owned by the current one.
   */
  private startOne(kind: WatchKind, r: RunningInformer): void {
    if (r.runPromise) return;
    if (r.controller.signal.aborted) {
      r.controller = new AbortController();
    }
    r.generation += 1;
    const generation = r.generation;
    // Do NOT clear lastError on start — clearing here would fire `null` to
    // listeners while the new run is still pending or backing off, making
    // hooks drop their visible error even though sync has not been re-proven.
    // Wait for a concrete recovery signal: first successful RELIST_END after
    // this start. The sync handler below clears + fires null exactly once.
    // Subscribe with fireIfSynced=false so a stale `_synced === true` from
    // the prior run doesn't trigger us synchronously and clear the error
    // before the new run has actually re-proven sync.
    const recovery = r.informer.addSyncHandler(() => {
      // Stale-generation handlers must not clear errors owned by a newer run.
      if (r.generation !== generation) {
        recovery();
        return;
      }
      if (r.lastError !== null) {
        r.lastError = null;
        this.fireError(kind, null);
      }
      // One-shot: detach after firing once. Subsequent syncs are healthy
      // by definition and don't need to fire null again.
      recovery();
    }, false);
    const signal = r.controller.signal;
    const informer = r.informer;
    r.runPromise = informer.run(signal).then(
      () => {
        if (r.generation === generation) {
          r.runPromise = null;
          recovery();
        }
      },
      (err: unknown) => {
        if (r.generation === generation) {
          r.runPromise = null;
          recovery();
          const errorObj = err instanceof Error ? err : new Error(String(err));
          r.lastError = errorObj;
          // Log so terminal failures (auth/config/permanent server errors)
          // aren't silently swallowed when no error listener is registered.
          console.warn(`Informer[${kind}]: run() failed: ${errorObj.message}`);
          this.fireError(kind, errorObj);
        }
      },
    );
  }

  /**
   * Abort the current run (if any) and await settlement. Safe to call when
   * no run is active — resolves immediately. Caller must hold lifecycleLock.
   */
  private async stopOne(r: RunningInformer): Promise<void> {
    r.controller.abort();
    if (r.runPromise) await r.runPromise;
  }

  /**
   * Chain `op` onto the running entry's lifecycle lock so concurrent
   * relist/start/stop calls execute one-at-a-time per kind. Errors in `op`
   * are preserved on the lock chain — but never block subsequent operations
   * since the lock is reset to a resolved state regardless of outcome.
   */
  private withLock<T>(r: RunningInformer, op: () => Promise<T>): Promise<T> {
    const next = r.lifecycleLock.then(op, op);
    r.lifecycleLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private makeStream(kind: WatchKind): WatchStream {
    const opts = this.opts;
    if (opts.mode === "remote") {
      const clientOpts: WatchClientOptions = {
        baseUrl: opts.baseUrl,
        kind,
        authHeader: opts.authHeader,
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
        ...(opts.backoff !== undefined ? { backoff: opts.backoff } : {}),
      };
      return new WatchClient(clientOpts);
    }
    return new LocalWatchClient({
      hub: opts.hub,
      kind,
      namespace: opts.namespace,
      listFn: () => opts.listFn(kind),
    });
  }
}
