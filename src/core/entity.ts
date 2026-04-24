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

import type {
  AgentIdentity,
  Contribution,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "./models.js";

export interface ContributionSpec {
  readonly contributionKind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly commitHash?: string | undefined;
  readonly relations: readonly Relation[];
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: AgentIdentity;
}

export type ContributionStatus = Record<string, never>;

export type ContributionEntity = Entity<
  "Contribution",
  ContributionSpec,
  ContributionStatus
>;

export function contributionToEntity(c: Contribution): ContributionEntity {
  const published: Condition = {
    type: "Published",
    status: "True",
    observedGeneration: 0,
    lastTransitionTime: c.createdAt,
    reason: "Created",
    message: "",
  };
  return {
    kind: "Contribution",
    namespace: "default",
    id: c.cid,
    spec: {
      contributionKind: c.kind,
      mode: c.mode,
      summary: c.summary,
      description: c.description,
      artifacts: c.artifacts,
      commitHash: c.commitHash,
      relations: c.relations,
      scores: c.scores,
      tags: c.tags,
      context: c.context,
      agent: c.agent,
    },
    status: {},
    conditions: [published],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: {
      generation: 1,
      creationTimestamp: c.createdAt,
    },
  };
}
