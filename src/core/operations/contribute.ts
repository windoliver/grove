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
import { isEphemeralMessageContext } from "./context-schemas.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { err, fromGroveError, notFound, OperationErrorCode, ok, validationErr } from "./result.js";

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

/**
 * An entry in the idempotency cache. Can be in one of two states:
 *   - `pending`: a write is currently in-flight. Subsequent callers with
 *     the same key must await this Promise rather than starting a second
 *     write (single-flight).
 *   - `value`: the write has completed and the result is cached.
 *
 * Both states carry a `fingerprint` — a canonical hash of the request's
 * intent (kind, summary, agent, relations, artifacts, tags). Lookups with
 * a mismatched fingerprint are rejected with a STATE_CONFLICT error
 * instead of silently returning the first call's result — that matches
 * HTTP Idempotency-Key semantics (see Stripe, AWS, RFC draft) and surfaces
 * client bugs where the same key is reused across different intents.
 */
interface CachedIdempotencyEntry {
  readonly fingerprint: string;
  readonly storedAt: number;
  readonly pending?: Promise<OperationResult<ContributeResult>>;
  readonly value?: ContributeResult;
}

/**
 * Per-process cache of idempotency-key → contribute result.
 *
 * Map iteration order is insertion order, so we can implement a simple LRU
 * by deleting + re-inserting on read. Entries are also expired by timestamp
 * on lookup. Not shared across processes — clients running multiple grove
 * instances must coordinate keys themselves.
 *
 * Process-restart gap: this cache is not persisted. If a client submits a
 * contribution, receives a timeout, and retries after a process restart, the
 * retry will not hit the cache and may produce a duplicate contribution.
 * Clients that need restart-safe deduplication should use content-addressed
 * CIDs or a separate coordination layer. A store-backed idempotency table
 * would close this gap but is deferred to a future saga-log project.
 *
 * Single-flight: when a caller first observes a key miss, it synchronously
 * inserts a pending entry holding a Promise the write will resolve. Any
 * concurrent caller with the same key awaits that Promise. JavaScript is
 * single-threaded, so the check-then-insert is atomic without a mutex.
 */
const idempotencyCache = new Map<string, CachedIdempotencyEntry>();

/** Build the cache key. Namespaced per agent so two agents can share keys. */
function idempotencyCacheKey(agentScope: string, key: string): string {
  return `${agentScope}\u0000${key}`;
}

/**
 * Deeply canonicalize a JSON-like value for stable fingerprint hashing.
 *
 * JSON.stringify preserves object-key insertion order, so two objects
 * with the same keys in different order would produce different
 * strings. This walker recursively sorts object keys and normalizes
 * arrays (preserving order, since array order is usually meaningful).
 * Used to fingerprint the `context` and `scores` fields where field
 * order is not semantic.
 */
function canonicalizeForFingerprint(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeForFingerprint(v));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalizeForFingerprint(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical fingerprint of a contribute request's intent.
 *
 * Captures the full persisted payload shape so any difference that
 * could produce a different stored contribution is reflected in the
 * hash:
 *
 *   - kind, mode, summary, description
 *   - `context` (deep-canonicalized so key order doesn't matter) —
 *     plans store their task list here, messages store recipients +
 *     body, grove_done stores the ephemeral flag + reason
 *   - `scores` (deep-canonicalized) — per-metric values
 *   - `artifacts` as sorted (name → hash) pairs, not just hashes —
 *     a rename changes identity even if the hash is the same
 *   - `relations` sorted by targetCid (+ type, metadata)
 *   - `tags` sorted
 *   - agentScope (role ?? agentId) mirroring the cache-key namespace
 *
 * Excludes `createdAt` (always varies), `agent` object (scope stands
 * in), and `idempotencyKey` (that's the lookup key itself).
 *
 * Two requests with the same key + same fingerprint → treat as retries,
 * return cached result.
 * Two requests with the same key + different fingerprint → reject with
 * STATE_CONFLICT to surface the client bug.
 *
 * NB: the fingerprint must include every field that could make the
 * stored contribution differ in an observable way. Adding new fields
 * to ContributeInput or the contribution manifest WITHOUT adding them
 * here re-opens the "same key, different stored payload" loophole.
 */
function computeIdempotencyFingerprint(
  input: ContributeInput,
  agent: { readonly agentId: string; readonly role?: string | undefined },
): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    mode: input.mode ?? null,
    summary: input.summary,
    description: input.description ?? null,
    // Sort artifacts by name and keep name→hash pairs so a rename
    // (same hash, different filename) produces a different fingerprint.
    artifacts: input.artifacts
      ? Object.entries(input.artifacts)
          .slice()
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, hash]) => ({ name, hash }))
      : [],
    relations: input.relations
      ? [...input.relations]
          .map((r) => ({
            target: r.targetCid,
            type: r.relationType,
            metadata: canonicalizeForFingerprint(r.metadata),
          }))
          .sort((a, b) => {
            if (a.target !== b.target) return a.target < b.target ? -1 : 1;
            return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
          })
      : [],
    tags: input.tags ? [...input.tags].sort() : [],
    // Context varies per kind (plan tasks, message body, done marker, etc).
    // Deep canonicalization so { a: 1, b: 2 } and { b: 2, a: 1 } hash the same.
    context: canonicalizeForFingerprint(input.context),
    // Scores are per-metric numeric payloads; omitting them would let a
    // caller silently overwrite a metric by reusing an idempotency key.
    scores: canonicalizeForFingerprint(input.scores),
    // Scope mirrors the cache key: role wins if present, else agentId.
    // Without this, two agents sharing a role would see the same cache
    // key but different fingerprints → spurious STATE_CONFLICT on what
    // should be a shared-scope retry.
    agentScope: agent.role ?? agent.agentId,
  });
  // Simple non-cryptographic hash — collisions would only cause a
  // false-positive "same input" response, and the attacker would need to
  // control the idempotency key namespace anyway (scoped per-agent).
  let h = 0;
  for (let i = 0; i < canonical.length; i++) {
    h = (h * 31 + canonical.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * Check the cache for an existing entry. Returns:
 *   - `{ type: "pending", promise }` — an in-flight write with the same
 *     fingerprint. Caller should await and return.
 *   - `{ type: "value", result }` — a completed cached result. Caller
 *     should return it directly.
 *   - `{ type: "conflict", message }` — a cached entry exists but with
 *     a different fingerprint. Caller should return STATE_CONFLICT.
 *   - `undefined` — no usable entry (miss or expired). Caller should
 *     reserve the slot via `reserveIdempotencySlot` and run the write.
 */
function lookupIdempotency(
  cacheKey: string,
  fingerprint: string,
  now: number,
):
  | { readonly type: "pending"; readonly promise: Promise<OperationResult<ContributeResult>> }
  | { readonly type: "value"; readonly result: ContributeResult }
  | { readonly type: "conflict"; readonly message: string }
  | undefined {
  const entry = idempotencyCache.get(cacheKey);
  if (entry === undefined) return undefined;
  if (now - entry.storedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return undefined;
  }
  if (entry.fingerprint !== fingerprint) {
    return {
      type: "conflict",
      message:
        "Idempotency key was previously used with a different request body. " +
        "Reusing the same key with different input is rejected to prevent silent " +
        "write divergence. Use a new key for the new intent.",
    };
  }
  // LRU touch: move to end of insertion order.
  idempotencyCache.delete(cacheKey);
  idempotencyCache.set(cacheKey, entry);
  if (entry.pending !== undefined) {
    return { type: "pending", promise: entry.pending };
  }
  if (entry.value !== undefined) {
    return { type: "value", result: entry.value };
  }
  return undefined;
}

/**
 * Synchronously reserve a cache slot with a pending Promise. Subsequent
 * concurrent calls with the same key will find this pending entry and
 * await it (single-flight). Returns a resolver the caller must invoke
 * exactly once with the final OperationResult.
 */
function reserveIdempotencySlot(
  cacheKey: string,
  fingerprint: string,
  now: number,
): {
  readonly resolve: (result: OperationResult<ContributeResult>) => void;
  readonly release: () => void;
} {
  // Evict the oldest entry if at capacity.
  if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest !== undefined) idempotencyCache.delete(oldest);
  }

  let resolver!: (result: OperationResult<ContributeResult>) => void;
  const pending = new Promise<OperationResult<ContributeResult>>((r) => {
    resolver = r;
  });

  idempotencyCache.set(cacheKey, { fingerprint, storedAt: now, pending });

  return {
    resolve: (result) => {
      // Transition the slot from pending → final.
      if (result.ok) {
        idempotencyCache.set(cacheKey, {
          fingerprint,
          storedAt: Date.now(),
          value: result.value,
        });
      } else {
        // On error, delete the slot so retries can make progress.
        idempotencyCache.delete(cacheKey);
      }
      resolver(result);
    },
    release: () => {
      // Called on unexpected exception (e.g., thrown error not caught by
      // fromGroveError). Remove the slot so retries aren't blocked.
      idempotencyCache.delete(cacheKey);
    },
  };
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
 *
 * The `putWithCowrite` parameter may be sync (raw SqliteContributionStore)
 * or async (EnforcingContributionStore wrapping a SQLite store — its
 * enforcement hooks are async but the inner cowrite callback still runs
 * synchronously inside the transaction, so handoff IDs are populated
 * before the outer Promise resolves).
 */
async function writeAtomic(
  contribution: Contribution,
  routedTo: readonly string[],
  agentRole: string,
  putWithCowrite: (c: Contribution, fn: () => void) => void | Promise<void>,
  insertSync: (input: HandoffInput) => string,
): Promise<readonly string[]> {
  const handoffIds: string[] = [];
  const maybePromise = putWithCowrite(contribution, () => {
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
  if (
    maybePromise !== undefined &&
    typeof (maybePromise as { then?: unknown }).then === "function"
  ) {
    await maybePromise;
  }
  return handoffIds;
}

/**
 * Serial write path: write the contribution first, then create the handoff
 * records. Used when the store does not support atomic cowrite (in-memory
 * stores, Nexus VFS handoff store).
 *
 * Uses handoffStore.createMany() when available to fan out N handoffs in
 * one round-trip (Issue 15A in the #228 review). Falls back to a sequential
 * create() loop for stores that don't implement the batch API.
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

  const inputs: HandoffInput[] = routedTo.map((targetRole) => ({
    sourceCid: contribution.cid,
    fromRole: agentRole,
    toRole: targetRole,
    requiresReply: false,
  }));

  if (handoffStore.createMany !== undefined) {
    try {
      const handoffs = await handoffStore.createMany(inputs);
      for (const h of handoffs) handoffIds.push(h.handoffId);
    } catch (err) {
      // Best-effort: contribution is already committed. Log so operators can
      // diagnose routing gaps (downstream agents may not be notified).
      console.warn(
        `[grove] handoff batch failed for cid=${contribution.cid} roles=${inputs.map((i) => i.toRole).join(",")}`,
        err,
      );
    }
    return handoffIds;
  }

  // Fallback for stores without createMany: fan out in parallel so N handoffs
  // pay 1×RTT instead of N×RTT. allSettled ensures a single failure doesn't
  // abandon the remaining handoffs. Wrap each call in Promise.resolve().then()
  // so a synchronous throw inside create() becomes a rejected promise rather
  // than escaping map() and bypassing allSettled (which would violate the
  // best-effort contract: the contribution is already committed by this point).
  const results = await Promise.allSettled(
    inputs.map((input) => Promise.resolve().then(() => handoffStore.create(input))),
  );
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      handoffIds.push(result.value.handoffId);
    } else {
      // Best-effort: contribution is already committed.
      console.warn(
        `[grove] handoff create failed for cid=${contribution.cid} role=${inputs[i]?.toRole}`,
        result.reason,
      );
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
      putWithCowrite?: (c: Contribution, fn: () => void) => void | Promise<void>;
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
  // Hoisted out of the try block so the outer catch can release the slot
  // on thrown errors. Single-flight: while a slot holds a pending Promise,
  // concurrent callers with the same key await that Promise instead of
  // racing through the write path.
  let idempotencySlot:
    | {
        readonly resolve: (result: OperationResult<ContributeResult>) => void;
        readonly release: () => void;
      }
    | undefined;

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

    // --- Idempotency: single-flight with request fingerprinting ---
    //
    // Explicit client-supplied key, namespaced per agent. HTTP
    // Idempotency-Key semantics (Stripe / AWS / RFC draft):
    //
    //   - same key + same fingerprint → return cached result (retry)
    //   - same key + different fingerprint → STATE_CONFLICT (bug)
    //   - same key + in-flight → await the pending Promise (single-flight)
    //
    // Replaces the previous heuristic that did a 60s same-summary lookup;
    // that approach false-positived on legitimate retries (e.g., updatePlan
    // called twice with the same title) and missed real retries under
    // concurrency because the window query was unbounded across all agents.
    //
    // Critically: the check-then-reserve is synchronous (no await between
    // lookup miss and slot insertion). JavaScript is single-threaded, so
    // two concurrent callers cannot both observe a miss and race past the
    // insert — the second caller sees the first caller's pending entry.
    const idempotencyAgentScope = agent.role ?? agent.agentId;
    const idempotencyCacheLookupKey =
      input.idempotencyKey !== undefined
        ? idempotencyCacheKey(idempotencyAgentScope, input.idempotencyKey)
        : undefined;
    if (idempotencyCacheLookupKey !== undefined) {
      const fingerprint = computeIdempotencyFingerprint(input, agent);
      const cached = lookupIdempotency(idempotencyCacheLookupKey, fingerprint, Date.now());
      if (cached !== undefined) {
        if (cached.type === "pending") {
          // Concurrent caller: await their write and return the same result.
          return cached.promise;
        }
        if (cached.type === "value") {
          return ok(cached.result);
        }
        // type === "conflict" — key reused with different input.
        return err({
          code: OperationErrorCode.StateConflict,
          message: cached.message,
          details: { idempotencyKey: input.idempotencyKey },
        });
      }
      // Miss: synchronously reserve the slot. Subsequent concurrent
      // callers observe the pending Promise and await it.
      idempotencySlot = reserveIdempotencySlot(idempotencyCacheLookupKey, fingerprint, Date.now());
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

    // --- Ephemeral flag is reserved for discussions ---
    // context.ephemeral=true is a routing/frontier skip signal intended for
    // chat messages and grove_done session terminators, both of which are
    // kind=discussion. Allowing it on work/review/reproduction/adoption would
    // make real progress invisible to the topology router, handoff store,
    // stop-condition evaluator, AND the frontier calculator (which filters
    // out ephemeral contributions). Reject the combination explicitly so
    // caller bugs surface instead of silently dropping work.
    if (contribution.kind !== CK.Discussion && contribution.context?.ephemeral === true) {
      const errResult = validationErr(
        `context.ephemeral=true is only valid on kind=discussion contributions ` +
          `(chat messages and session terminators). Got kind='${contribution.kind}'. ` +
          `The ephemeral flag suppresses topology routing, handoff creation, and ` +
          `frontier inclusion — setting it on progress contributions would make them invisible.`,
      );
      // Resolve the idempotency slot with this permanent error so any
      // concurrent retry with the same key gets the same response.
      idempotencySlot?.resolve(errResult);
      return errResult;
    }

    // --- Routing classification ---
    // Plans are coordination metadata (not progress). Done markers
    // (kind=discussion + context.done=true, written by grove_done) signal
    // session termination — they should NOT create handoff records for
    // downstream roles but MUST still fire a topology event so event-driven
    // clients like useDoneDetection() can observe session completion.
    // Ephemeral chat (kind=discussion + context.ephemeral=true WITHOUT
    // context.done) is background noise that should be invisible to the
    // routing layer entirely.
    //
    //   kind                   | handoffs | route event | stop conditions
    //   plan                   |    no    |     yes     |       no
    //   discussion (done)      |    no    |     yes     |       no
    //   discussion (chat)      |    no    |     no      |       no
    //   discussion (plain)     |    yes   |     yes     |       yes
    //   work / review / etc    |    yes   |     yes     |       yes
    //
    // Earlier versions of this branch collapsed done markers into the
    // "ephemeral discussion" row, which suppressed the route event too.
    // That turned out to strand event-driven done detection: when an
    // EventBus is present, useDoneDetection disables polling and waits
    // exclusively for contribution events on the bus. Without a route
    // event for the done marker, the UI never advanced out of "running"
    // after all roles signaled done. The two discussion rows must remain
    // distinct.
    const isPlan = contribution.kind === CK.Plan;
    const isDoneMarker = contribution.kind === CK.Discussion && contribution.context?.done === true;
    const isEphemeralChat =
      contribution.kind === CK.Discussion &&
      isEphemeralMessageContext(contribution.context) &&
      !isDoneMarker;
    // Done markers + ephemeral chat + plans all skip handoff creation.
    // A done marker is "session over — no work to pick up"; a chat message
    // is noise; a plan is coordination metadata.
    const skipHandoffs = isPlan || isDoneMarker || isEphemeralChat;
    // ONLY ephemeral chat skips the route event. Plans and done markers
    // still publish so downstream UIs / observers can react.
    const skipRouteEvent = isEphemeralChat;
    // None of these three count toward budget / quorum / deliberation
    // stop conditions.
    const skipStopConditions = isPlan || isDoneMarker || isEphemeralChat;

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
          policyResult = await enforcer?.enforce(c, true, { skipStopConditions });
        });
      } else {
        // Fallback: enforce outside mutex (non-EnforcingContributionStore)
        policyResult = await enforcer.enforce(contribution, true, { skipStopConditions });
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
        const edges = deps.topologyRouter.targetsFor(contribution.agent.role);
        // Deduplicate by target: a role may have multiple edge types (e.g.
        // delegates + feeds) pointing at the same downstream role. Creating
        // one handoff per (source, target) pair is correct; creating one per
        // edge type would produce duplicate pending handoffs for the same work.
        if (edges.length > 0) routedTo = [...new Set(edges.map((e) => e.target))];
      }
    }

    // --- Write: contribution + handoffs (atomic when supported, serial otherwise) ---
    // Plans + ephemeral messages skip handoff creation entirely by passing
    // undefined as the routing-target list to the writer.
    const agentRole = contribution.agent.role;
    const handoffsRoutedTo = skipHandoffs ? undefined : routedTo;
    const handoffIds = await writeContributionWithHandoffs(
      contribution,
      handoffsRoutedTo,
      agentRole,
      deps.contributionStore,
      deps.handoffStore,
    );

    // ┌──────────────────────────────────────────────────────────────────┐
    // │ DURABLE COMMIT BOUNDARY                                          │
    // │                                                                  │
    // │ The contribution (and any atomic-path handoffs) are now durably │
    // │ written to the store. Everything below this line is post-write │
    // │ side-effect — it must NEVER cause the already-committed write  │
    // │ to be "undone" from the caller's perspective.                   │
    // │                                                                  │
    // │ Idempotency resolution happens HERE, not at the end of the     │
    // │ function, because a throw in persistOutcome or a user-supplied │
    // │ callback would otherwise release the slot and let a retry     │
    // │ produce a duplicate contribution with a fresh createdAt.       │
    // │                                                                  │
    // │ The cached response reflects committed state only — subsequent │
    // │ post-write updates (stop-condition recheck changing            │
    // │ policyResult.stopResult) are NOT propagated into the cache.    │
    // │ The first caller still sees the full updated result via the   │
    // │ direct return below; cached retries see the committed-only    │
    // │ snapshot, which is still correct (the contribution is the      │
    // │ same, only the advisory stop signal differs).                  │
    // └──────────────────────────────────────────────────────────────────┘
    const committedResult: ContributeResult = {
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

    if (idempotencySlot !== undefined) {
      idempotencySlot.resolve(ok(committedResult));
      // Clear the local reference so the outer catch(error) handler can't
      // release the slot for a post-commit failure. The contribution is
      // durably written; retries with the same key must return this cached
      // result, NOT re-run the write path.
      idempotencySlot = undefined;
    }

    // Post-write callbacks — wrapped so a throw cannot escape and undo
    // the commit from the caller's perspective.
    try {
      deps.onContributionWrite?.();
      deps.onContributionWritten?.(contribution.cid);
    } catch (callbackErr) {
      process.stderr.write(
        `[grove] Warning: onContributionWrite* callback threw after commit: ${
          callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
        }\n`,
      );
    }

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
    // Wrapped: a throw from the outcome store must not undo the committed
    // contribution write or leak to the caller as a fresh error. The
    // contribution is already in the DAG; failed outcome persistence is
    // a downstream bookkeeping issue, not a write failure.
    if (policyResult?.derivedOutcome !== undefined && enforcer !== undefined) {
      try {
        await enforcer.persistOutcome(contribution.cid, policyResult.derivedOutcome);
      } catch (persistErr) {
        process.stderr.write(
          `[grove] Warning: persistOutcome failed after commit (cid=${contribution.cid.slice(0, 16)}): ${
            persistErr instanceof Error ? persistErr.message : String(persistErr)
          }\n`,
        );
      }
    }

    // --- Post-write: route events via topology (fire-and-forget) ---
    // Ephemeral messages skip the routing event entirely so chat doesn't
    // wake downstream agents. Plans still fire the event so live UIs can
    // observe plan creation, but the handoff record was already suppressed.
    if (
      !skipRouteEvent &&
      routedTo !== undefined &&
      deps.topologyRouter !== undefined &&
      agentRole !== undefined
    ) {
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
    // Plans + ephemeral messages skip this recheck — they were excluded from the
    // pre-write evaluation too (skipStopConditions), so there is no threshold-
    // crossing semantics to recover here.
    //
    // Best-effort: errors here must not fail the already-committed write. A store
    // read failure during the recheck is logged but does not surface as a failed
    // operation — the contribution is already in the DAG.
    if (
      !skipStopConditions &&
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

    // Build the final result returned to the DIRECT caller. This includes
    // any post-write updates to policyResult (e.g., stop-condition recheck
    // detecting a threshold crossing). Cached retries get the narrower
    // `committedResult` built above — that's intentional, see the
    // DURABLE COMMIT BOUNDARY comment.
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

    return ok(result);
  } catch (error) {
    // Release the idempotency slot ONLY if it's still reserved here. The
    // slot is cleared (set to undefined) immediately after the durable
    // commit boundary above — so this release path can only fire for
    // errors that happened BEFORE the contribution was durably written
    // (validation, policy enforcement inside the mutex, store write
    // failure). Post-commit failures flow through the committed result
    // path and never reach this catch.
    idempotencySlot?.release();
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
