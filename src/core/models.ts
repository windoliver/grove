/**
 * Core domain models for the Grove contribution graph.
 *
 * All models except Claim are immutable (frozen objects).
 * Claims are the only mutable coordination objects in the protocol.
 *
 * Wire format uses snake_case (JSON Schema). TypeScript uses camelCase.
 * See spec/schemas/contribution.json for the canonical wire format.
 */

import type { Condition } from "./entity.js";
import type { Finalizer, OwnerRef } from "./lifecycle-metadata.js";

/** Contribution kinds — the type of work being contributed. */
export const ContributionKind = {
  Work: "work",
  Review: "review",
  Discussion: "discussion",
  Adoption: "adoption",
  Reproduction: "reproduction",
  Plan: "plan",
  AskUser: "ask_user",
  Response: "response",
} as const;
export type ContributionKind = (typeof ContributionKind)[keyof typeof ContributionKind];

/** Contribution mode — whether this is measured or exploratory. */
export const ContributionMode = {
  Evaluation: "evaluation",
  Exploration: "exploration",
} as const;
export type ContributionMode = (typeof ContributionMode)[keyof typeof ContributionMode];

/** Relation types — typed edges between contributions. */
export const RelationType = {
  DerivesFrom: "derives_from",
  RespondsTo: "responds_to",
  Reviews: "reviews",
  Reproduces: "reproduces",
  Adopts: "adopts",
} as const;
export type RelationType = (typeof RelationType)[keyof typeof RelationType];

/** Claim status — lifecycle of a mutable coordination object. */
export const ClaimStatus = {
  Active: "active",
  Released: "released",
  Expired: "expired",
  Completed: "completed",
} as const;
export type ClaimStatus = (typeof ClaimStatus)[keyof typeof ClaimStatus];

/**
 * A JSON-safe value type. Only types that survive a JSON.stringify
 * round-trip are permitted. This prevents non-JSON values (Map, Set,
 * BigInt, functions, symbols) from entering context and metadata
 * fields, where they would be silently lost or throw during CID hashing.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Score direction — minimize or maximize. */
export const ScoreDirection = {
  Minimize: "minimize",
  Maximize: "maximize",
} as const;
export type ScoreDirection = (typeof ScoreDirection)[keyof typeof ScoreDirection];

/** Identity of the agent that created a contribution or claim. */
export interface AgentIdentity {
  readonly agentId: string;
  readonly agentName?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly platform?: string | undefined;
  readonly version?: string | undefined;
  readonly toolchain?: string | undefined;
  readonly runtime?: string | undefined;
  readonly role?: string | undefined;
}

/** A numeric score with direction and optional unit. */
export interface Score {
  readonly value: number;
  readonly direction: ScoreDirection;
  readonly unit?: string | undefined;
}

/** A typed edge between contributions. */
export interface Relation {
  readonly targetCid: string;
  readonly relationType: RelationType;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
}

/**
 * Content-addressed artifact metadata.
 *
 * This type is used by the CAS layer (ContentStore) to track storage metadata.
 * Contributions reference artifacts only by content hash via the `artifacts`
 * field (Record<name, contentHash>). The artifact name is NOT part of this
 * interface — naming is the contribution's responsibility (via the
 * Contribution.artifacts map key).
 *
 * Mirrors spec/schemas/artifact.json — keep in sync.
 */
export interface Artifact {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mediaType?: string | undefined;
}

/**
 * An artifact paired with its contribution-assigned name.
 *
 * Artifact metadata (contentHash, sizeBytes, mediaType) lives in the CAS.
 * The name lives in the contribution's artifacts map key. This convenience
 * type combines both for use in API responses and UI rendering.
 */
export interface NamedArtifact extends Artifact {
  readonly name: string;
}

/**
 * An immutable unit of published work in the contribution graph.
 *
 * The CID is derived from the BLAKE3 hash of the canonical manifest
 * serialization (RFC 8785, excluding the CID field itself).
 */
export interface Contribution {
  readonly cid: string;
  readonly manifestVersion: number;
  readonly kind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
  /** Git commit SHA when work is submitted as a commit (preferred over CAS artifacts). */
  readonly commitHash?: string | undefined;
  readonly relations: readonly Relation[];
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: AgentIdentity;
  readonly createdAt: string;
}

/**
 * Input for creating a contribution (everything except the CID,
 * which is computed from the canonical serialization).
 */
export type ContributionInput = Omit<Contribution, "cid" | "manifestVersion">;

/**
 * A coordination object for live work.
 *
 * Claims are the ONLY mutable state in the protocol. However, Claim
 * objects returned by the store are readonly snapshots. State transitions
 * (heartbeat, release, complete) return new Claim snapshots rather than
 * mutating existing ones.
 *
 * They prevent duplicate work in agent swarms via lease-based coordination.
 * PROTOCOL INVARIANT: at most one active claim may exist per target_ref
 * at any time. This is enforced by the store layer (not configurable).
 */
export interface Claim {
  readonly claimId: string;
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly status: ClaimStatus;
  readonly intentSummary: string;
  readonly createdAt: string;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly ownerRef?: OwnerRef | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
  /** Number of times this claim has been attempted (for retry/backoff). Defaults to 0. */
  readonly attemptCount?: number | undefined;
  /**
   * Optimistic concurrency revision number.
   *
   * Incremented by the store on every state transition (heartbeat, release,
   * complete). Used by network-backed stores (e.g., Nexus) for compare-and-swap
   * operations. Local stores may track it but are not required to.
   */
  readonly revision?: number | undefined;
}

/** User-owned desired state for a claim. */
export interface ClaimSpecRecord {
  readonly id: string;
  readonly roleName?: string | undefined;
  readonly platform?: string | undefined;
  readonly blueprint?: string | undefined;
  readonly assignee?: AgentIdentity | undefined;
  readonly leaseDeadlineSec?: number | undefined;
  readonly priority?: number | undefined;
  readonly maxIterations?: number | undefined;
  readonly generation: number;
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly ownerRef?: OwnerRef | undefined;
  readonly finalizers?: readonly Finalizer[] | undefined;
  readonly deletionTimestamp?: string | undefined;
  readonly createdAt: string;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case the entity projection falls back to `generation`.
   */
  readonly resourceVersion?: number | undefined;
}

/** Controller-owned observed state for a claim. */
export interface ClaimStatusRecord {
  readonly id: string;
  readonly phase: ClaimStatus;
  readonly observedGeneration: number;
  readonly agentSessionId?: string | undefined;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly currentContributionCid?: string | undefined;
  readonly conditions: readonly Condition[];
  readonly lastTransitionAt: string;
  readonly attemptCount: number;
  readonly revision: number;
  /**
   * Optimistic-concurrency resource version persisted by the store (C6, #304).
   * Optional: legacy stores that have not yet been migrated emit `undefined`,
   * in which case the entity projection falls back to `revision`.
   */
  readonly resourceVersion?: number | undefined;
}

/** Merged split claim view. */
export interface ClaimView {
  readonly spec: ClaimSpecRecord;
  readonly status: ClaimStatusRecord;
}

export function claimToSpecRecord(claim: Claim): ClaimSpecRecord {
  const createdAtMs = Date.parse(claim.createdAt);
  const leaseExpiresAtMs = Date.parse(claim.leaseExpiresAt);
  const leaseDeadlineSec =
    Number.isFinite(createdAtMs) &&
    Number.isFinite(leaseExpiresAtMs) &&
    leaseExpiresAtMs > createdAtMs
      ? Math.floor((leaseExpiresAtMs - createdAtMs) / 1000)
      : undefined;

  return {
    id: claim.claimId,
    roleName: claim.agent.role,
    platform: claim.agent.platform,
    assignee: claim.agent,
    leaseDeadlineSec,
    generation: claim.revision ?? 1,
    targetRef: claim.targetRef,
    agent: claim.agent,
    intentSummary: claim.intentSummary,
    context: claim.context,
    ...(claim.ownerRef === undefined ? {} : { ownerRef: claim.ownerRef }),
    ...(claim.finalizers === undefined ? {} : { finalizers: claim.finalizers }),
    ...(claim.deletionTimestamp === undefined
      ? {}
      : { deletionTimestamp: claim.deletionTimestamp }),
    createdAt: claim.createdAt,
  };
}

export function claimToStatusRecord(
  claim: Claim,
  conditions: readonly Condition[] = [],
): ClaimStatusRecord {
  return {
    id: claim.claimId,
    phase: claim.status,
    observedGeneration: claim.revision ?? 1,
    lastHeartbeatAt: claim.heartbeatAt,
    leaseExpiresAt: claim.leaseExpiresAt,
    conditions,
    lastTransitionAt: claim.heartbeatAt,
    attemptCount: claim.attemptCount ?? 0,
    revision: claim.revision ?? 1,
  };
}

export function claimViewToClaim(view: ClaimView): Claim {
  return {
    claimId: view.spec.id,
    targetRef: view.spec.targetRef,
    agent: view.spec.agent,
    status: view.status.phase,
    intentSummary: view.spec.intentSummary,
    createdAt: view.spec.createdAt,
    heartbeatAt: view.status.lastHeartbeatAt,
    leaseExpiresAt: view.status.leaseExpiresAt,
    revision: view.status.revision,
    ...(view.spec.context === undefined ? {} : { context: view.spec.context }),
    ...(view.spec.ownerRef === undefined ? {} : { ownerRef: view.spec.ownerRef }),
    ...(view.spec.finalizers === undefined ? {} : { finalizers: view.spec.finalizers }),
    ...(view.spec.deletionTimestamp === undefined
      ? {}
      : { deletionTimestamp: view.spec.deletionTimestamp }),
    ...(view.status.attemptCount > 0 ? { attemptCount: view.status.attemptCount } : {}),
  };
}
