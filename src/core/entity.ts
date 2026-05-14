/**
 * Entity<Kind, Spec, Status> — Kubernetes-style envelope for domain objects.
 *
 * This file only defines the envelope shape and per-kind projections for
 * Contribution, Claim, AgentSession. Stores still return the flat types;
 * callers project to Entity via the adapters in this module.
 */

import type { AgentSession } from "./agent-runtime.js";
import type { Finalizer, OwnerRef } from "./lifecycle-metadata.js";
import type {
  AgentIdentity,
  Claim,
  ClaimStatus as ClaimPhase,
  ClaimSpecRecord,
  ClaimStatusRecord,
  ClaimView,
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

export interface EntityMetadata {
  readonly generation: number;
  readonly creationTimestamp?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly ownerRefs?: readonly OwnerRef[] | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
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

/**
 * Project a Contribution into the Entity envelope.
 *
 * Contributions are immutable, so the resourceVersion ordinarily stays at
 * its initial value. C6 (#304) introduced an optional, store-provided
 * `resourceVersion` so the Entity reflects the real persisted column rather
 * than the legacy hardcoded `"0"`. Callers that do not have a stored value
 * (in-memory stores, fixture builders, projection-only tests) may omit it;
 * the projection then falls back to `"0"` for backward compatibility.
 */
export function contributionToEntity(
  c: Contribution,
  namespace: string,
  resourceVersion?: number,
): ContributionEntity {
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
    namespace,
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
    resourceVersion: String(resourceVersion ?? 0),
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
  readonly roleName?: string | undefined;
  readonly platform?: string | undefined;
  readonly blueprint?: string | undefined;
  readonly assignee?: AgentIdentity | undefined;
  readonly leaseDeadlineSec?: number | undefined;
  readonly priority?: number | undefined;
  readonly maxIterations?: number | undefined;
}

export interface ClaimStatusBody {
  /**
   * Effective phase as seen by Entity consumers. For an active row
   * whose lease has passed, this collapses to `"expired"` — keeping
   * `status.phase` consistent with the lease-aware condition view
   * (Active=False, Expired=True). Consumers that filter "active"
   * claims by phase will correctly skip stale leases.
   */
  readonly phase: ClaimPhase;
  /**
   * The raw phase from the persisted row. Equal to `phase` except at
   * the lease-expired-but-not-yet-persisted boundary, where
   * `persistedPhase === "active"` and `phase === "expired"`. Use this
   * when you specifically need to know what the store last wrote, e.g.
   * to decide whether `expireStale` needs to run.
   */
  readonly persistedPhase: ClaimPhase;
  readonly heartbeatAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly observedGeneration: number;
  readonly currentContributionCid?: string | undefined;
  readonly agentSessionId?: string | undefined;
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
export function claimToEntity(
  c: Claim,
  now: () => number = () => Date.now(),
  namespace = "default",
): ClaimEntity {
  const leaseDeadlineSec = computeLeaseDeadlineSec(c.createdAt, c.leaseExpiresAt);
  const spec: ClaimSpecRecord = {
    id: c.claimId,
    roleName: c.agent.role,
    platform: c.agent.platform,
    assignee: c.agent,
    ...(leaseDeadlineSec === undefined ? {} : { leaseDeadlineSec }),
    generation: c.revision ?? 1,
    targetRef: c.targetRef,
    agent: c.agent,
    intentSummary: c.intentSummary,
    context: c.context,
    ...(c.ownerRef === undefined ? {} : { ownerRef: c.ownerRef }),
    ...(c.finalizers === undefined ? {} : { finalizers: c.finalizers }),
    ...(c.deletionTimestamp === undefined ? {} : { deletionTimestamp: c.deletionTimestamp }),
    createdAt: c.createdAt,
  };
  const status: ClaimStatusRecord = {
    id: c.claimId,
    phase: c.status,
    observedGeneration: c.revision ?? 0,
    lastHeartbeatAt: c.heartbeatAt,
    leaseExpiresAt: c.leaseExpiresAt,
    conditions: [],
    lastTransitionAt: c.heartbeatAt,
    attemptCount: c.attemptCount ?? 0,
    revision: c.revision ?? 0,
  };
  return claimViewToEntity({ spec, status }, now, namespace);
}

export function claimViewToEntity(
  view: ClaimView,
  now: () => number = () => Date.now(),
  namespace = "default",
): ClaimEntity {
  const persistedPhase = view.status.phase;
  const leaseExpiresAtMs = Date.parse(view.status.leaseExpiresAt);

  const leaseIsExpired =
    Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= now() && persistedPhase === "active";

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
    observedGeneration: view.status.observedGeneration,
    lastTransitionTime,
    reason,
    message: "",
  });

  const activeCondition: Condition = mkCond(
    "Active",
    effectivePhase === "active",
    view.status.lastHeartbeatAt,
    leaseIsExpired ? "lease-expired" : effectivePhase,
  );
  const expiredCondition: Condition = mkCond(
    "Expired",
    effectivePhase === "expired",
    view.status.leaseExpiresAt,
    leaseIsExpired ? "lease-expired" : effectivePhase,
  );
  const completedCondition: Condition = mkCond(
    "Completed",
    effectivePhase === "completed",
    view.status.lastTransitionAt,
  );
  const terminatingCondition: Condition = mkCond(
    "Terminating",
    view.spec.deletionTimestamp !== undefined,
    view.spec.deletionTimestamp ?? view.status.lastTransitionAt,
    view.spec.deletionTimestamp !== undefined ? "deletion-requested" : effectivePhase,
  );

  const conditions: readonly Condition[] =
    view.status.conditions.length > 0
      ? view.status.conditions
      : [activeCondition, expiredCondition, completedCondition, terminatingCondition];

  return {
    kind: "Claim",
    namespace,
    id: view.spec.id,
    spec: {
      targetRef: view.spec.targetRef,
      agent: view.spec.agent,
      intentSummary: view.spec.intentSummary,
      context: view.spec.context,
      roleName: view.spec.roleName,
      platform: view.spec.platform,
      blueprint: view.spec.blueprint,
      assignee: view.spec.assignee,
      leaseDeadlineSec: view.spec.leaseDeadlineSec,
      priority: view.spec.priority,
      maxIterations: view.spec.maxIterations,
    },
    status: {
      // phase = effective, lease-aware view so consumers that filter
      // "active" via phase do not see stale leases.
      // persistedPhase = raw store state, exposed separately for
      // callers that need to decide whether expireStale should run.
      phase: effectivePhase,
      persistedPhase,
      heartbeatAt: view.status.lastHeartbeatAt,
      lastHeartbeatAt: view.status.lastHeartbeatAt,
      leaseExpiresAt: view.status.leaseExpiresAt,
      observedGeneration: view.status.observedGeneration,
      agentSessionId: view.status.agentSessionId,
      currentContributionCid: view.status.currentContributionCid,
      attemptCount: view.status.attemptCount,
    },
    conditions,
    observedGeneration: view.status.observedGeneration,
    // When lease expiry is derived from wall-clock (not yet persisted by
    // expireStale), the logical Entity state has changed even though
    // `revision` has not. Encode the lease-crossed boundary in the
    // resourceVersion so caches/informers see a version change at the
    // boundary and do not conflate the two snapshots.
    //
    // C6 (#304) NOTE: `view.status.resourceVersion` is the persisted
    // `resource_version` column. Until subsequent C6 tasks land the
    // per-mutation bump, `revision` remains the authoritative monotonic
    // signal so heartbeat/release/complete continue to advance the Entity
    // RV. Tasks 2-3 will switch the source-of-truth here once they own
    // bumping the new column inside each mutation.
    resourceVersion: leaseIsExpired
      ? `${view.status.revision}-lease-expired`
      : String(view.status.revision),
    metadata: {
      generation: view.spec.generation,
      creationTimestamp: view.spec.createdAt,
      ownerRefs: view.spec.ownerRef !== undefined ? [view.spec.ownerRef] : undefined,
      finalizers: view.spec.finalizers,
      deletionTimestamp: view.spec.deletionTimestamp,
    },
  };
}

function computeLeaseDeadlineSec(createdAt: string, leaseExpiresAt: string): number | undefined {
  const createdAtMs = Date.parse(createdAt);
  const leaseExpiresAtMs = Date.parse(leaseExpiresAt);
  return Number.isFinite(createdAtMs) &&
    Number.isFinite(leaseExpiresAtMs) &&
    leaseExpiresAtMs > createdAtMs
    ? Math.floor((leaseExpiresAtMs - createdAtMs) / 1000)
    : undefined;
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
  namespace = "default",
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
    namespace,
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
