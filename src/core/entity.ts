/**
 * Entity<Kind, Spec, Status> — Kubernetes-style envelope for domain objects.
 *
 * This file only defines the envelope shape and per-kind projections for
 * Contribution, Claim, AgentSession. Stores still return the flat types;
 * callers project to Entity via the adapters in this module.
 *
 * Namespace is hardcoded to "default" until #290 lands server-enforced
 * isolation. That is the only call-site that needs to change.
 */

export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  readonly type: string;
  readonly status: ConditionStatus;
  readonly observedGeneration: number;
  readonly lastTransitionTime: string;
  readonly reason: string;
  readonly message: string;
}

export interface OwnerRef {
  readonly kind: string;
  readonly id: string;
}

export interface EntityMetadata {
  readonly generation: number;
  readonly creationTimestamp?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly ownerRefs?: readonly OwnerRef[] | undefined;
}

export interface Entity<K extends string, Spec, Status> {
  readonly kind: K;
  readonly namespace: string;
  readonly id: string;
  readonly spec: Spec;
  readonly status: Status;
  readonly conditions: readonly Condition[];
  readonly observedGeneration: number;
  readonly resourceVersion: string;
  readonly metadata: EntityMetadata;
}
