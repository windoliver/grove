/**
 * Contribution operations.
 *
 * contributeOperation — Create and store a contribution (general)
 * reviewOperation     — Sugar: kind=review with reviews relation
 * reproduceOperation  — Sugar: kind=reproduction with reproduces relation
 * discussOperation    — Sugar: kind=discussion with responds_to relation
 */

import { createContribution } from "../manifest.js";
import type {
  ContributionInput,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "../models.js";
import { ContributionKind as CK, ContributionMode as CM, RelationType } from "../models.js";
import type { ContributionStore } from "../store.js";
import { toUtcIso } from "../time.js";
import type { AgentOverrides } from "./agent.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { fromGroveError, notFound, ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a contribute operation. */
export interface ContributeResult {
  readonly cid: string;
  readonly kind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly artifactCount: number;
  readonly relationCount: number;
  readonly createdAt: string;
}

/** Result of a review operation. */
export interface ReviewResult {
  readonly cid: string;
  readonly kind: "review";
  readonly targetCid: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** Result of a reproduce operation. */
export interface ReproduceResult {
  readonly cid: string;
  readonly kind: "reproduction";
  readonly targetCid: string;
  readonly result: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** Result of a discuss operation. */
export interface DiscussResult {
  readonly cid: string;
  readonly kind: "discussion";
  readonly targetCid?: string | undefined;
  readonly summary: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for the general contribute operation. */
export interface ContributeInput {
  readonly kind: ContributionKind;
  readonly mode?: ContributionMode | undefined;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts?: Readonly<Record<string, string>> | undefined;
  readonly relations?: readonly Relation[] | undefined;
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
  /** Optional timestamp for replay/import. Defaults to current time if omitted. */
  readonly createdAt?: string | undefined;
}

/** Input for the review operation. */
export interface ReviewInput {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Input for the reproduce operation. */
export interface ReproduceInput {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly result?: "confirmed" | "challenged" | "partial" | undefined;
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly artifacts?: Readonly<Record<string, string>> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
}

/** Input for the discuss operation. */
export interface DiscussInput {
  readonly targetCid?: string | undefined;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/**
 * Validate that all relation targets exist in the store (batch).
 * Returns a validation error if any target is missing, or undefined if all valid.
 */
async function validateRelations(
  store: ContributionStore,
  relations: readonly Relation[],
): Promise<OperationResult<void> | undefined> {
  for (const rel of relations) {
    const target = await store.get(rel.targetCid);
    if (target === undefined) {
      return notFound("Contribution", rel.targetCid);
    }
  }
  return undefined;
}

/**
 * Validate that all artifact hashes exist in CAS (batch).
 * Returns a validation error if any hash is missing, or undefined if all valid.
 */
async function validateArtifacts(
  deps: OperationDeps,
  artifacts: Readonly<Record<string, string>>,
): Promise<OperationResult<void> | undefined> {
  if (deps.cas === undefined) {
    return validationErr("Artifact validation not available (missing cas)");
  }
  for (const [name, hash] of Object.entries(artifacts)) {
    const exists = await deps.cas.exists(hash);
    if (!exists) {
      return validationErr(`Artifact '${name}' references non-existent hash: ${hash}`);
    }
  }
  return undefined;
}

/**
 * Resolve the contribution mode.
 * If a contract is present and specifies a mode, use it (unless explicitly overridden).
 */
function resolveMode(
  explicitMode: ContributionMode | undefined,
  deps: OperationDeps,
): ContributionMode {
  if (explicitMode !== undefined) return explicitMode;
  if (deps.contract?.mode !== undefined) return deps.contract.mode;
  return CM.Evaluation;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Create and store a contribution. */
export async function contributeOperation(
  input: ContributeInput,
  deps: OperationDeps,
): Promise<OperationResult<ContributeResult>> {
  try {
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const artifacts = input.artifacts ?? {};
    const relations = input.relations ?? [];
    const tags = input.tags ?? [];

    // Validate relations
    if (relations.length > 0) {
      const relErr = await validateRelations(deps.contributionStore, relations);
      if (relErr !== undefined) return relErr as OperationResult<ContributeResult>;
    }

    // Validate artifacts
    if (Object.keys(artifacts).length > 0) {
      const artErr = await validateArtifacts(deps, artifacts);
      if (artErr !== undefined) return artErr as OperationResult<ContributeResult>;
    }

    const agent = resolveAgent(input.agent);
    const mode = resolveMode(input.mode, deps);
    // Normalize to UTC Z-format so lexicographic ORDER BY works without datetime().
    const createdAt = toUtcIso(input.createdAt ?? new Date().toISOString());

    const contributionInput: ContributionInput = {
      kind: input.kind,
      mode,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      artifacts,
      relations,
      ...(input.scores !== undefined ? { scores: input.scores } : {}),
      tags: [...tags],
      ...(input.context !== undefined ? { context: input.context } : {}),
      agent,
      createdAt,
    };

    const contribution = createContribution(contributionInput);
    await deps.contributionStore.put(contribution);
    deps.onContributionWrite?.();

    return ok({
      cid: contribution.cid,
      kind: contribution.kind,
      mode: contribution.mode,
      summary: contribution.summary,
      artifactCount: Object.keys(contribution.artifacts).length,
      relationCount: contribution.relations.length,
      createdAt: contribution.createdAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Submit a review of an existing contribution. */
export async function reviewOperation(
  input: ReviewInput,
  deps: OperationDeps,
): Promise<OperationResult<ReviewResult>> {
  try {
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const relations: Relation[] = [
      {
        targetCid: input.targetCid,
        relationType: RelationType.Reviews,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    ];

    // Validate target exists
    const relErr = await validateRelations(deps.contributionStore, relations);
    if (relErr !== undefined) return relErr as OperationResult<ReviewResult>;

    const agent = resolveAgent(input.agent);
    const now = new Date().toISOString();

    const contributionInput: ContributionInput = {
      kind: CK.Review,
      mode: CM.Evaluation,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      artifacts: {},
      relations,
      ...(input.scores !== undefined ? { scores: input.scores } : {}),
      tags: [...(input.tags ?? [])],
      ...(input.context !== undefined ? { context: input.context } : {}),
      agent,
      createdAt: now,
    };

    const contribution = createContribution(contributionInput);
    await deps.contributionStore.put(contribution);
    deps.onContributionWrite?.();

    return ok({
      cid: contribution.cid,
      kind: "review" as const,
      targetCid: input.targetCid,
      summary: contribution.summary,
      createdAt: contribution.createdAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Submit a reproduction attempt of an existing contribution. */
export async function reproduceOperation(
  input: ReproduceInput,
  deps: OperationDeps,
): Promise<OperationResult<ReproduceResult>> {
  try {
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const result = input.result ?? "confirmed";
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const artifacts = input.artifacts ?? {};

    const relations: Relation[] = [
      {
        targetCid: input.targetCid,
        relationType: RelationType.Reproduces,
        metadata: { result } as Readonly<Record<string, JsonValue>>,
      },
    ];

    // Validate target exists
    const relErr = await validateRelations(deps.contributionStore, relations);
    if (relErr !== undefined) return relErr as OperationResult<ReproduceResult>;

    // Validate artifacts
    if (Object.keys(artifacts).length > 0) {
      const artErr = await validateArtifacts(deps, artifacts);
      if (artErr !== undefined) return artErr as OperationResult<ReproduceResult>;
    }

    const agent = resolveAgent(input.agent);
    const now = new Date().toISOString();

    const contributionInput: ContributionInput = {
      kind: CK.Reproduction,
      mode: CM.Evaluation,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      artifacts,
      relations,
      ...(input.scores !== undefined ? { scores: input.scores } : {}),
      tags: [...(input.tags ?? [])],
      ...(input.context !== undefined ? { context: input.context } : {}),
      agent,
      createdAt: now,
    };

    const contribution = createContribution(contributionInput);
    await deps.contributionStore.put(contribution);
    deps.onContributionWrite?.();

    return ok({
      cid: contribution.cid,
      kind: "reproduction" as const,
      targetCid: input.targetCid,
      result,
      summary: contribution.summary,
      createdAt: contribution.createdAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/** Post a discussion or reply. */
export async function discussOperation(
  input: DiscussInput,
  deps: OperationDeps,
): Promise<OperationResult<DiscussResult>> {
  try {
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const relations: Relation[] = [];
    if (input.targetCid !== undefined) {
      relations.push({
        targetCid: input.targetCid,
        relationType: RelationType.RespondsTo,
      });
    }

    // Validate target exists (if replying)
    if (relations.length > 0) {
      const relErr = await validateRelations(deps.contributionStore, relations);
      if (relErr !== undefined) return relErr as OperationResult<DiscussResult>;
    }

    const agent = resolveAgent(input.agent);
    const now = new Date().toISOString();

    const contributionInput: ContributionInput = {
      kind: CK.Discussion,
      mode: CM.Exploration,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      artifacts: {},
      relations,
      tags: [...(input.tags ?? [])],
      ...(input.context !== undefined ? { context: input.context } : {}),
      agent,
      createdAt: now,
    };

    const contribution = createContribution(contributionInput);
    await deps.contributionStore.put(contribution);
    deps.onContributionWrite?.();

    return ok({
      cid: contribution.cid,
      kind: "discussion" as const,
      ...(input.targetCid !== undefined ? { targetCid: input.targetCid } : {}),
      summary: contribution.summary,
      createdAt: contribution.createdAt,
    });
  } catch (error) {
    return fromGroveError(error);
  }
}
