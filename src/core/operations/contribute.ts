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
import type { HandoffInput, HandoffStore } from "../handoff.js";
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

/** Shared fields present on every contribution operation result. */
export interface BaseContributionResult {
  readonly cid: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** Result of a contribute operation. */
export interface ContributeResult extends BaseContributionResult {
  readonly kind: ContributionKind;
  readonly mode: ContributionMode;
  readonly artifactCount: number;
  readonly relationCount: number;
  /** Roles that received a routing event for this contribution. */
  readonly routedTo?: readonly string[] | undefined;
  /** IDs of handoff records created for this contribution. */
  readonly handoffIds?: readonly string[] | undefined;
  /** Policy enforcement result (present when a contract is loaded). */
  readonly policy?: PolicyEnforcementResult | undefined;
}

/** Result of a review operation. */
export interface ReviewResult extends BaseContributionResult {
  readonly kind: "review";
  readonly targetCid: string;
}

/** Result of a reproduce operation. */
export interface ReproduceResult extends BaseContributionResult {
  readonly kind: "reproduction";
  readonly targetCid: string;
  readonly result: string;
}

/** Result of a discuss operation. */
export interface DiscussResult extends BaseContributionResult {
  readonly kind: "discussion";
  readonly targetCid?: string | undefined;
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
  /**
   * Optional client-supplied idempotency key. When set, repeated calls with
   * the same key (within IDEMPOTENCY_TTL_MS) return the previously-stored
   * contribution metadata instead of creating a new contribution.
   *
   * Follows HTTP `Idempotency-Key` conventions: opaque string, scoped per
   * agent (the key is namespaced by `agent.role ?? agent.agentId`). Two
   * different agents can use the same key without colliding.
   *
   * If omitted, no deduplication is performed — clients that need retry
   * safety should generate a key and pass it on every retry.
   */
  readonly idempotencyKey?: string | undefined;
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
export interface AdoptResult extends BaseContributionResult {
  readonly kind: "adoption";
  readonly targetCid: string;
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
  if (relations.length === 0) return undefined;
  const cids = relations.map((r) => r.targetCid);
  const found = await store.getMany(cids);
  for (const cid of cids) {
    if (!found.has(cid)) {
      return notFound("Contribution", cid);
    }
  }
  return undefined;
}

/**
 * Validate that all artifact hashes exist in CAS.
 * Existence checks run in parallel via Promise.all so a contribution with
 * N artifacts pays 1×rtt instead of N×rtt against a remote CAS.
 * Returns a validation error if any hash is missing, or undefined if all valid.
 */
async function validateArtifacts(
  deps: OperationDeps,
  artifacts: Readonly<Record<string, string>>,
): Promise<OperationResult<void> | undefined> {
  if (deps.cas === undefined) {
    return validationErr("Artifact validation not available (missing cas)");
  }
  const cas = deps.cas;
  const entries = Object.entries(artifacts);
  const checks = await Promise.all(
    entries.map(async ([name, hash]) => ({ name, hash, exists: await cas.exists(hash) })),
  );
  for (const { name, hash, exists } of checks) {
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
// Idempotency cache
// ---------------------------------------------------------------------------

/** Time window during which a cached idempotency result is reused. */
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** Maximum number of cached idempotency entries (LRU eviction). */
const IDEMPOTENCY_MAX_ENTRIES = 1024;

interface CachedIdempotencyResult {
  readonly value: ContributeResult;
  readonly storedAt: number;
}

/**
 * Per-process cache of idempotency-key → contribute result.
 *
 * Map iteration order is insertion order, so we can implement a simple LRU
 * by deleting + re-inserting on read. Entries are also expired by timestamp
 * on lookup. Not shared across processes — clients running multiple grove
 * instances must coordinate keys themselves.
 */
const idempotencyCache = new Map<string, CachedIdempotencyResult>();

/** Build the cache key. Namespaced per agent so two agents can share keys. */
function idempotencyCacheKey(agentScope: string, key: string): string {
  return `${agentScope}\u0000${key}`;
}

function lookupIdempotency(cacheKey: string, now: number): ContributeResult | undefined {
  const entry = idempotencyCache.get(cacheKey);
  if (entry === undefined) return undefined;
  if (now - entry.storedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return undefined;
  }
  // LRU touch: move to end of insertion order.
  idempotencyCache.delete(cacheKey);
  idempotencyCache.set(cacheKey, entry);
  return entry.value;
}

function storeIdempotency(cacheKey: string, value: ContributeResult, now: number): void {
  // Evict the oldest entry if at capacity.
  if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest !== undefined) idempotencyCache.delete(oldest);
  }
  idempotencyCache.set(cacheKey, { value, storedAt: now });
}

/**
 * Test-only: clear the idempotency cache between test cases. Not exported
 * from the package index — only intended for in-package tests.
 */
export function _resetIdempotencyCacheForTests(): void {
  idempotencyCache.clear();
}

// ---------------------------------------------------------------------------
// Contribution write paths
// ---------------------------------------------------------------------------

/**
 * Atomic write path: SQLite stores supporting `putWithCowrite` write the
 * contribution and all handoff records inside a single SQLite transaction.
 * Used when both the contribution store and handoff store are SQLite-backed.
 */
function writeAtomic(
  contribution: Contribution,
  routedTo: readonly string[],
  agentRole: string,
  putWithCowrite: (c: Contribution, fn: () => void) => void,
  insertSync: (input: HandoffInput) => string,
): readonly string[] {
  const handoffIds: string[] = [];
  putWithCowrite(contribution, () => {
    for (const targetRole of routedTo) {
      const hid = insertSync({
        sourceCid: contribution.cid,
        fromRole: agentRole,
        toRole: targetRole,
        requiresReply: false,
      });
      if (hid !== undefined) handoffIds.push(hid);
    }
  });
  return handoffIds;
}

/**
 * Serial write path: write the contribution first, then create each handoff
 * record sequentially. Used when the store does not support atomic cowrite
 * (in-memory stores, Nexus VFS handoff store).
 *
 * Best-effort handoffs: a handoff insertion failure must not fail the
 * already-committed contribution write. The contribution is in the DAG;
 * handoff records are the secondary artifact.
 */
async function writeSerial(
  contribution: Contribution,
  routedTo: readonly string[] | undefined,
  agentRole: string | undefined,
  store: ContributionStore,
  handoffStore: HandoffStore | undefined,
): Promise<readonly string[]> {
  await store.put(contribution);

  const handoffIds: string[] = [];
  if (handoffStore === undefined || routedTo === undefined || agentRole === undefined) {
    return handoffIds;
  }

  for (const targetRole of routedTo) {
    try {
      const handoff = await handoffStore.create({
        sourceCid: contribution.cid,
        fromRole: agentRole,
        toRole: targetRole,
        requiresReply: false,
      });
      handoffIds.push(handoff.handoffId);
    } catch {
      // Best-effort: contribution is already committed.
    }
  }
  return handoffIds;
}

/**
 * Dispatch to the atomic or serial write path based on store capabilities.
 * Centralizes the duck-typing on `putWithCowrite` / `insertSync` so the
 * caller doesn't have to manage capability detection.
 */
async function writeContributionWithHandoffs(
  contribution: Contribution,
  routedTo: readonly string[] | undefined,
  agentRole: string | undefined,
  store: ContributionStore,
  handoffStore: HandoffStore | undefined,
): Promise<readonly string[]> {
  const needsHandoffs =
    handoffStore !== undefined &&
    routedTo !== undefined &&
    routedTo.length > 0 &&
    agentRole !== undefined;

  if (needsHandoffs) {
    const cowriteStore = store as {
      putWithCowrite?: (c: Contribution, fn: () => void) => void;
    };
    const sqliteHandoffStore = handoffStore as {
      insertSync?: (input: HandoffInput) => string;
    };
    if (cowriteStore.putWithCowrite !== undefined && sqliteHandoffStore.insertSync !== undefined) {
      return writeAtomic(
        contribution,
        routedTo,
        agentRole,
        cowriteStore.putWithCowrite.bind(cowriteStore),
        sqliteHandoffStore.insertSync.bind(sqliteHandoffStore),
      );
    }
  }

  return writeSerial(contribution, routedTo, agentRole, store, handoffStore);
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

    // Idempotency check: explicit client-supplied key, namespaced per agent.
    // Replaces the previous heuristic that did a 60s same-summary lookup; that
    // approach false-positived on legitimate retries (e.g., updatePlan called
    // twice with the same title) and missed real retries under concurrency
    // because the window query was unbounded across all agents.
    const idempotencyAgentScope = agent.role ?? agent.agentId;
    const idempotencyCacheLookupKey =
      input.idempotencyKey !== undefined
        ? idempotencyCacheKey(idempotencyAgentScope, input.idempotencyKey)
        : undefined;
    if (idempotencyCacheLookupKey !== undefined) {
      const cached = lookupIdempotency(idempotencyCacheLookupKey, Date.now());
      if (cached !== undefined) {
        return ok(cached);
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
    let enforcer: PolicyEnforcer | undefined;
    if (deps.contract !== undefined && deps.contributionStore !== undefined) {
      enforcer = new PolicyEnforcer(deps.contract, deps.contributionStore, deps.outcomeStore);

      // Register per-CID preWriteHook for atomic enforce+put (TOCTOU-safe).
      // Keyed by CID so concurrent contributes don't overwrite each other's hooks.
      const store = deps.contributionStore as {
        setPreWriteHook?: (cid: string, hook: (c: Contribution) => Promise<void>) => void;
      };
      if (store.setPreWriteHook) {
        store.setPreWriteHook(contribution.cid, async (c: Contribution) => {
          policyResult = await enforcer?.enforce(c, true);
        });
      } else {
        // Fallback: enforce outside mutex (non-EnforcingContributionStore)
        policyResult = await enforcer.enforce(contribution, true);
      }
    }

    // --- Pre-write: determine routing targets synchronously (no I/O) ---
    let routedTo: readonly string[] | undefined;
    if (deps.topologyRouter !== undefined) {
      if (contribution.agent.role === undefined) {
        // Issue 4A: warn when topology is active but contributing agent has no role
        process.stderr.write(
          `[grove] Warning: topology router is active but agent '${contribution.agent.agentId}' has no role — routing skipped. Set agent.role to enable topology routing.\n`,
        );
      } else {
        const targets = deps.topologyRouter.targetsFor(contribution.agent.role);
        if (targets.length > 0) routedTo = [...targets];
      }
    }

    // --- Write: contribution + handoffs (atomic when supported, serial otherwise) ---
    const agentRole = contribution.agent.role;
    const handoffIds = await writeContributionWithHandoffs(
      contribution,
      routedTo,
      agentRole,
      deps.contributionStore,
      deps.handoffStore,
    );
    deps.onContributionWrite?.();
    deps.onContributionWritten?.(contribution.cid);

    // --- Post-write: mark upstream handoffs as replied (fire-and-forget) ---
    // When this contribution targets another CID (reviews/responds_to), find
    // any pending handoffs with sourceCid = targetCid and mark them replied.
    if (deps.handoffStore !== undefined && contribution.relations.length > 0) {
      const replyRelations = contribution.relations.filter(
        (r) =>
          r.relationType === "reviews" ||
          r.relationType === "responds_to" ||
          r.relationType === "adopts",
      );
      if (replyRelations.length > 0) {
        fireAndForget("handoff reply transition", async () => {
          for (const rel of replyRelations) {
            try {
              const pending = await deps.handoffStore?.list({
                sourceCid: rel.targetCid,
                status: "pending_pickup",
              });
              for (const h of pending ?? []) {
                await deps.handoffStore?.markReplied(h.handoffId, contribution.cid);
              }
            } catch {
              // Best-effort — don't fail contribution over handoff transition
            }
          }
        });
      }
    }

    // --- Post-write: persist derived outcome (outside mutex scope) ---
    if (policyResult?.derivedOutcome !== undefined && enforcer !== undefined) {
      await enforcer.persistOutcome(contribution.cid, policyResult.derivedOutcome);
    }

    // --- Post-write: route events via topology (fire-and-forget) ---
    if (routedTo !== undefined && deps.topologyRouter !== undefined && agentRole !== undefined) {
      fireAndForget("topology routing", () =>
        deps.topologyRouter?.route(agentRole, {
          cid: contribution.cid,
          kind: contribution.kind,
          summary: contribution.summary,
          agentId: contribution.agent.agentId,
        }),
      );
    }

    // --- Post-write: re-check stop conditions (outside mutex, best-effort) ---
    // The pre-write enforce() evaluates stop conditions before the contribution is
    // persisted, so the threshold-crossing write (e.g., the Nth review satisfying
    // quorum) would report stopped=false. Re-evaluate now that the store includes
    // this contribution. This runs outside the write mutex, so it doesn't block
    // concurrent writers. Only re-checks when the pre-write result said not stopped.
    //
    // Best-effort: errors here must not fail the already-committed write. A store
    // read failure during the recheck is logged but does not surface as a failed
    // operation — the contribution is already in the DAG.
    if (
      policyResult !== undefined &&
      !policyResult.stopResult?.stopped &&
      deps.contract?.stopConditions !== undefined &&
      deps.contributionStore !== undefined
    ) {
      try {
        const { evaluateStopConditions } = await import("../stop-conditions.js");
        const postWriteResult = await evaluateStopConditions(deps.contract, deps.contributionStore);
        if (postWriteResult.stopped) {
          policyResult = {
            ...policyResult,
            stopResult: {
              stopped: true,
              reason: Object.entries(postWriteResult.conditions)
                .filter(([, c]) => c.met)
                .map(([name, c]) => `${name}: ${c.reason}`)
                .join("; "),
            },
          };
        }
      } catch (err) {
        // Best-effort: the contribution is already committed. A stop-condition
        // recheck failure does not invalidate the write, but log it so operators
        // can detect cases where a threshold-crossing stop signal was lost.
        process.stderr.write(
          `[grove] Warning: post-write stop-condition recheck failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
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
        const hookCwd = deps.hookCwd;
        fireAndForget("after_contribute hook", () => deps.hookRunner?.run(hookEntry, hookCwd));
      }
    }

    const result: ContributeResult = {
      cid: contribution.cid,
      kind: contribution.kind,
      mode: contribution.mode,
      summary: contribution.summary,
      artifactCount: Object.keys(contribution.artifacts).length,
      relationCount: contribution.relations.length,
      createdAt: contribution.createdAt,
      ...(routedTo !== undefined ? { routedTo } : {}),
      ...(handoffIds.length > 0 ? { handoffIds } : {}),
      ...(policyResult !== undefined ? { policy: policyResult } : {}),
    };

    if (idempotencyCacheLookupKey !== undefined) {
      storeIdempotency(idempotencyCacheLookupKey, result, Date.now());
    }

    return ok(result);
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
