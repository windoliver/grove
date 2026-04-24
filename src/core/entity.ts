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

import type { AgentSession } from "./agent-runtime.js";
import type {
  AgentIdentity,
  Claim,
  ClaimStatus as ClaimPhase,
  Contribution,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "./models.js";
import type { AgentPlatformType } from "./topology.js";

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

export type ContributionEntity = Entity<"Contribution", ContributionSpec, ContributionStatus>;

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

export interface ClaimSpec {
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface ClaimStatusBody {
  readonly phase: ClaimPhase;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export type ClaimEntity = Entity<"Claim", ClaimSpec, ClaimStatusBody>;

/**
 * Project a Claim into the Entity envelope.
 *
 * Conditions are lease-aware: when the persisted `status` is still
 * `active` but `leaseExpiresAt` is in the past, `Active` collapses to
 * False with reason `"lease-expired"` and `Expired` raises to True.
 * This prevents consumers (UI, controllers) from treating a stale row
 * as a live claim during the window before expireStale() rewrites it.
 *
 * The `now` clock is injectable for test determinism. Default is
 * wall-clock `Date.now()`, which is safe for read-only projection.
 */
export function claimToEntity(c: Claim, now: () => number = () => Date.now()): ClaimEntity {
  const rev = c.revision ?? 0;
  const metaGen = c.revision ?? 1;
  const persistedPhase = c.status;

  const leaseExpiredAt = Date.parse(c.leaseExpiresAt);
  const leaseIsExpired =
    Number.isFinite(leaseExpiredAt) && leaseExpiredAt <= now() && persistedPhase === "active";

  // Effective view: if persisted phase is `active` but lease is past,
  // act as if phase transitioned to `expired` for Entity consumers.
  const effectivePhase: ClaimPhase = leaseIsExpired ? ("expired" as ClaimPhase) : persistedPhase;

  const mkCond = (
    type: string,
    active: boolean,
    lastTransitionTime: string,
    reason: string = effectivePhase,
  ): Condition => ({
    type,
    status: active ? "True" : "False",
    observedGeneration: rev,
    lastTransitionTime,
    reason,
    message: "",
  });

  const activeCondition: Condition = mkCond(
    "Active",
    effectivePhase === "active",
    c.heartbeatAt,
    leaseIsExpired ? "lease-expired" : effectivePhase,
  );
  const expiredCondition: Condition = mkCond(
    "Expired",
    effectivePhase === "expired",
    c.leaseExpiresAt,
    leaseIsExpired ? "lease-expired" : effectivePhase,
  );
  const completedCondition: Condition = mkCond(
    "Completed",
    effectivePhase === "completed",
    c.heartbeatAt,
  );

  const conditions: readonly Condition[] = [activeCondition, expiredCondition, completedCondition];

  return {
    kind: "Claim",
    namespace: "default",
    id: c.claimId,
    spec: {
      targetRef: c.targetRef,
      agent: c.agent,
      intentSummary: c.intentSummary,
      context: c.context,
    },
    status: {
      // status.phase reflects the persisted row (what a controller last
      // wrote); conditions express the lease-aware derived view.
      phase: persistedPhase,
      heartbeatAt: c.heartbeatAt,
      leaseExpiresAt: c.leaseExpiresAt,
      attemptCount: c.attemptCount ?? 0,
    },
    conditions,
    observedGeneration: rev,
    resourceVersion: String(rev),
    metadata: {
      generation: metaGen,
      creationTimestamp: c.createdAt,
    },
  };
}

export interface AgentSessionSpec {
  readonly role: string;
  readonly platform?: AgentPlatformType | undefined;
  readonly model?: string | undefined;
  /** Agent backend name (e.g. "claude", "codex", "gemini"); not an AgentIdentity record. */
  readonly agent?: string | undefined;
}

export interface AgentSessionStatusBody {
  readonly phase: "running" | "idle" | "stopped" | "crashed";
  readonly pid?: number | undefined;
}

export type AgentSessionEntity = Entity<"AgentSession", AgentSessionSpec, AgentSessionStatusBody>;

/**
 * Sentinel used when no real transition timestamp is available.
 *
 * AgentSession (pre-Epic D #285) does not record per-phase transition
 * times. Rather than fabricating `new Date()` on every projection — which
 * produces phantom changes across `listSessionEntities()` polls while
 * `resourceVersion` stays at `"0"` — we return an empty string. Callers
 * that can supply a real timestamp (e.g. a controller that tracks
 * phase-change events) should pass one via the `now` argument.
 */
export const UNKNOWN_TRANSITION_TIME = "";

export function agentSessionToEntity(
  s: AgentSession,
  now: () => string = () => UNKNOWN_TRANSITION_TIME,
): AgentSessionEntity {
  const t = now();
  const phase = s.status;
  // Both conditions share the same observed-at instant; per-condition
  // timestamps will be recorded by the controller in Epic D (#285).
  const mkCond = (type: string, active: boolean): Condition => ({
    type,
    status: active ? "True" : "False",
    observedGeneration: 0,
    lastTransitionTime: t,
    reason: phase,
    message: "",
  });

  return {
    kind: "AgentSession",
    namespace: "default",
    id: s.id,
    spec: {
      role: s.role,
      platform: s.platform,
      model: s.model,
      agent: s.agent,
    },
    status: {
      phase,
      pid: s.pid,
    },
    conditions: [
      mkCond("Ready", phase === "running" || phase === "idle"),
      mkCond("Crashed", phase === "crashed"),
    ],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: {
      generation: 1,
    },
  };
}
