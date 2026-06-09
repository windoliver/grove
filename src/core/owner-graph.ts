/**
 * Pure cascade/reap decision core for the garbage collector (Epic D #306).
 *
 * No I/O, no async, no clock — every function is a pure projection over an
 * entity snapshot, so cascade logic is unit-testable in isolation. The
 * GarbageCollector loop (garbage-collector.ts) supplies the snapshots and
 * executes the returned actions against a store.
 */

import {
  type CascadePolicy,
  type OwnerKind,
  type OwnerRef,
  PropagationFinalizer,
} from "./lifecycle-metadata.js";

/** Identity of a GC-managed node: (kind, id). */
export interface GcRef {
  readonly kind: OwnerKind;
  readonly id: string;
}

/** Minimal lifecycle projection of any GC-managed entity. */
export interface GcNode {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  /** Resource version for CAS writes (string, store-defined). */
  readonly resourceVersion: string;
  readonly ownerRefs: readonly OwnerRef[];
  readonly finalizers: readonly string[];
  readonly deletionTimestamp?: string | undefined;
}

/** One reconcile-step action. The loop stamps timestamps and threads CAS. */
export type GcAction =
  | { readonly type: "mark-deletion"; readonly ref: GcRef }
  | { readonly type: "orphan"; readonly ref: GcRef; readonly ownerUid: string }
  | { readonly type: "remove-finalizer"; readonly ref: GcRef; readonly finalizer: string }
  | { readonly type: "reap"; readonly ref: GcRef };

export function refOf(node: GcNode): GcRef {
  return { kind: node.kind, id: node.id };
}

/** Derive cascade policy from the propagation finalizer the owner carries. */
export function policyOf(owner: GcNode): CascadePolicy {
  if (owner.finalizers.includes(PropagationFinalizer.Foreground)) return "Foreground";
  if (owner.finalizers.includes(PropagationFinalizer.Orphan)) return "Orphan";
  return "Background";
}

/** Does `child` carry a controller ownerRef pointing at `ownerUid`? */
function controlledBy(child: GcNode, ownerUid: string): boolean {
  return child.ownerRefs.some((ref) => ref.uid === ownerUid && ref.controller === true);
}

/** Reap only when deletion is requested AND every finalizer is cleared. */
function reapIfReady(node: GcNode): readonly GcAction[] {
  if (node.deletionTimestamp === undefined) return [];
  return node.finalizers.length === 0 ? [{ type: "reap", ref: refOf(node) }] : [];
}

/**
 * One idempotent reconcile step for a node that has a deletionTimestamp.
 * Cascades to its controlled children per policy, then reaps itself when ready.
 * Returns `[]` when the node is not being deleted or the world is converged.
 */
export function planOwnerDeletion(
  owner: GcNode,
  children: readonly GcNode[],
): readonly GcAction[] {
  if (owner.deletionTimestamp === undefined) return [];
  const controlled = children.filter((child) => controlledBy(child, owner.uid));
  const policy = policyOf(owner);

  if (policy === "Orphan") {
    if (controlled.length > 0) {
      return controlled.map((child) => ({
        type: "orphan" as const,
        ref: refOf(child),
        ownerUid: owner.uid,
      }));
    }
    if (owner.finalizers.includes(PropagationFinalizer.Orphan)) {
      return [
        { type: "remove-finalizer", ref: refOf(owner), finalizer: PropagationFinalizer.Orphan },
      ];
    }
    return reapIfReady(owner);
  }

  if (policy === "Foreground") {
    const blocking = controlled.filter((child) => child.deletionTimestamp === undefined);
    if (blocking.length > 0) {
      return blocking.map((child) => ({ type: "mark-deletion" as const, ref: refOf(child) }));
    }
    // Children are marked but still present — stay Terminating until they're gone.
    if (controlled.length > 0) return [];
    if (owner.finalizers.includes(PropagationFinalizer.Foreground)) {
      return [
        {
          type: "remove-finalizer",
          ref: refOf(owner),
          finalizer: PropagationFinalizer.Foreground,
        },
      ];
    }
    return reapIfReady(owner);
  }

  // Background: mark children for async GC, reap owner immediately.
  const actions: GcAction[] = controlled
    .filter((child) => child.deletionTimestamp === undefined)
    .map((child) => ({ type: "mark-deletion" as const, ref: refOf(child) }));
  actions.push(...reapIfReady(owner));
  return actions;
}

/**
 * GC backstop: a child whose controller owner UID no longer resolves.
 * `ownerExists` is true only when the controller owner is present AND its UID
 * still matches (a recreated owner with a new UID counts as gone).
 */
export function planDanglingChild(
  child: GcNode,
  ownerExists: boolean,
): readonly GcAction[] {
  const hasController = child.ownerRefs.some((ref) => ref.controller === true);
  if (!hasController || ownerExists) return [];
  if (child.deletionTimestamp === undefined) {
    return [{ type: "mark-deletion", ref: refOf(child) }];
  }
  return reapIfReady(child);
}
