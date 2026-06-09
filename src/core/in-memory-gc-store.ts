import { type CasMismatchResult, type CasMutationResult, type CasOpts } from "./cas.js";
import type { GcStore } from "./garbage-collector.js";
import { gcKey } from "./garbage-collector.js";
import type { GcNode, GcRef } from "./owner-graph.js";

interface MutableNode {
  kind: GcNode["kind"];
  id: string;
  uid: string;
  rv: number;
  ownerRefs: GcNode["ownerRefs"];
  finalizers: string[];
  deletionTimestamp?: string | undefined;
}

function toGcNode(n: MutableNode): GcNode {
  return {
    kind: n.kind,
    id: n.id,
    uid: n.uid,
    resourceVersion: String(n.rv),
    ownerRefs: n.ownerRefs,
    finalizers: [...n.finalizers],
    deletionTimestamp: n.deletionTimestamp,
  };
}

/** In-memory GcStore holding nodes of every kind. For tests/fixtures only. */
export class InMemoryGcStore implements GcStore {
  private readonly nodes = new Map<string, MutableNode>();

  /** Seed a node. Returns the key. */
  put(node: Omit<GcNode, "resourceVersion"> & { resourceVersion?: string }): void {
    this.nodes.set(gcKey(node), {
      kind: node.kind,
      id: node.id,
      uid: node.uid,
      rv: node.resourceVersion === undefined ? 1 : Number(node.resourceVersion),
      ownerRefs: node.ownerRefs,
      finalizers: [...node.finalizers],
      deletionTimestamp: node.deletionTimestamp,
    });
  }

  has(ref: GcRef): boolean {
    return this.nodes.has(gcKey(ref));
  }

  async getNode(ref: GcRef): Promise<GcNode | undefined> {
    const n = this.nodes.get(gcKey(ref));
    return n === undefined ? undefined : toGcNode(n);
  }

  async listPendingDeletion(): Promise<readonly GcNode[]> {
    return [...this.nodes.values()].filter((n) => n.deletionTimestamp !== undefined).map(toGcNode);
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    return [...this.nodes.values()]
      .filter((n) => n.ownerRefs.some((r) => r.uid === ownerUid))
      .map(toGcNode);
  }

  async setDeletionTimestamp(
    ref: GcRef,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      if (n.deletionTimestamp === undefined) n.deletionTimestamp = deletionTimestamp;
    });
  }

  async removeOwnerRef(
    ref: GcRef,
    ownerUid: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      n.ownerRefs = n.ownerRefs.filter((r) => r.uid !== ownerUid);
    });
  }

  async removeFinalizer(
    ref: GcRef,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      n.finalizers = n.finalizers.filter((f) => f !== finalizer);
    });
  }

  async reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    const key = gcKey(ref);
    const n = this.nodes.get(key);
    if (n === undefined) {
      // Already gone — surface as a benign mismatch so the loop's getNode
      // probe (which throws NodeVanished) handles it; never reached in practice
      // because the loop reads first.
      return { kind: "rv-mismatch", current: { resourceVersion: "0", generation: 0 } };
    }
    const mismatch = this.checkCas(n, opts);
    if (mismatch !== null) return mismatch;
    if (n.finalizers.length > 0) {
      throw new Error(`reap refused: ${key} still has finalizers [${n.finalizers.join(", ")}]`);
    }
    const view = toGcNode(n);
    this.nodes.delete(key);
    return { kind: "ok", view };
  }

  private mutate(
    ref: GcRef,
    opts: CasOpts | undefined,
    apply: (n: MutableNode) => void,
  ): CasMutationResult<GcNode> {
    const n = this.nodes.get(gcKey(ref));
    if (n === undefined) {
      return { kind: "rv-mismatch", current: { resourceVersion: "0", generation: 0 } };
    }
    const mismatch = this.checkCas(n, opts);
    if (mismatch !== null) return mismatch;
    apply(n);
    n.rv += 1;
    return { kind: "ok", view: toGcNode(n) };
  }

  private checkCas(n: MutableNode, opts: CasOpts | undefined): CasMismatchResult | null {
    if (opts?.ifMatch === undefined) return null;
    if (opts.ifMatch === String(n.rv)) return null;
    return { kind: "rv-mismatch", current: { resourceVersion: String(n.rv), generation: n.rv } };
  }
}
