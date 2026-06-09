import type { AgentTaskView } from "./agent-task.js";
import type { CasMutationResult, CasOpts } from "./cas.js";
import type { GcStore } from "./garbage-collector.js";
import type { GcNode, GcRef } from "./owner-graph.js";
import type { AgentTaskStore } from "./store.js";

/** Project an AgentTaskView onto the GcNode lifecycle shape. */
function taskToGcNode(view: AgentTaskView): GcNode {
  return {
    kind: "agentTask",
    id: view.spec.id,
    // AgentTask has no separate uid column; its id is its stable, immutable primary
    // key that is never reused — so it is safe to use as the GC identity and as the
    // target of ownerRef.uid references.
    uid: view.spec.id,
    // `spec.resourceVersion` is the persisted `resource_version` column, always set
    // for rows created/touched after migration v16 — so it matches what the store's
    // checkIfMatch compares (String(spec.resource_version)). The `generation`
    // fallback only covers legacy pre-v16 rows, which the v16 migration initializes
    // to MAX(generation,1), keeping the values aligned. So the GC's CAS ifMatch
    // round-trip agrees in practice.
    resourceVersion: String(view.spec.resourceVersion ?? view.spec.generation),
    ownerRefs: view.spec.ownerRef === undefined ? [] : [view.spec.ownerRef],
    finalizers: view.spec.finalizers ?? [],
    deletionTimestamp: view.spec.deletionTimestamp,
  };
}

function mapResult(r: CasMutationResult<AgentTaskView>): CasMutationResult<GcNode> {
  return r.kind === "ok" ? { kind: "ok", view: taskToGcNode(r.view) } : r;
}

/** GcStore scoped to the `agentTask` kind, backed by a real AgentTaskStore. */
export class AgentTaskGcStore implements GcStore {
  private readonly store: AgentTaskStore;
  constructor(store: AgentTaskStore) {
    this.store = store;
  }

  private assertKind(ref: GcRef): void {
    if (ref.kind !== "agentTask") {
      throw new Error(`AgentTaskGcStore received non-agentTask ref: ${ref.kind}:${ref.id}`);
    }
  }

  // Soft-return (not assertKind-throw) because the GC's ownerExists probe may getNode across kinds; CompositeGcStore.route() already gates wrong-kind mutators.
  async getNode(ref: GcRef): Promise<GcNode | undefined> {
    if (ref.kind !== "agentTask") return undefined;
    const view = await this.store.getAgentTask(ref.id);
    return view === undefined ? undefined : taskToGcNode(view);
  }

  // TODO: these full-scan listAgentTasks() then filter in memory; push the filter into AgentTaskQuery (WHERE deletion_timestamp IS NOT NULL / owner uid) when the store query supports it, to avoid O(tasks) scans per resync.
  async listPendingDeletion(): Promise<readonly GcNode[]> {
    const all = await this.store.listAgentTasks();
    return all.filter((v) => v.spec.deletionTimestamp !== undefined).map(taskToGcNode);
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    const all = await this.store.listAgentTasks();
    return all
      .filter((v) => v.spec.ownerRef !== undefined && v.spec.ownerRef.uid === ownerUid)
      .map(taskToGcNode);
  }

  async setDeletionTimestamp(
    ref: GcRef,
    ts: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    this.assertKind(ref);
    return mapResult(await this.store.setAgentTaskDeletion(ref.id, ts, opts));
  }

  async removeOwnerRef(
    ref: GcRef,
    ownerUid: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    this.assertKind(ref);
    return mapResult(await this.store.removeAgentTaskOwnerRef(ref.id, ownerUid, opts));
  }

  async removeFinalizer(
    ref: GcRef,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    this.assertKind(ref);
    return mapResult(await this.store.removeAgentTaskFinalizer(ref.id, finalizer, opts));
  }

  async reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    this.assertKind(ref);
    return mapResult(await this.store.reapAgentTask(ref.id, opts));
  }
}

/**
 * Routes GcStore calls to a per-kind backing store, and fans `listPendingDeletion`
 * / `listOwnedBy` across all of them. Lets the GarbageCollector span a TaskGroup
 * owner (one store) and AgentTask children (another) as one logical graph.
 */
export class CompositeGcStore implements GcStore {
  private readonly byKind: ReadonlyMap<GcRef["kind"], GcStore>;
  constructor(byKind: ReadonlyMap<GcRef["kind"], GcStore>) {
    this.byKind = byKind;
  }

  private route(ref: GcRef): GcStore {
    const store = this.byKind.get(ref.kind);
    if (store === undefined) throw new Error(`no GcStore registered for kind ${ref.kind}`);
    return store;
  }

  getNode(ref: GcRef): Promise<GcNode | undefined> {
    return this.route(ref).getNode(ref);
  }

  async listPendingDeletion(): Promise<readonly GcNode[]> {
    const out: GcNode[] = [];
    for (const store of this.byKind.values()) out.push(...(await store.listPendingDeletion()));
    return out;
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    const out: GcNode[] = [];
    for (const store of this.byKind.values()) out.push(...(await store.listOwnedBy(ownerUid)));
    return out;
  }

  setDeletionTimestamp(ref: GcRef, ts: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    return this.route(ref).setDeletionTimestamp(ref, ts, opts);
  }
  removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    return this.route(ref).removeOwnerRef(ref, ownerUid, opts);
  }
  removeFinalizer(
    ref: GcRef,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.route(ref).removeFinalizer(ref, finalizer, opts);
  }
  reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    return this.route(ref).reap(ref, opts);
  }
}
