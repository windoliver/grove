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
import { computeContributionContentHash } from "../content-dedup.js";
import { contributionToEntity } from "../entity.js";
import { PolicyViolationError } from "../errors.js";
import { type HandoffInput, HandoffStatus, type HandoffStore } from "../handoff.js";
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
import { attachRoutingSignatureToInput } from "../routing-provenance.js";
import type { ContributionPutOutcome, ContributionPutResult, ContributionStore } from "../store.js";
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
  readonly accepted: number;
  readonly duplicate: number;
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
  /** Git commit SHA — preferred over CAS artifacts for code contributions. */
  readonly commitHash?: string | undefined;
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
  readonly idempotencyKey?: string | undefined;
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
  readonly idempotencyKey?: string | undefined;
}

/** Input for the discuss operation. */
export interface DiscussInput {
  readonly targetCid?: string | undefined;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly idempotencyKey?: string | undefined;
}

/** Input for the adopt operation. */
export interface AdoptInput {
  readonly targetCid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent?: AgentOverrides | undefined;
  readonly idempotencyKey?: string | undefined;
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
 * Per-relation kind constraints. When a relation type is listed here, the
 * target contribution's kind must appear in the allowed set or validation
 * fails. Per #236 — mirrors the explicit kind check in updatePlanOperation
 * so review/reproduce can't silently point at the wrong-kind contribution.
 */
const RELATION_EXPECTED_KINDS: Readonly<
  Partial<Record<RelationType, readonly ContributionKind[]>>
> = {
  [RelationType.Reviews]: [CK.Work],
  [RelationType.Reproduces]: [CK.Work],
};

/**
 * Validate that all relation targets exist in the store (batch) and that
 * their contribution kinds match the relation type's expectations.
 * Returns a validation error if any target is missing or has the wrong
 * kind, or undefined if all valid.
 */
async function validateRelations(
  store: ContributionStore,
  relations: readonly Relation[],
): Promise<OperationResult<void> | undefined> {
  if (relations.length === 0) return undefined;
  const cids = relations.map((r) => r.targetCid);
  const found = await store.getMany(cids);
  for (const rel of relations) {
    const target = found.get(rel.targetCid);
    if (!target) {
      return notFound("Contribution", rel.targetCid);
    }
    const expected = RELATION_EXPECTED_KINDS[rel.relationType];
    if (expected !== undefined && !expected.includes(target.kind)) {
      return validationErr(
        `Cannot create '${rel.relationType}' relation to a '${target.kind}' contribution (target: ${rel.targetCid})`,
      );
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

/** Attach runtime routing signature when orchestrator token is present. */
function withRuntimeRoutingSignature(input: ContributionInput): ContributionInput {
  const routingToken = process.env.GROVE_ROUTING_TOKEN;
  if (routingToken === undefined) return input;
  return attachRoutingSignatureToInput(input, routingToken);
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
  // Include session ID when available so the same key in different sessions
  // doesn't collide (MCP HTTP sessions share one idempotency store).
  const sessionId = process.env.GROVE_SESSION_ID ?? "";
  return `${sessionId}\u0000${agentScope}\u0000${key}`;
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
 *   - kind, mode, summary, description, commitHash
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
    commitHash: input.commitHash ?? null,
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
  // Never TTL-expire a pending entry — the in-flight write may still be
  // running (slow CAS, hooks, etc). Expiring it would let a retry start
  // a second write instead of awaiting the first.
  if (now - entry.storedAt > IDEMPOTENCY_TTL_MS && entry.pending === undefined) {
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
  // Evict the oldest non-pending entry if at capacity. Pending entries
  // represent in-flight writes — evicting them would break single-flight
  // and let a retry start a duplicate write.
  if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
    for (const [key, entry] of idempotencyCache) {
      if (entry.pending === undefined) {
        idempotencyCache.delete(key);
        break;
      }
    }
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

interface ContributionWriteOutcome {
  readonly putResult: ContributionPutResult;
  readonly handoffIds: readonly string[];
}

function normalizePutResult(
  contribution: Contribution,
  result: ContributionPutOutcome,
): ContributionPutResult {
  return (
    result ?? {
      cid: contribution.cid,
      isNew: true,
      contribution,
    }
  );
}

function resultFromContribution(
  contribution: Contribution,
  opts: {
    readonly storedCid?: string | undefined;
    readonly accepted: number;
    readonly duplicate: number;
    readonly routedTo?: readonly string[] | undefined;
    readonly handoffIds?: readonly string[] | undefined;
    readonly policy?: PolicyEnforcementResult | undefined;
  },
): ContributeResult {
  return {
    cid: opts.storedCid ?? contribution.cid,
    kind: contribution.kind,
    mode: contribution.mode,
    summary: contribution.summary,
    artifactCount: Object.keys(contribution.artifacts).length,
    relationCount: contribution.relations.length,
    createdAt: contribution.createdAt,
    accepted: opts.accepted,
    duplicate: opts.duplicate,
    ...(opts.routedTo !== undefined ? { routedTo: opts.routedTo } : {}),
    ...(opts.handoffIds !== undefined && opts.handoffIds.length > 0
      ? { handoffIds: opts.handoffIds }
      : {}),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
  };
}

async function findStoredDuplicateByContentHash(
  store: ContributionStore,
  contribution: Contribution,
): Promise<Contribution | undefined> {
  if (store.getByContentHash === undefined) return undefined;
  try {
    return await store.getByContentHash(computeContributionContentHash(contribution));
  } catch {
    // Best-effort fast path. If the lookup fails, continue through the normal
    // validation/write path so callers receive the original error surface.
    return undefined;
  }
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
  putWithCowrite: (
    c: Contribution,
    fn: () => void,
  ) => ContributionPutOutcome | Promise<ContributionPutOutcome>,
  insertSync: (input: HandoffInput) => string,
  onCommit?: () => void,
  replyTimeouts?: ReadonlyMap<string, number> | undefined,
): Promise<ContributionWriteOutcome> {
  const handoffIds: string[] = [];
  const maybePromise = putWithCowrite(contribution, () => {
    for (const targetRole of routedTo) {
      const timeoutSec = replyTimeouts?.get(targetRole);
      const hid = insertSync({
        sourceCid: contribution.cid,
        fromRole: agentRole,
        toRole: targetRole,
        requiresReply: timeoutSec !== undefined,
        ...(timeoutSec !== undefined
          ? { replyDueAt: new Date(Date.now() + timeoutSec * 1000).toISOString() }
          : {}),
      });
      if (hid !== undefined) handoffIds.push(hid);
    }
    // Write idempotency row inside the same SQLite transaction so a
    // crash between contribution commit and idempotency store write
    // cannot leave an orphaned contribution without its idempotency
    // record.
    onCommit?.();
  });
  const putResult = await maybePromise;
  return { putResult: normalizePutResult(contribution, putResult), handoffIds };
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
  onCommit?: () => void,
  replyTimeouts?: ReadonlyMap<string, number> | undefined,
): Promise<ContributionWriteOutcome> {
  const putResult = normalizePutResult(contribution, await store.put(contribution));
  if (!putResult.isNew) {
    return { putResult, handoffIds: [] };
  }
  // For non-atomic stores (Nexus, in-memory), write the idempotency row
  // immediately after the contribution commit. Not fully crash-safe (the
  // contribution and idempotency row are separate writes), but the window
  // is minimal and matches the existing handoff best-effort pattern.
  try {
    onCommit?.();
  } catch (err) {
    // The contribution is already committed on the serial path. Do not let a
    // secondary idempotency write failure turn the durable write into an error:
    // the final post-commit refresh below can still update the durable row.
    console.warn(`[grove] post-commit callback failed for cid=${contribution.cid}`, err);
  }

  const handoffIds: string[] = [];
  if (handoffStore === undefined || routedTo === undefined || agentRole === undefined) {
    return { putResult, handoffIds };
  }

  const inputs: HandoffInput[] = routedTo.map((targetRole) => {
    const timeoutSec = replyTimeouts?.get(targetRole);
    return {
      sourceCid: contribution.cid,
      fromRole: agentRole,
      toRole: targetRole,
      requiresReply: timeoutSec !== undefined,
      ...(timeoutSec !== undefined
        ? { replyDueAt: new Date(Date.now() + timeoutSec * 1000).toISOString() }
        : {}),
    };
  });

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
    return { putResult, handoffIds };
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
  return { putResult, handoffIds };
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
  onCommit?: () => void,
  replyTimeouts?: ReadonlyMap<string, number> | undefined,
): Promise<ContributionWriteOutcome> {
  const needsHandoffs =
    handoffStore !== undefined &&
    routedTo !== undefined &&
    routedTo.length > 0 &&
    agentRole !== undefined;

  const cowriteStore = store as {
    putWithCowrite?: (
      c: Contribution,
      fn: () => void,
    ) => ContributionPutOutcome | Promise<ContributionPutOutcome>;
  };

  if (needsHandoffs) {
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
        onCommit,
        replyTimeouts,
      );
    }
  }

  // Even without handoffs, use the atomic path when onCommit is provided
  // and the store supports cowrite — this ensures the idempotency row is
  // written inside the same SQLite transaction as the contribution.
  if (onCommit !== undefined && cowriteStore.putWithCowrite !== undefined) {
    return writeAtomic(
      contribution,
      [],
      agentRole ?? "",
      cowriteStore.putWithCowrite.bind(cowriteStore),
      () => "", // no-op insertSync (no handoffs)
      onCommit,
    );
  }

  return writeSerial(
    contribution,
    routedTo,
    agentRole,
    store,
    handoffStore,
    onCommit,
    replyTimeouts,
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Per-CID in-flight write tracker. Concurrent same-CID submits must serialize
 * here so the second-arriving call observes the first's commit when it does
 * its existedBefore check. Without this, two racing identical submits would
 * both see the row absent, both fire onEntityWrite, and the watch RV would
 * advance by 2 for a logical single-insert (#292 round 5).
 */
const inFlightContributionWrites = new Map<string, Promise<void>>();

/** Create and store a contribution. */
export async function contributeOperation(
  input: ContributeInput,
  deps: OperationDeps,
): Promise<OperationResult<ContributeResult>> {
  // Hoisted out of the try block so the outer catch can release the slot
  // and roll back the durable reservation on thrown errors.
  let idempotencySlot:
    | {
        readonly resolve: (result: OperationResult<ContributeResult>) => void;
        readonly release: () => void;
      }
    | undefined;
  let idempotencyCacheLookupKey: string | undefined;
  // Track whether THIS call actually acquired the durable reservation.
  // Without this, a pre-commit throw here would rollback whatever pending
  // row is in the store, including one another process reserved in the
  // meantime — erasing its single-flight protection and enabling dup writes.
  let ownsDurableReservation = false;
  const rollbackOwnedDurableReservation = (): void => {
    if (
      ownsDurableReservation &&
      idempotencyCacheLookupKey !== undefined &&
      deps.idempotencyStore !== undefined
    ) {
      try {
        deps.idempotencyStore.rollback(idempotencyCacheLookupKey);
      } catch {
        // Best-effort — don't mask the original error.
      }
      ownsDurableReservation = false;
    }
  };

  try {
    if (deps.contributionStore === undefined) {
      return validationErr("Contribution operations not available (missing contributionStore)");
    }

    const artifacts = input.artifacts ?? {};
    const relations = input.relations ?? [];
    const tags = input.tags ?? [];

    const agent = resolveAgent(input.agent);
    const mode = resolveMode(input.mode, deps);
    // Normalize to UTC Z-format so lexicographic ORDER BY works without datetime().
    const createdAt = toUtcIso(input.createdAt ?? new Date().toISOString());

    // --- Idempotency: synchronous check-then-reserve + durable lookup ---
    //
    // Sequence matters:
    //   1. Synchronously (no await): in-memory cache lookup + slot reserve.
    //      This single-threaded pair guarantees two concurrent in-process
    //      callers cannot both observe a miss and both proceed — the
    //      second caller will see the first's pending Promise. Must
    //      happen BEFORE any awaited validateRelations to preserve
    //      single-flight (#258 round 3).
    //   2. Await durable store lookup — a hit means another process
    //      already wrote this key; short-circuit (and resolve our
    //      just-reserved slot with the cached result so concurrent
    //      in-process callers see it too).
    //   3. validateRelations / validateArtifacts — on failure, resolve
    //      the slot with the error so it's freed for retries.
    //   4. Durable reserve for cross-process single-flight — only on
    //      cache miss.
    const idempotencyAgentScope = agent.role ?? agent.agentId;
    idempotencyCacheLookupKey =
      input.idempotencyKey !== undefined
        ? idempotencyCacheKey(idempotencyAgentScope, input.idempotencyKey)
        : undefined;
    let idempotencyFingerprint: string | undefined;
    if (idempotencyCacheLookupKey !== undefined) {
      idempotencyFingerprint = computeIdempotencyFingerprint(input, agent);
      // Sync check-then-reserve — no await between.
      const cached = lookupIdempotency(
        idempotencyCacheLookupKey,
        idempotencyFingerprint,
        Date.now(),
      );
      if (cached !== undefined) {
        if (cached.type === "pending") return cached.promise;
        if (cached.type === "value") return ok(cached.result);
        return err({
          code: OperationErrorCode.StateConflict,
          message: cached.message,
          details: { idempotencyKey: input.idempotencyKey },
        });
      }
      idempotencySlot = reserveIdempotencySlot(
        idempotencyCacheLookupKey,
        idempotencyFingerprint,
        Date.now(),
      );
    }

    // Cross-process durable lookup — only on in-memory miss. If another
    // process already committed this key, resolve our slot with the
    // cached result so concurrent in-process callers see it too.
    if (
      idempotencyCacheLookupKey !== undefined &&
      idempotencyFingerprint !== undefined &&
      deps.idempotencyStore !== undefined
    ) {
      const persisted = deps.idempotencyStore.lookup(idempotencyCacheLookupKey, IDEMPOTENCY_TTL_MS);
      if (persisted !== undefined) {
        if (persisted.fingerprint !== idempotencyFingerprint) {
          const conflictErr = err({
            code: OperationErrorCode.StateConflict,
            message:
              "Idempotency key was previously used with a different request body. " +
              "Reusing the same key with different input is rejected to prevent silent " +
              "write divergence. Use a new key for the new intent.",
            details: { idempotencyKey: input.idempotencyKey },
          });
          idempotencySlot?.resolve(conflictErr);
          idempotencySlot = undefined;
          return conflictErr;
        }
        if (persisted.status === "committed") {
          const cachedResult = JSON.parse(persisted.resultJson) as ContributeResult;
          const okResult = ok(cachedResult);
          idempotencySlot?.resolve(okResult);
          idempotencySlot = undefined;
          return okResult;
        }
        const pendingErr = err({
          code: OperationErrorCode.StateConflict,
          message:
            "Idempotency key is currently being processed by another request. " +
            "Retry after a short delay.",
          details: { idempotencyKey: input.idempotencyKey, retryable: true },
        });
        idempotencySlot?.resolve(pendingErr);
        idempotencySlot = undefined;
        return pendingErr;
      }
    }

    // Validate relations (now includes per-relation kind checks via
    // RELATION_EXPECTED_KINDS). Failures release the slot so retries
    // with corrected input can proceed.
    if (relations.length > 0) {
      const relErr = await validateRelations(deps.contributionStore, relations);
      if (relErr !== undefined) {
        idempotencySlot?.resolve(relErr as OperationResult<ContributeResult>);
        idempotencySlot = undefined;
        return relErr as OperationResult<ContributeResult>;
      }
    }

    // Validate artifacts whenever provided (regardless of commitHash)
    if (Object.keys(artifacts).length > 0) {
      const artErr = await validateArtifacts(deps, artifacts);
      if (artErr !== undefined) {
        idempotencySlot?.resolve(artErr as OperationResult<ContributeResult>);
        idempotencySlot = undefined;
        return artErr as OperationResult<ContributeResult>;
      }
    }

    // --- Ephemeral flag is reserved for discussions ---
    // context.ephemeral=true is a routing/frontier skip signal intended for
    // chat messages and grove_done session terminators, both of which are
    // kind=discussion. Reject this before durable idempotency reservation so
    // corrected retries can reuse the key after this permanent validation error.
    if (input.kind !== CK.Discussion && input.context?.ephemeral === true) {
      const errResult = validationErr(
        `context.ephemeral=true is only valid on kind=discussion contributions ` +
          `(chat messages and session terminators). Got kind='${input.kind}'. ` +
          `The ephemeral flag suppresses topology routing, handoff creation, and ` +
          `frontier inclusion — setting it on progress contributions would make them invisible.`,
      );
      idempotencySlot?.resolve(errResult);
      idempotencySlot = undefined;
      return errResult;
    }

    // Cross-process durable reserve — losing the race means another
    // process already started the write; return retryable conflict.
    if (
      idempotencyCacheLookupKey !== undefined &&
      idempotencyFingerprint !== undefined &&
      deps.idempotencyStore !== undefined
    ) {
      const reserved = deps.idempotencyStore.reserve(
        idempotencyCacheLookupKey,
        idempotencyFingerprint,
      );
      if (!reserved) {
        const raceErr = err({
          code: OperationErrorCode.StateConflict,
          message:
            "Idempotency key is currently being processed by another request. " +
            "Retry after a short delay.",
          details: { idempotencyKey: input.idempotencyKey, retryable: true },
        });
        idempotencySlot?.resolve(raceErr);
        idempotencySlot = undefined;
        return raceErr;
      }
      ownsDurableReservation = true;
    }

    const unsignedContributionInput: ContributionInput = {
      kind: input.kind,
      mode,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      artifacts,
      ...(input.commitHash !== undefined ? { commitHash: input.commitHash } : {}),
      relations,
      ...(input.scores !== undefined ? { scores: input.scores } : {}),
      tags: [...tags],
      ...(input.context !== undefined ? { context: input.context } : {}),
      agent,
      createdAt,
    };
    const contributionInput = withRuntimeRoutingSignature(unsignedContributionInput);

    const contribution = createContribution(contributionInput);

    const returnDuplicate = (
      storedContribution: Contribution,
    ): OperationResult<ContributeResult> => {
      const duplicateResult = resultFromContribution(storedContribution, {
        storedCid: storedContribution.cid,
        accepted: 0,
        duplicate: 1,
      });
      const duplicateOk = ok(duplicateResult);
      idempotencySlot?.resolve(duplicateOk);
      idempotencySlot = undefined;
      if (
        deps.idempotencyStore !== undefined &&
        idempotencyCacheLookupKey !== undefined &&
        idempotencyFingerprint !== undefined
      ) {
        try {
          deps.idempotencyStore.store(
            idempotencyCacheLookupKey,
            idempotencyFingerprint,
            JSON.stringify(duplicateResult),
          );
        } catch {
          // Best-effort; the store-level content hash already prevents duplicates.
        }
      }
      return duplicateOk;
    };

    const existingDuplicate = await findStoredDuplicateByContentHash(
      deps.contributionStore,
      contribution,
    );
    if (existingDuplicate !== undefined) {
      return returnDuplicate(existingDuplicate);
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
          // skipExpensiveStopChecks: true — scanning stop evaluators (quorum,
          // deliberation) run in the post-write recheck below, outside the
          // mutex, so they don't block concurrent writers (#232). This opt-in
          // is ONLY for the mutex-hook path — the fallback branch below uses
          // the default full evaluation since it isn't holding the mutex.
          policyResult = await enforcer?.enforce(c, true, {
            skipStopConditions,
            skipExpensiveStopChecks: true,
          });
        });
      } else {
        // Fallback: enforce outside mutex (non-EnforcingContributionStore).
        // Not the write-mutex hot path that motivated skipExpensiveStopChecks,
        // so keep full evaluation — the post-write recheck is best-effort and
        // should not be the sole detector here.
        try {
          policyResult = await enforcer.enforce(contribution, true, { skipStopConditions });
        } catch (policyErr) {
          if (policyErr instanceof PolicyViolationError) {
            const duplicate = await findStoredDuplicateByContentHash(
              deps.contributionStore,
              contribution,
            );
            if (duplicate !== undefined) return returnDuplicate(duplicate);
          }
          throw policyErr;
        }
      }
    }

    // --- Pre-write: determine routing targets synchronously (no I/O) ---
    let routedTo: readonly string[] | undefined;
    // Map target role → reply timeout seconds (from edge config). When multiple
    // edges point to the same target, the shortest timeout wins.
    let replyTimeouts: ReadonlyMap<string, number> | undefined;
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
        if (edges.length > 0) {
          routedTo = [...new Set(edges.map((e) => e.target))];
          // Collect reply timeouts from edges — shortest timeout per target wins
          const timeoutMap = new Map<string, number>();
          for (const edge of edges) {
            if (edge.replyTimeoutSeconds !== undefined) {
              const existing = timeoutMap.get(edge.target);
              if (existing === undefined || edge.replyTimeoutSeconds < existing) {
                timeoutMap.set(edge.target, edge.replyTimeoutSeconds);
              }
            }
          }
          if (timeoutMap.size > 0) replyTimeouts = timeoutMap;
        }
        if (process.env.GROVE_DEBUG === "1") {
          const timeoutInfo = replyTimeouts
            ? [...replyTimeouts.entries()].map(([r, t]) => `${r}=${t}s`).join(", ")
            : "none";
          process.stderr.write(
            `[grove:handoff] ROUTE role=${contribution.agent.role} targets=[${routedTo?.join(",")}] deadlines={${timeoutInfo}}\n`,
          );
        }
      }
    }

    // --- Write: contribution + handoffs (atomic when supported, serial otherwise) ---
    // Plans + ephemeral messages skip handoff creation entirely by passing
    // undefined as the routing-target list to the writer.
    const agentRole = contribution.agent.role;
    const handoffsRoutedTo = skipHandoffs ? undefined : routedTo;
    // Build onCommit callback for atomic idempotency-store write.
    // Runs inside the SQLite transaction (atomic path) or immediately
    // after store.put() (serial path), closing the crash window between
    // contribution commit and idempotency record.
    const idempotencyOnCommit =
      deps.idempotencyStore !== undefined &&
      idempotencyCacheLookupKey !== undefined &&
      idempotencyFingerprint !== undefined
        ? () => {
            // Build a minimal result from the contribution (routedTo and
            // handoffIds are populated later, but the CID is the critical
            // dedup signal — retries just need to know the write happened).
            const earlyResult = resultFromContribution(contribution, {
              accepted: 1,
              duplicate: 0,
            });
            // Guarded above by idempotencyCacheLookupKey/idempotencyFingerprint
            // both being defined — non-null assertions here are safe.
            const key = idempotencyCacheLookupKey as string;
            const fingerprint = idempotencyFingerprint as string;
            deps.idempotencyStore?.store(key, fingerprint, JSON.stringify(earlyResult));
          }
        : undefined;

    // Watch fan-out must fire only for true inserts (#292). The store uses
    // INSERT OR IGNORE for idempotency, so a duplicate-CID submit is a
    // no-op in storage — emitting ADDED for it would advance the watch RV
    // with a phantom event.
    //
    // Concurrent same-CID submits are serialized through
    // `inFlightContributionWrites`: the second-arriving caller waits on
    // the first's write promise, so its `existedBefore` check observes
    // the prior commit and skips its own ADDED. Without this, two racing
    // identical submits would both see `existedBefore=false` and the
    // watch RV would advance by 2 for a logical single insert.
    const cidKey = contribution.cid;
    const priorInFlight = inFlightContributionWrites.get(cidKey);
    if (priorInFlight !== undefined) {
      await priorInFlight;
    }

    // Promise constructor runs the executor synchronously, so the
    // definite-assignment assertion is safe and avoids the empty-arrow
    // dummy initializer (lint/suspicious/noEmptyBlockStatements).
    let resolveInFlight!: () => void;
    const inFlightPromise = new Promise<void>((r) => {
      resolveInFlight = r;
    });
    inFlightContributionWrites.set(cidKey, inFlightPromise);

    let existedBefore = false;
    let writeOutcome: ContributionWriteOutcome | undefined;
    try {
      existedBefore = (await deps.contributionStore.get(cidKey)) !== undefined;

      writeOutcome = await writeContributionWithHandoffs(
        contribution,
        handoffsRoutedTo,
        agentRole,
        deps.contributionStore,
        deps.handoffStore,
        idempotencyOnCommit,
        replyTimeouts,
      );
    } catch (writeErr) {
      if (writeErr instanceof PolicyViolationError) {
        const duplicate = await findStoredDuplicateByContentHash(
          deps.contributionStore,
          contribution,
        );
        if (duplicate !== undefined) return returnDuplicate(duplicate);
      }
      throw writeErr;
    } finally {
      // Release the lock as soon as the durable write resolves — the next
      // waiter must observe the row in `get()`. Post-commit callbacks run
      // outside the lock; they don't change store visibility.
      if (inFlightContributionWrites.get(cidKey) === inFlightPromise) {
        inFlightContributionWrites.delete(cidKey);
      }
      resolveInFlight();
    }

    if (writeOutcome === undefined) {
      throw new Error("contribution write did not produce an outcome");
    }
    const { handoffIds, putResult } = writeOutcome;

    if (!putResult.isNew) {
      const storedContribution = putResult.contribution ?? contribution;
      return returnDuplicate({ ...storedContribution, cid: putResult.cid });
    }

    if (process.env.GROVE_DEBUG === "1" && handoffIds.length > 0) {
      process.stderr.write(
        `[grove:handoff] CREATED cid=${contribution.cid.slice(0, 20)}.. handoffIds=[${handoffIds.map((h) => h.slice(0, 8)).join(",")}] targets=[${handoffsRoutedTo?.join(",") ?? ""}]\n`,
      );
    }

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
    const committedResult = resultFromContribution(contribution, {
      accepted: 1,
      duplicate: 0,
      routedTo,
      handoffIds,
      policy: policyResult,
    });

    if (idempotencySlot !== undefined) {
      idempotencySlot.resolve(ok(committedResult));
      // Clear the local reference so the outer catch(error) handler can't
      // release the slot for a post-commit failure. The contribution is
      // durably written; retries with the same key must return this cached
      // result, NOT re-run the write path.
      idempotencySlot = undefined;

      // Update the durable idempotency row with the full result (includes
      // routedTo, handoffIds, policy which weren't available at commit time).
      // This is an UPDATE, not an INSERT — the row was created atomically
      // with the contribution inside the write transaction.
      if (
        deps.idempotencyStore !== undefined &&
        idempotencyCacheLookupKey !== undefined &&
        idempotencyFingerprint !== undefined
      ) {
        try {
          deps.idempotencyStore.store(
            idempotencyCacheLookupKey,
            idempotencyFingerprint,
            JSON.stringify(committedResult),
          );
        } catch {
          // The early result from onCommit is sufficient for dedup.
        }
      }
    }

    // Post-write callbacks — wrapped so a throw cannot escape and undo
    // the commit from the caller's perspective.
    try {
      deps.onContributionWrite?.();
      deps.onContributionWritten?.(contribution.cid);
      if (deps.onEntityWrite && deps.namespace && !existedBefore) {
        deps.onEntityWrite({
          kind: "Contribution",
          namespace: deps.namespace,
          op: "ADDED",
          entity: contributionToEntity(contribution, deps.namespace),
        });
      }
    } catch (callbackErr) {
      process.stderr.write(
        `[grove] Warning: post-commit callback threw after contribution commit: ${
          callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
        }\n`,
      );
    }

    // --- Post-write: register deadline timers for new handoffs ---
    if (
      deps.deadlineWatcher !== undefined &&
      handoffIds.length > 0 &&
      deps.handoffStore !== undefined
    ) {
      fireAndForget("deadline watcher registration", async () => {
        for (const hid of handoffIds) {
          try {
            const h = await deps.handoffStore?.get(hid);
            if (h?.replyDueAt !== undefined) {
              if (process.env.GROVE_DEBUG === "1") {
                process.stderr.write(
                  `[grove:handoff] WATCH handoff=${hid.slice(0, 8)} toRole=${h.toRole} replyDueAt=${h.replyDueAt}\n`,
                );
              }
              deps.deadlineWatcher?.watch(h);
            }
          } catch {
            // Best-effort — timer registration failure is non-fatal
          }
        }
      });
    }

    // --- Post-write: mark upstream handoffs as replied (fire-and-forget) ---
    // When this contribution targets another CID (reviews/responds_to), find
    // any unresolved handoffs with sourceCid = targetCid and mark them replied.
    // Query both pending_pickup and delivered — Nexus creates handoffs as
    // delivered (skipping pending_pickup) due to cross-client CAS limitations.
    if (deps.handoffStore !== undefined && contribution.relations.length > 0) {
      const replyRelations = contribution.relations.filter(
        (r) =>
          r.relationType === "reviews" ||
          r.relationType === "responds_to" ||
          r.relationType === "adopts",
      );
      if (replyRelations.length > 0) {
        // Scope reply resolution to the replying role. In fan-out topologies
        // (coder → [reviewer, tester, auditor]) one downstream response must
        // NOT close peer handoffs for others who haven't acted yet.
        //
        // REQUIRED: agent.role must be set. Role-less contributions (e.g.
        // from the unauthenticated HTTP contribution surface) CANNOT auto-
        // resolve handoffs — without a verified role, any HTTP client could
        // mark a reviewer/tester/auditor handoff replied and satisfy an SLA
        // they don't own. Such submissions leave the handoff unresolved; an
        // operator or role-bound caller must resolve it explicitly.
        const replyingRole = contribution.agent.role;
        if (replyingRole === undefined) {
          if (process.env.GROVE_DEBUG === "1") {
            process.stderr.write(
              `[grove:handoff] REPLY SKIPPED cid=${contribution.cid.slice(0, 20)}.. — role-less reply not allowed to resolve handoffs\n`,
            );
          }
        } else {
          fireAndForget("handoff reply transition", async () => {
            // Use session-scoped enumeration when the store supports it.
            // Contribution CIDs are global DAG IDs, so the same sourceCid
            // can appear in multiple sessions' handoff files. list() on
            // Nexus scans zone-wide; resolving a peer session's handoff
            // from here would cross-session-mutate and fail with NotFound,
            // aborting the loop before the current session's own handoff
            // is resolved. listForCurrentSession scopes to the active
            // session; fall back to list() on backends that don't support
            // scoping (rare).
            const listFn =
              deps.handoffStore?.listForCurrentSession?.bind(deps.handoffStore) ??
              deps.handoffStore?.list.bind(deps.handoffStore);
            for (const rel of replyRelations) {
              let unresolved: readonly import("../handoff.js").Handoff[] = [];
              try {
                // Include Processed too: agents following the IPC workflow
                // (grove_process_handoff before grove_submit_*) leave the
                // handoff in Processed state.
                unresolved =
                  (await listFn?.({
                    sourceCid: rel.targetCid,
                    status: [
                      HandoffStatus.PendingPickup,
                      HandoffStatus.Delivered,
                      HandoffStatus.Processed,
                    ],
                    toRole: replyingRole,
                  })) ?? [];
              } catch {
                // List failure is best-effort; move on to next relation.
                continue;
              }
              // Per-handoff error isolation: one foreign or stale row
              // must not abort resolution of the remaining handoffs.
              for (const h of unresolved) {
                try {
                  if (process.env.GROVE_DEBUG === "1") {
                    process.stderr.write(
                      `[grove:handoff] REPLY handoff=${h.handoffId.slice(0, 8)} resolvedBy=${contribution.cid.slice(0, 20)}.. relation=${rel.relationType} role=${replyingRole}\n`,
                    );
                  }
                  if (h.status === HandoffStatus.PendingPickup) {
                    try {
                      await deps.handoffStore?.markDelivered(h.handoffId);
                    } catch {
                      /* status may have advanced concurrently */
                    }
                  }
                  await deps.handoffStore?.markReplied(h.handoffId, contribution.cid);
                  deps.deadlineWatcher?.cancel(h.handoffId);
                } catch {
                  /* skip this handoff, continue with peers */
                }
              }
            }
          });
        }
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
      fireAndForget("topology routing", async () => {
        const routeResults = await deps.topologyRouter?.route(agentRole, {
          cid: contribution.cid,
          kind: contribution.kind,
          summary: contribution.summary,
          agentId: contribution.agent.agentId,
        });

        // Link IPC message IDs back to handoff records and dead-letter
        // handoffs whose IPC delivery failed (best-effort).
        if (routeResults && deps.handoffStore && handoffIds.length > 0) {
          const handoffs = await deps.handoffStore.list({
            sourceCid: contribution.cid,
          });
          for (const result of routeResults) {
            const matching = handoffs.find((h) => h.toRole === result.targetRole);
            if (!matching) continue;
            try {
              if (result.ok && result.messageId) {
                // IPC succeeded — store the message ID for SSE delivery tracking
                await deps.handoffStore.setIpcMessageId?.(matching.handoffId, result.messageId);
              } else if (!result.ok && !result.infrastructureError) {
                // IPC delivery was rejected by the service (not an infra issue
                // like 404/connection refused). Dead-letter the handoff so
                // operators can see the gap.
                await deps.handoffStore.markDeadLettered(matching.handoffId);
                process.stderr.write(
                  `[grove] handoff ${matching.handoffId} dead-lettered: IPC to ${result.targetRole} failed: ${result.error ?? "unknown"}\n`,
                );
              }
              // When !result.ok && result.infrastructureError: IPC endpoint
              // is unavailable (404, connection refused). The handoff stays
              // in its current status — it was never attempted, not rejected.
              // Delivery falls back to the session orchestrator's polling path.
            } catch (bookkeepingErr) {
              // Best-effort — handoff record is the primary artifact.
              // Log so operators can diagnose missing ipcMessageId or
              // un-dead-lettered handoffs.
              console.warn(
                `[grove] handoff IPC bookkeeping failed for ${matching.handoffId} → ${result.targetRole}:`,
                bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr),
              );
            }
          }
        }
      });
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
      // Bounded retry with exponential backoff — addresses Codex review r3:
      // the scanning stop evaluators are the ONLY detector for
      // quorum/deliberation on the mutex-hook path, so a transient
      // store read failure must not silently drop a stop signal.
      // 3 attempts × (100ms, 400ms) backoff caps at ~500ms added latency
      // in the worst case; success on attempt 1 adds zero latency.
      const { evaluateStopConditions } = await import("../stop-conditions.js");
      const POST_WRITE_RECHECK_ATTEMPTS = 3;
      let attempt = 0;
      let lastError: unknown;
      while (attempt < POST_WRITE_RECHECK_ATTEMPTS) {
        try {
          const postWriteResult = await evaluateStopConditions(
            deps.contract,
            deps.contributionStore,
          );
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
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          attempt += 1;
          if (attempt < POST_WRITE_RECHECK_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 100 * 4 ** (attempt - 1)));
          }
        }
      }
      if (lastError !== undefined) {
        // All attempts exhausted. The contribution is already committed, so we
        // cannot undo the write. Surface the degradation explicitly via
        // `stopResult.degraded = true` so callers can distinguish "confirmed
        // not stopped" from "unknown — evaluation failed". The boolean
        // `stopped` field stays the cheap-evaluator result (the only source
        // we successfully computed). The `degraded` flag + warning are the
        // signal operators must monitor. This addresses Codex review r4/r5
        // findings on fail-open behavior under sustained store read failures.
        const degradedReason = `stop_recheck_unavailable: post-write recheck failed after ${POST_WRITE_RECHECK_ATTEMPTS} attempts — quorum/deliberation stop detection temporarily degraded; treat stopped=false as unverified until next successful recheck`;
        policyResult = {
          ...policyResult,
          stopResult: {
            stopped: policyResult.stopResult?.stopped === true,
            reason: policyResult.stopResult?.reason ?? degradedReason,
            degraded: true,
          },
        };
        process.stderr.write(
          `[grove] Warning: post-write stop-condition recheck failed after ${POST_WRITE_RECHECK_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}\n`,
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
    // detecting a threshold crossing).
    const result = resultFromContribution(contribution, {
      accepted: 1,
      duplicate: 0,
      routedTo,
      handoffIds,
      policy: policyResult,
    });

    // Refresh BOTH the in-memory idempotency cache AND the durable row with
    // the final result so same-process retries and cross-process lookups
    // return the same payload as the direct caller. Without this, the
    // committedResult snapshot (pre-recheck) would persist in the in-memory
    // cache for up to IDEMPOTENCY_TTL_MS, and same-process retries would see
    // stopped=false while the direct caller saw stopped=true. See Codex
    // findings on #312 rounds 2–3.
    //
    // In-flight concurrent retries that already awaited the in-memory slot's
    // pending promise still receive committedResult — that's a pre-existing
    // narrow window documented at the DURABLE COMMIT BOUNDARY. New retries
    // (key lookup after the slot resolves) get the final result.
    if (idempotencyCacheLookupKey !== undefined && idempotencyFingerprint !== undefined) {
      const existing = idempotencyCache.get(idempotencyCacheLookupKey);
      if (existing !== undefined && existing.fingerprint === idempotencyFingerprint) {
        idempotencyCache.set(idempotencyCacheLookupKey, {
          fingerprint: idempotencyFingerprint,
          storedAt: existing.storedAt,
          value: result,
        });
      }
      if (deps.idempotencyStore !== undefined) {
        // Bounded retry with warning on final durable refresh failure.
        // Addresses Codex review r4 finding: a silent drop here leaves
        // cross-process retries reading the stale committedResult for the
        // full TTL. Same 3-attempt pattern used for post-write recheck.
        const IDEMPOTENCY_REFRESH_ATTEMPTS = 3;
        let refreshAttempt = 0;
        let refreshError: unknown;
        while (refreshAttempt < IDEMPOTENCY_REFRESH_ATTEMPTS) {
          try {
            deps.idempotencyStore.store(
              idempotencyCacheLookupKey,
              idempotencyFingerprint,
              JSON.stringify(result),
            );
            refreshError = undefined;
            break;
          } catch (err) {
            refreshError = err;
            refreshAttempt += 1;
            if (refreshAttempt < IDEMPOTENCY_REFRESH_ATTEMPTS) {
              await new Promise((resolve) => setTimeout(resolve, 100 * 4 ** (refreshAttempt - 1)));
            }
          }
        }
        if (refreshError !== undefined) {
          process.stderr.write(
            `[grove] Warning: idempotency durable-refresh failed after ${IDEMPOTENCY_REFRESH_ATTEMPTS} attempts (cross-process retries may observe stale policy for key=${idempotencyCacheLookupKey}): ${refreshError instanceof Error ? refreshError.message : String(refreshError)}\n`,
          );
        }
      }
    }

    return ok(result);
  } catch (error) {
    // Resolve the idempotency slot with the failure result — NOT just
    // release(). A release only deletes the cache entry; any concurrent
    // same-key caller that already grabbed the pending promise would
    // hang forever because the resolver was never called. resolve()
    // both fires the waiter's promise with this error AND clears the
    // slot (see reserveIdempotencySlot.resolve — error results delete
    // the entry so retries can proceed).
    //
    // This catch only runs for pre-commit throws (validation, policy,
    // store write). Post-commit failures flow through the committed
    // result path and never reach here.
    const errResult = fromGroveError(error);
    idempotencySlot?.resolve(errResult);
    // Roll back the durable reservation — but only if THIS call placed
    // the pending row. Otherwise a pre-commit throw here would delete a
    // row another process (or a concurrent same-process retry) just
    // reserved, defeating cross-process single-flight.
    rollbackOwnedDurableReservation();
    return errResult;
  }
}

/**
 * Submit a review of an existing contribution.
 * Sugar over contributeOperation: sets kind=review, adds reviews relation.
 *
 * Verifies the target resolves AND is a 'work' contribution before creating
 * the review. Doing the kind check here (instead of relying on
 * validateRelations alone) gives a clear 'wrong kind' error and prevents
 * constructing a review that points at a plan / discussion / response. See
 * #236 — mirrors the pattern from updatePlanOperation (#228 Issue 6A).
 */
export async function reviewOperation(
  input: ReviewInput,
  deps: OperationDeps,
): Promise<OperationResult<ReviewResult>> {
  // Kind check happens inside contributeOperation via validateRelations —
  // see RELATION_EXPECTED_KINDS[Reviews]. Keeping it in-band preserves the
  // no-throw contract AND keeps the wrapper out of the idempotency path so
  // retries with the same idempotencyKey still hit the cache when the first
  // write succeeded (closes #236 + round-2 review).
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
      ...pickDefined(input, ["description", "scores", "context", "idempotencyKey"]),
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
    accepted: result.value.accepted,
    duplicate: result.value.duplicate,
  });
}

/**
 * Submit a reproduction attempt of an existing contribution.
 * Sugar over contributeOperation: sets kind=reproduction, adds reproduces relation.
 *
 * Verifies the target resolves AND is a 'work' contribution before creating
 * the reproduction. See #236 — mirrors reviewOperation / updatePlanOperation.
 */
export async function reproduceOperation(
  input: ReproduceInput,
  deps: OperationDeps,
): Promise<OperationResult<ReproduceResult>> {
  // Kind check happens inside contributeOperation via validateRelations —
  // see RELATION_EXPECTED_KINDS[Reproduces]. See reviewOperation for the
  // idempotency-retry rationale.
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
      ...pickDefined(input, ["description", "scores", "context", "idempotencyKey"]),
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
    accepted: result.value.accepted,
    duplicate: result.value.duplicate,
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
      ...pickDefined(input, ["description", "context", "idempotencyKey"]),
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
    accepted: result.value.accepted,
    duplicate: result.value.duplicate,
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
      ...pickDefined(input, ["description", "context", "idempotencyKey"]),
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
    accepted: result.value.accepted,
    duplicate: result.value.duplicate,
  });
}
