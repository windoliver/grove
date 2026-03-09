/**
 * Core domain models for the Grove contribution graph.
 *
 * All models except Claim are immutable (frozen objects).
 * Claims are the only mutable coordination objects in the protocol.
 *
 * Wire format uses snake_case (JSON Schema). TypeScript uses camelCase.
 * See spec/schemas/contribution.json for the canonical wire format.
 */

/** Contribution kinds — the type of work being contributed. */
export const ContributionKind = {
  Work: "work",
  Review: "review",
  Discussion: "discussion",
  Adoption: "adoption",
  Reproduction: "reproduction",
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
  readonly agentName: string;
  readonly agentId?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly version?: string | undefined;
  readonly toolchain?: string | undefined;
  readonly runtime?: string | undefined;
  readonly platform?: string | undefined;
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

/** Content-addressed artifact metadata. */
export interface Artifact {
  readonly contentHash: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly mediaType?: string | undefined;
}

/**
 * An immutable unit of published work in the contribution graph.
 *
 * The CID is derived from the BLAKE3 hash of the canonical manifest
 * serialization (RFC 8785, excluding the CID field itself).
 */
export interface Contribution {
  readonly cid: string;
  readonly kind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
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
export type ContributionInput = Omit<Contribution, "cid">;

/**
 * A mutable coordination object for live work.
 *
 * Claims are the ONLY mutable objects in the protocol.
 * They prevent duplicate work in agent swarms via lease-based coordination.
 */
export interface Claim {
  readonly claimId: string;
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  status: ClaimStatus;
  heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly intentSummary: string;
}
