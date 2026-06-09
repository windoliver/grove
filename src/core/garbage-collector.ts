import type { CasMutationResult, CasOpts } from "./cas.js";
import {
  type GcAction,
  type GcNode,
  type GcRef,
  planDanglingChild,
  planOwnerDeletion,
  refOf,
} from "./owner-graph.js";
import { withIfMatch } from "./with-if-match.js";
import { KeyedWorkQueue, QueueClosedError, type WorkItemResult } from "./workqueue.js";

/**
 * Segregated store surface the GarbageCollector depends on. Concrete stores
 * (in-memory fixture, AgentTask adapter, composite) implement it. Mutators are
 * CAS-aware and return the post-write node so the loop can thread retries.
 */
export interface GcStore {
  getNode(ref: GcRef): Promise<GcNode | undefined>;
  /** All nodes that currently have a deletionTimestamp set. */
  listPendingDeletion(): Promise<readonly GcNode[]>;
  /** All nodes carrying any ownerRef whose uid === ownerUid. */
  listOwnedBy(ownerUid: string): Promise<readonly GcNode[]>;
  setDeletionTimestamp(
    ref: GcRef,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>>;
  removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
  removeFinalizer(ref: GcRef, finalizer: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
  /** Hard-delete. MUST reject (throw) if the node still has finalizers. */
  reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
}

export interface GarbageCollectorOptions {
  readonly store: GcStore;
  readonly queue?: KeyedWorkQueue | undefined;
  readonly resyncIntervalMs?: number | undefined;
  readonly workerCount?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((error: unknown, key: string) => void) | undefined;
  readonly onAction?: ((action: GcAction) => void) | undefined;
}

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_COUNT = 1;
const MAX_RESYNC_INTERVAL_MS = 2_147_483_647;
const MAX_WORKER_COUNT = 1_000;

/** Sentinel: the target node vanished mid-reconcile (already reaped). Benign. */
class NodeVanished extends Error {
  constructor() {
    super("gc target node vanished");
    this.name = "NodeVanished";
  }
}

export function gcKey(ref: GcRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseGcKey(key: string): GcRef {
  const idx = key.indexOf(":");
  if (idx === -1) throw new Error(`invalid gc key: ${key}`);
  return { kind: key.slice(0, idx) as GcRef["kind"], id: key.slice(idx + 1) };
}

export class GarbageCollector {
  private readonly store: GcStore;
  private readonly queue: KeyedWorkQueue;
  private readonly now: () => number;
  private readonly resyncIntervalMs: number;
  private readonly workerCount: number;
  private readonly onError: ((error: unknown, key: string) => void) | undefined;
  private readonly onAction: ((action: GcAction) => void) | undefined;
  private running = false;
  private stopRequested = false;
  private workers: Promise<void>[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: GarbageCollectorOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new KeyedWorkQueue({ now: this.now });
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    if (
      !Number.isFinite(this.resyncIntervalMs) ||
      this.resyncIntervalMs < 1 ||
      this.resyncIntervalMs > MAX_RESYNC_INTERVAL_MS
    ) {
      throw new RangeError(
        `resyncIntervalMs must be a finite positive number no greater than ${MAX_RESYNC_INTERVAL_MS}`,
      );
    }
    if (!Number.isInteger(this.workerCount) || this.workerCount < 1 || this.workerCount > MAX_WORKER_COUNT) {
      throw new RangeError(`workerCount must be an integer between 1 and ${MAX_WORKER_COUNT}`);
    }
    this.onError = options.onError;
    this.onAction = options.onAction;
  }

  enqueue(ref: GcRef): void {
    this.queue.enqueue(gcKey(ref));
  }

  async resync(): Promise<number> {
    const pending = await this.store.listPendingDeletion();
    for (const node of pending) {
      this.enqueue(refOf(node));
      const children = await this.store.listOwnedBy(node.uid);
      for (const child of children) this.enqueue(refOf(child));
    }
    return pending.length;
  }

  async reconcileNode(ref: GcRef): Promise<void> {
    const node = await this.store.getNode(ref);
    if (node === undefined) return;

    let actions: readonly GcAction[];
    if (node.deletionTimestamp !== undefined) {
      const children = await this.store.listOwnedBy(node.uid);
      actions = planOwnerDeletion(node, children);
    } else {
      actions = planDanglingChild(node, await this.ownerExists(node));
    }

    for (const action of actions) {
      try {
        await this.execute(action);
        this.onAction?.(action);
        // Promptly re-reconcile the touched node so multi-step convergence
        // (mark → reap, orphan → remove-finalizer → reap) does not wait for
        // the next resync.
        this.enqueue(action.ref);
      } catch (error) {
        if (error instanceof NodeVanished) continue;
        throw error;
      }
    }
  }

  start(): void {
    if (this.running) return;
    if (this.stopRequested) throw new QueueClosedError();
    this.running = true;
    this.stopRequested = false;
    for (let i = 0; i < this.workerCount; i += 1) {
      this.workers.push(this.workerLoop());
    }
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => this.reportError(error, "__resync__"));
    }, this.resyncIntervalMs);
    this.resyncTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running && this.stopRequested) return;
    this.stopRequested = true;
    if (this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.queue.close();
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers);
    this.running = false;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let item: WorkItemResult;
      try {
        item = await this.queue.take();
      } catch (error) {
        if (this.stopRequested) return;
        throw error;
      }
      try {
        await this.reconcileNode(parseGcKey(item.key));
        this.queue.acknowledge(item.key);
      } catch (error) {
        if (!this.stopRequested) this.queue.retry(item.key);
        this.reportError(error, item.key);
      }
    }
  }

  private async ownerExists(node: GcNode): Promise<boolean> {
    const controller = node.ownerRefs.find((ref) => ref.controller === true);
    if (controller === undefined) return true; // not a dangling candidate
    const owner = await this.store.getNode({ kind: controller.kind, id: controller.id });
    return owner !== undefined && owner.uid === controller.uid;
  }

  private async execute(action: GcAction): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    await this.casMutate(action.ref, (opts) => {
      switch (action.type) {
        case "mark-deletion":
          return this.store.setDeletionTimestamp(action.ref, nowIso, opts);
        case "orphan":
          return this.store.removeOwnerRef(action.ref, action.ownerUid, opts);
        case "remove-finalizer":
          return this.store.removeFinalizer(action.ref, action.finalizer, opts);
        case "reap":
          return this.store.reap(action.ref, opts);
      }
    });
  }

  private async casMutate(
    ref: GcRef,
    patch: (opts: CasOpts) => Promise<CasMutationResult<GcNode>>,
  ): Promise<void> {
    await withIfMatch<GcNode>(
      async () => {
        const cur = await this.store.getNode(ref);
        if (cur === undefined) throw new NodeVanished();
        return { resourceVersion: cur.resourceVersion };
      },
      (opts) => patch({ ifMatch: opts.ifMatch }),
    );
  }

  private reportError(error: unknown, key: string): void {
    try {
      this.onError?.(error, key);
    } catch {
      return;
    }
  }
}
