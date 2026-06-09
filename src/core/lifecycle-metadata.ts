export type OwnerKind = "session" | "claim" | "taskGroup" | "agentTask";

export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  /** k8s `controller: true` — the single managing owner. Metadata, not identity. */
  readonly controller?: boolean | undefined;
}

export const Finalizer = {
  ReleaseSlots: "grove.io/release-slots",
  DrainContribs: "grove.io/drain-contribs",
  CloseRuntime: "grove.io/close-runtime",
} as const;
export type Finalizer = (typeof Finalizer)[keyof typeof Finalizer];
export type SessionFinalizer = Finalizer | (string & {});

export const DEFAULT_SESSION_FINALIZERS: readonly Finalizer[] = [
  Finalizer.ReleaseSlots,
  Finalizer.DrainContribs,
  Finalizer.CloseRuntime,
];

/**
 * Per-kind finalizers (Epic D #306). Use the `grove.dev/` namespace, distinct
 * from the legacy `grove.io/*` session finalizers above (not unified here).
 */
export const KindFinalizer = {
  /** On AgentTask — blocks reap until review completes. */
  PendingReview: "grove.dev/pending-review",
  /** On MergeTask — blocks reap until the merge lands (defined now, applied in a follow-up). */
  PendingMerge: "grove.dev/pending-merge",
} as const;
export type KindFinalizer = (typeof KindFinalizer)[keyof typeof KindFinalizer];

/**
 * Propagation finalizers placed on the OWNER at delete time to encode the
 * cascade policy (mirrors k8s `foregroundDeletion`/`orphan`). Background uses
 * no propagation finalizer. Reconstructable from store state after a restart.
 */
export const PropagationFinalizer = {
  Foreground: "grove.dev/foreground-deletion",
  Orphan: "grove.dev/orphan",
} as const;
export type PropagationFinalizer = (typeof PropagationFinalizer)[keyof typeof PropagationFinalizer];

export type CascadePolicy = "Foreground" | "Background" | "Orphan";

export interface DeletionAuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly force: boolean;
  readonly warning: string;
}

export function ownerRefsEqual(a: OwnerRef | undefined, b: OwnerRef | undefined): boolean {
  return (
    a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id && a.uid === b.uid
  );
}

export function appendDeletionAudit(
  existing: readonly DeletionAuditEvent[] | undefined,
  input: Pick<DeletionAuditEvent, "at" | "actor" | "warning">,
): readonly DeletionAuditEvent[] {
  return [...(existing ?? []), { ...input, force: true }];
}
