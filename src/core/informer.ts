/**
 * Informer<K> — K8s-informer-style local cache with event fanout (#294).
 *
 * Wraps WatchClient to maintain a Map<id, Entity> that tracks server state
 * via the list→watch handshake. One Informer per kind is shared across all
 * subscribers via InformerFactory.
 *
 * HasSynced() returns true only after the first RELIST_END so the TUI can
 * gate first render on a fully-populated cache (no empty-flash).
 */

import type { AgentSessionEntity, ClaimEntity, ContributionEntity } from "./entity.js";
import { WatchClient, type WatchClientEvent, type WatchClientOptions } from "./watch-client.js";
import type { WatchKind } from "./watch-events.js";

type EntityForKind<K extends WatchKind> = K extends "Contribution"
  ? ContributionEntity
  : K extends "Claim"
    ? ClaimEntity
    : K extends "AgentSession"
      ? AgentSessionEntity
      : never;

export type InformerOp = "ADDED" | "MODIFIED" | "DELETED";

export type EventHandlerFn<K extends WatchKind = WatchKind> = (
  op: InformerOp,
  entity: EntityForKind<K>,
) => void | Promise<void>;

export class Informer<K extends WatchKind = WatchKind> {
  private readonly clientOpts: WatchClientOptions;
  private readonly store = new Map<string, EntityForKind<K>>();
  private readonly handlers: Array<EventHandlerFn<K>> = [];
  private _synced = false;
  private staging: Map<string, EntityForKind<K>> | null = null;
  private _running = false;

  constructor(opts: WatchClientOptions) {
    this.clientOpts = opts;
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
    try {
      const client = new WatchClient(this.clientOpts);
      await client.run({ onEvent: (e) => this.onEvent(e), signal });
    } finally {
      this._running = false;
    }
  }

  private onEvent(e: WatchClientEvent): void {
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
        this.commitReplace(this.staging);
        this.staging = null;
        break;

      case "RELIST_ABORTED":
        this.staging = null;
        break;

      case "ADDED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          this.dispatch("ADDED", entity);
        }
        break;

      case "MODIFIED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.set(entity.id, entity);
          this.dispatch("MODIFIED", entity);
        }
        break;

      case "DELETED":
        if (e.entity) {
          const entity = freeze(e.entity as EntityForKind<K>);
          this.store.delete(entity.id);
          this.dispatch("DELETED", entity);
        }
        break;
    }
  }

  private commitReplace(incoming: Map<string, EntityForKind<K>>): void {
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

    for (const e of deleted) this.dispatch("DELETED", e);
    for (const e of added) this.dispatch("ADDED", e);
    for (const e of modified) this.dispatch("MODIFIED", e);
  }

  private dispatch(op: InformerOp, entity: EntityForKind<K>): void {
    // Snapshot before iterating so a handler that calls its own unsubscribe
    // (which splices the live array) does not cause the next handler to be
    // skipped by the iterator advancing past the shifted index.
    for (const handler of [...this.handlers]) {
      try {
        const result = handler(op, entity);
        if (result instanceof Promise) {
          // Async handler: catch rejection so it doesn't become an unhandled
          // promise rejection while still logging the failure for diagnosis.
          result.catch((err) => {
            console.error("Informer: async event handler rejected:", err);
          });
        }
      } catch (err) {
        console.error("Informer: event handler threw, continuing fanout:", err);
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

export interface InformerFactoryOptions {
  readonly baseUrl: string;
  readonly authHeader: string;
  readonly fetch?: typeof fetch;
  readonly backoff?: WatchClientOptions["backoff"];
}

/**
 * InformerFactory memoizes one Informer per kind for a single namespace
 * scope (the namespace is encoded in `authHeader` via the server's auth
 * middleware). For multiple namespaces, create one factory per namespace
 * with the corresponding auth credentials.
 */
export class InformerFactory {
  private readonly opts: InformerFactoryOptions;
  // key: kind string
  private readonly informers = new Map<string, Informer>();

  constructor(opts: InformerFactoryOptions) {
    this.opts = opts;
  }

  informerFor<K extends WatchKind>(kind: K): Informer<K> {
    let informer = this.informers.get(kind) as Informer<K> | undefined;
    if (!informer) {
      informer = new Informer<K>({
        baseUrl: this.opts.baseUrl,
        kind,
        authHeader: this.opts.authHeader,
        fetch: this.opts.fetch,
        backoff: this.opts.backoff,
      });
      this.informers.set(kind, informer as Informer);
    }
    return informer;
  }
}
