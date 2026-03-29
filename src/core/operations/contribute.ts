/**
 * Contribution operations.
 *
 * contributeOperation — Create and store a contribution (general)
 * reviewOperation     — Sugar: kind=review with reviews relation
 * reproduceOperation  — Sugar: kind=reproduction with reproduces relation
 * discussOperation    — Sugar: kind=discussion with responds_to relation
 */

import { fireAndForget } from "../../shared/fire-and-forget.js";
import { pickDefined } from "../../shared/pick-defined.js";
import { createContribution } from "../manifest.js";
import {
  ContributionKind as CK,
  ContributionMode as CM,
  type Contribution,
  type ContributionInput,
  type ContributionKind,
  type ContributionMode,
  type JsonValue,
  type Relation,
  RelationType,
  type Score,
} from "../models.js";
import type { PolicyEnforcementResult } from "../policy-enforcer.js";
import { PolicyEnforcer } from "../policy-enforcer.js";
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
  /** Policy enforcement result (present when a contract is loaded). */
  readonly policy?: PolicyEnforcementResult | undefined;
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

/** Input for the adopt operation. */
export interface AdoptInput {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
}

/** Result of an adopt operation. */
export interface AdoptResult {
  readonly cid: string;
  readonly kind: "adoption";
  readonly targetCid: string;
  readonly summary: string;
  readonly createdAt: string;
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

    // Idempotency check: skip if same summary + agent role exists within last 60s.
    // Prevents duplicate contributions from MCP tool retries or agent calling the tool multiple times.
    {
      const recentWindow = new Date(Date.now() - 60_000).toISOString();
      try {
        const recent = await deps.contributionStore.list({ limit: 20 });
        const agentMatch = (c: Contribution) =>
          agent.role ? c.agent.role === agent.role : c.agent.agentId === agent.agentId;
        const isDuplicate = recent.some(
          (c) =>
            c.summary === input.summary &&
            agentMatch(c) &&
            c.kind === input.kind &&
            c.createdAt >= recentWindow,
        );
        if (isDuplicate) {
          // Return the existing contribution's info instead of creating a duplicate
          const existing = recent.find(
            (c) => c.summary === input.summary && agentMatch(c) && c.kind === input.kind,
          );
          if (existing) {
            return ok({
              cid: existing.cid,
              kind: existing.kind,
              mode: existing.mode,
              summary: existing.summary,
              artifactCount: Object.keys(existing.artifacts).length,
              relationCount: existing.relations.length,
              createdAt: existing.createdAt,
            });
          }
        }
      } catch {
        // Best-effort — continue with normal contribution if check fails
      }
    }

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

    // --- Policy enforcement (TOCTOU-safe: runs inside store mutex) ---
    let policyResult: PolicyEnforcementResult | undefined;
    if (deps.contract !== undefined && deps.contributionStore !== undefined) {
      const enforcer = new PolicyEnforcer(deps.contract, deps.contributionStore, deps.outcomeStore);

      // Register per-CID preWriteHook for atomic enforce+put (TOCTOU-safe).
      // Keyed by CID so concurrent contributes don't overwrite each other's hooks.
      const store = deps.contributionStore as {
        setPreWriteHook?: (cid: string, hook: (c: Contribution) => Promise<void>) => void;
      };
      if (store.setPreWriteHook) {
        store.setPreWriteHook(contribution.cid, async (c: Contribution) => {
          policyResult = await enforcer.enforce(c, true);
        });
      } else {
        // Fallback: enforce outside mutex (non-EnforcingContributionStore)
        policyResult = await enforcer.enforce(contribution, true);
      }
    }

    await deps.contributionStore.put(contribution);
    deps.onContributionWrite?.();

    // --- Post-write: persist derived outcome (outside mutex scope) ---
    if (policyResult?.derivedOutcome !== undefined && deps.contract !== undefined) {
      const enforcer = new PolicyEnforcer(deps.contract, deps.contributionStore, deps.outcomeStore);
      await enforcer.persistOutcome(contribution.cid, policyResult.derivedOutcome);
    }

    // --- Post-write: route events via topology (outside mutex scope) ---
    if (deps.topologyRouter !== undefined && contribution.agent.role !== undefined) {
      fireAndForget("topology routing", () =>
        deps.topologyRouter?.route(contribution.agent.role!, {
          cid: contribution.cid,
          kind: contribution.kind,
          summary: contribution.summary,
          agentId: contribution.agent.agentId,
        }),
      );
    }

    // If stop condition met, broadcast stop to all agents
    if (policyResult?.stopResult?.stopped && deps.topologyRouter !== undefined) {
      fireAndForget("broadcast stop", () =>
        deps.topologyRouter?.broadcastStop(
          policyResult?.stopResult?.reason ?? "Stop condition met",
        ),
      );
    }

    // --- Post-write: execute after_contribute hook (outside mutex scope) ---
    if (
      deps.hookRunner !== undefined &&
      deps.hookCwd !== undefined &&
      deps.contract !== undefined
    ) {
      if (deps.contract.hooks?.after_contribute !== undefined) {
        const hookEntry = deps.contract.hooks.after_contribute;
        fireAndForget("after_contribute hook", () =>
          deps.hookRunner?.run(hookEntry, deps.hookCwd!),
        );
      }
    }

    return ok({
      cid: contribution.cid,
      kind: contribution.kind,
      mode: contribution.mode,
      summary: contribution.summary,
      artifactCount: Object.keys(contribution.artifacts).length,
      relationCount: contribution.relations.length,
      createdAt: contribution.createdAt,
      ...(policyResult !== undefined ? { policy: policyResult } : {}),
    });
  } catch (error) {
    return fromGroveError(error);
  }
}

/**
 * Submit a review of an existing contribution.
 * Sugar over contributeOperation: sets kind=review, adds reviews relation.
 */
export async function reviewOperation(
  input: ReviewInput,
  deps: OperationDeps,
): Promise<OperationResult<ReviewResult>> {
  const relations: Relation[] = [
    {
      targetCid: input.targetCid,
      relationType: RelationType.Reviews,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
  ];

  const result = await contributeOperation(
    {
      kind: CK.Review,
      mode: CM.Evaluation,
      summary: input.summary,
      relations,
      tags: input.tags,
      agent: input.agent,
      ...pickDefined(input, ["description", "scores", "context"]),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<ReviewResult>;

  return ok({
    cid: result.value.cid,
    kind: "review" as const,
    targetCid: input.targetCid,
    summary: result.value.summary,
    createdAt: result.value.createdAt,
  });
}

/**
 * Submit a reproduction attempt of an existing contribution.
 * Sugar over contributeOperation: sets kind=reproduction, adds reproduces relation.
 */
export async function reproduceOperation(
  input: ReproduceInput,
  deps: OperationDeps,
): Promise<OperationResult<ReproduceResult>> {
  const reproResult = input.result ?? "confirmed";

  const relations: Relation[] = [
    {
      targetCid: input.targetCid,
      relationType: RelationType.Reproduces,
      metadata: { result: reproResult } as Readonly<Record<string, JsonValue>>,
    },
  ];

  const result = await contributeOperation(
    {
      kind: CK.Reproduction,
      mode: CM.Evaluation,
      summary: input.summary,
      artifacts: input.artifacts,
      relations,
      tags: input.tags,
      agent: input.agent,
      ...pickDefined(input, ["description", "scores", "context"]),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<ReproduceResult>;

  return ok({
    cid: result.value.cid,
    kind: "reproduction" as const,
    targetCid: input.targetCid,
    result: reproResult,
    summary: result.value.summary,
    createdAt: result.value.createdAt,
  });
}

/**
 * Post a discussion or reply.
 * Sugar over contributeOperation: sets kind=discussion, mode=exploration.
 */
export async function discussOperation(
  input: DiscussInput,
  deps: OperationDeps,
): Promise<OperationResult<DiscussResult>> {
  const relations: Relation[] = [];
  if (input.targetCid !== undefined) {
    relations.push({
      targetCid: input.targetCid,
      relationType: RelationType.RespondsTo,
    });
  }

  const result = await contributeOperation(
    {
      kind: CK.Discussion,
      mode: CM.Exploration,
      summary: input.summary,
      relations,
      tags: input.tags,
      agent: input.agent,
      ...pickDefined(input, ["description", "context"]),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<DiscussResult>;

  return ok({
    cid: result.value.cid,
    kind: "discussion" as const,
    ...(input.targetCid !== undefined ? { targetCid: input.targetCid } : {}),
    summary: result.value.summary,
    createdAt: result.value.createdAt,
  });
}

/**
 * Adopt an existing contribution.
 * Sugar over contributeOperation: sets kind=adoption, adds adopts relation.
 */
export async function adoptOperation(
  input: AdoptInput,
  deps: OperationDeps,
): Promise<OperationResult<AdoptResult>> {
  const relations: Relation[] = [
    {
      targetCid: input.targetCid,
      relationType: RelationType.Adopts,
    },
  ];

  const result = await contributeOperation(
    {
      kind: CK.Adoption,
      mode: CM.Evaluation,
      summary: input.summary,
      relations,
      tags: input.tags,
      agent: input.agent,
      ...pickDefined(input, ["description", "context"]),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<AdoptResult>;

  return ok({
    cid: result.value.cid,
    kind: "adoption" as const,
    targetCid: input.targetCid,
    summary: result.value.summary,
    createdAt: result.value.createdAt,
  });
}
