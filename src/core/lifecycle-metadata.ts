export type OwnerKind = "session" | "claim";

export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
}

export const Finalizer = {
  ReleaseSlots: "grove.io/release-slots",
  DrainContribs: "grove.io/drain-contribs",
  CloseRuntime: "grove.io/close-runtime",
} as const;
export type Finalizer = (typeof Finalizer)[keyof typeof Finalizer];

export const DEFAULT_SESSION_FINALIZERS: readonly Finalizer[] = [
  Finalizer.ReleaseSlots,
  Finalizer.DrainContribs,
  Finalizer.CloseRuntime,
];

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
