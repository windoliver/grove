/**
 * Nexus-backed ClaimStore adapter.
 *
 * Stores claims as JSON files in the Nexus VFS with ETag-based
 * optimistic concurrency for safe distributed updates.
 *
 * Storage layout:
 * - Claims:        /zones/{zoneId}/claims/{claimId}.json
 * - Active index:  /zones/{zoneId}/indexes/claims/active/{targetRef}/{claimId}
 */

import {
  computeLeaseDuration,
  DEFAULT_LEASE_DURATION_MS,
  resolveClaimOrRenew,
  validateClaimContext,
  validateHeartbeat,
  validateTransition,
} from "../core/claim-logic.js";
import type { ClaimEntity } from "../core/entity.js";
import { claimToEntity } from "../core/entity.js";
import { StateConflictError } from "../core/errors.js";
import { type OwnerRef, ownerRefsEqual } from "../core/lifecycle-metadata.js";
import type { Claim, ClaimStatus } from "../core/models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStore,
  ExpiredClaim,
  ExpireStaleOptions,
} from "../core/store.js";
import { ExpiryReason } from "../core/store.js";
import { toUtcIso } from "../core/time.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { batchParallel } from "./batch.js";
import type { NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { NexusConflictError } from "./errors.js";
import { listAllPages } from "./list-pages.js";
import { LruCache } from "./lru-cache.js";
import type { NexusWatchPublisher } from "./nexus-watch-publisher.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  activeClaimIndexPath,
  activeClaimsDir,
  activeClaimTargetDir,
  claimPath,
  claimsDir,
  decodeSegment,
  targetLockPath,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeClaim(claim: Claim): Uint8Array {
  return encoder.encode(JSON.stringify(claim));
}

function decodeClaim(data: Uint8Array): Claim {
  return JSON.parse(decoder.decode(data)) as Claim;
}

/** A claim bundled with its VFS ETag for CAS writes. */
interface ClaimWithEtag {
  readonly claim: Claim;
  readonly etag: string;
}

/**
 * Nexus-backed ClaimStore.
 */
export class NexusClaimStore implements ClaimStore {
  readonly storeIdentity: string;
  private readonly client: NexusClient;
  private readonly config: ResolvedNexusConfig;
  private readonly semaphore: Semaphore;
  private readonly zoneId: string;
  private readonly claimCache: LruCache<Claim>;
  private readonly watchPublisher: NexusWatchPublisher | undefined;
  /** Cached activeClaims result with TTL. */
  private activeClaimsCache:
    | { readonly claims: readonly Claim[]; readonly expiresAt: number }
    | undefined;
  private static readonly ACTIVE_CLAIMS_TTL_MS = 2_500;

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.watchPublisher = this.config.watchPublisher;
    this.storeIdentity = `nexus:${this.zoneId}:claims`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
    this.claimCache = new LruCache(this.config.cacheMaxEntries);
  }

  /** Publish a watch fan-out envelope (#292). No-op when publisher not configured. */
  private publishWatch(claim: Claim, op: "ADDED" | "MODIFIED" | "DELETED"): void {
    if (!this.watchPublisher) return;
    // Generation tracks per-row revision (1-based). Same field used by
    // claimToEntity to populate metadata.generation, so subscriber dedupe
    // keys agree across processes.
    const generation = claim.revision ?? 1;
    // Include the entity snapshot for DELETED — the row is removed before
    // (or alongside) publish, so subscribers can't fetchEntity. Including
    // it for ADDED/MODIFIED is also a free latency win.
    const entity: ClaimEntity = claimToEntity(claim, () => Date.now(), this.zoneId);
    void this.watchPublisher.publish({
      kind: "Claim",
      namespace: this.zoneId,
      op,
      entityId: claim.claimId,
      generation,
      emittedAt: new Date().toISOString(),
      entity,
    });
  }

  /** Invalidate the activeClaims cache (called on mutations). */
  private invalidateActiveClaimsCache(): void {
    this.activeClaimsCache = undefined;
  }

  async createClaim(claim: Claim): Promise<Claim> {
    validateClaimContext(claim);

    // Check for duplicate claimId via conditional write (ifNoneMatch="*")
    // This is race-safe: the write will fail if the file already exists.
    const createdClaim: Claim = {
      ...claim,
      createdAt: toUtcIso(claim.createdAt),
      heartbeatAt: toUtcIso(claim.heartbeatAt),
      leaseExpiresAt: toUtcIso(claim.leaseExpiresAt),
      revision: 1,
    };

    try {
      await this.writeClaimConditional(createdClaim, { ifNoneMatch: "*" });
    } catch (err) {
      if (err instanceof NexusConflictError) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
        });
      }
      throw err;
    }

    // Acquire target lock + write active index. The lock uses ifNoneMatch="*"
    // to atomically enforce one-active-per-target. If it fails, roll back.
    try {
      await this.writeActiveIndexExclusive(createdClaim);
    } catch (err) {
      // Roll back the claim file — the lock is the gate.
      await safeCleanup(
        withSemaphore(this.semaphore, () =>
          this.client.delete(claimPath(this.zoneId, claim.claimId)),
        ),
        "rollback claim file after index failure",
        { silent: true },
      );
      if (err instanceof NexusConflictError) {
        // Another claim already active on this target — find it for error message
        const now = new Date();
        const activeOnTarget = await this.findActiveOnTarget(claim.targetRef, now);
        const existingId = activeOnTarget?.claimId ?? "(unknown)";
        throw new StateConflictError({
          resource: "Claim",
          reason: "target already has an active claim",
          message: `Target '${claim.targetRef}' already has an active claim '${existingId}'`,
        });
      }
      throw err;
    }

    this.claimCache.set(createdClaim.claimId, createdClaim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(createdClaim, "ADDED");
    return createdClaim;
  }

  async claimOrRenew(claim: Claim): Promise<Claim> {
    validateClaimContext(claim);

    const now = new Date();
    const nowIso = now.toISOString();
    const activeOnTarget = await this.findActiveOnTarget(claim.targetRef, now);

    const resolution = resolveClaimOrRenew(
      activeOnTarget !== undefined
        ? { claimId: activeOnTarget.claimId, agentId: activeOnTarget.agent.agentId }
        : undefined,
      claim.agent.agentId,
      claim.targetRef,
    );

    if (resolution.action === "renew" && activeOnTarget !== undefined) {
      // Re-read with ETag for CAS write
      const withEtag = await this.readClaimWithEtag(activeOnTarget.claimId);
      const existing = withEtag?.claim ?? activeOnTarget;
      const etag = withEtag?.etag;
      const durationMs = computeLeaseDuration(claim);
      const renewed: Claim = {
        ...existing,
        heartbeatAt: nowIso,
        leaseExpiresAt: new Date(now.getTime() + durationMs).toISOString(),
        intentSummary: claim.intentSummary,
        revision: (existing.revision ?? 0) + 1,
      };
      if (etag !== undefined) {
        await this.writeClaimCas(renewed, etag);
      } else {
        await this.writeClaim(renewed);
      }
      this.claimCache.set(renewed.claimId, renewed);
      this.invalidateActiveClaimsCache();
      // Renewals advance heartbeatAt/leaseExpiresAt — fields Claim
      // watchers depend on to reason about lease state. Emit MODIFIED
      // even though status stays "active": suppressing would let a
      // watcher conclude an actively-renewed claim has expired.
      this.publishWatch(renewed, "MODIFIED");
      return renewed;
    }

    // Create new claim — use conditional write for race safety
    const createdClaim: Claim = {
      ...claim,
      createdAt: toUtcIso(claim.createdAt),
      heartbeatAt: toUtcIso(claim.heartbeatAt),
      leaseExpiresAt: toUtcIso(claim.leaseExpiresAt),
      revision: 1,
    };

    try {
      await this.writeClaimConditional(createdClaim, { ifNoneMatch: "*" });
    } catch (err) {
      if (err instanceof NexusConflictError) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
        });
      }
      throw err;
    }

    // Write active index — roll back claim on failure
    try {
      await this.writeActiveIndexExclusive(createdClaim);
    } catch (err) {
      await safeCleanup(
        withSemaphore(this.semaphore, () =>
          this.client.delete(claimPath(this.zoneId, claim.claimId)),
        ),
        "rollback claim file after claimOrRenew index failure",
        { silent: true },
      );
      throw err;
    }

    this.claimCache.set(createdClaim.claimId, createdClaim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(createdClaim, "ADDED");
    return createdClaim;
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.readClaim(claimId);
  }

  async heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    const result = await this.readClaimWithEtag(claimId);
    validateHeartbeat(result?.claim, claimId);
    const { claim: validClaim, etag } = result as ClaimWithEtag;

    // Lock-ownership fence: if the target lock no longer points to
    // this claim, a takeover has already superseded us. Renewing the
    // lease would resurrect a zombie active claim that no longer
    // controls its target.
    await this.assertLockOwned(validClaim.targetRef, claimId);

    const now = new Date();
    const duration = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    const updated: Claim = {
      ...validClaim,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + duration).toISOString(),
      revision: (validClaim.revision ?? 0) + 1,
    };

    await this.writeClaimCas(updated, etag);
    this.claimCache.set(updated.claimId, updated);
    this.invalidateActiveClaimsCache();
    // Heartbeats advance heartbeatAt/leaseExpiresAt and watchers depend
    // on those fields for lease-aware decisions. Same rationale as the
    // renew path — emit MODIFIED rather than risk stale-lease bugs.
    this.publishWatch(updated, "MODIFIED");
    return updated;
  }

  /**
   * Verify that the target lock for this claim still points to us.
   * Called by heartbeat and terminal transitions as a last-mile fence
   * against takeovers that rewrite the lock without mutating the old
   * claim file.
   */
  private async assertLockOwned(targetRef: string, expectedClaimId: string): Promise<void> {
    const lockPath = targetLockPath(this.zoneId, targetRef);
    const lockData = await withSemaphore(this.semaphore, () => this.client.read(lockPath)).catch(
      () => undefined,
    );
    const holder = lockData !== undefined ? decoder.decode(lockData) : "";
    if (holder === expectedClaimId) return;
    throw new StateConflictError({
      resource: "Claim",
      reason: "lost target lock",
      message: `Claim '${expectedClaimId}' no longer owns target '${targetRef}' — lock ${
        holder.length === 0 ? "is unowned" : `held by '${holder}'`
      }`,
    });
  }

  async release(claimId: string): Promise<Claim> {
    return this.transitionClaim(claimId, "released" as ClaimStatus);
  }

  async complete(claimId: string): Promise<Claim> {
    return this.transitionClaim(claimId, "completed" as ClaimStatus);
  }

  async expireStale(options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> {
    const now = new Date();
    const results: ExpiredClaim[] = [];

    // List all claim files (not just active index — need to catch lease-expired)
    const allClaimsWithEtags = await this.listAllClaimsWithEtags();

    for (const { claim, etag } of allClaimsWithEtags) {
      if (claim.status !== "active") continue;

      let reason: typeof ExpiryReason.LeaseExpired | typeof ExpiryReason.Stalled | undefined;

      if (new Date(claim.leaseExpiresAt).getTime() < now.getTime()) {
        reason = ExpiryReason.LeaseExpired;
      } else if (
        options?.stallThresholdMs !== undefined &&
        new Date(claim.heartbeatAt).getTime() < now.getTime() - options.stallThresholdMs
      ) {
        reason = ExpiryReason.Stalled;
      }

      if (reason !== undefined) {
        const expired: Claim = {
          ...claim,
          status: "expired" as ClaimStatus,
          revision: (claim.revision ?? 0) + 1,
        };
        await this.writeClaimCas(expired, etag);
        await this.deleteActiveIndex(expired);
        this.claimCache.set(expired.claimId, expired);
        this.publishWatch(expired, "MODIFIED");
        results.push({ claim: expired, reason });
      }
    }

    if (results.length > 0) {
      this.invalidateActiveClaimsCache();
    }

    return results;
  }

  async activeClaims(targetRef?: string): Promise<readonly Claim[]> {
    const now = new Date();

    if (targetRef !== undefined) {
      const dir = activeClaimTargetDir(this.zoneId, targetRef);
      return this.readActiveClaimsFromDir(dir, now);
    }

    // Check TTL-based cache for all-active-claims query
    if (this.activeClaimsCache !== undefined && this.activeClaimsCache.expiresAt > Date.now()) {
      return this.activeClaimsCache.claims;
    }

    const dir = activeClaimsDir(this.zoneId);
    const entries = await listAllPages(this.client, this.semaphore, this.config, dir, {
      recursive: true,
    });

    // Parallel reads for all non-directory entries
    const claimIds = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => decodeSegment(entry.name));

    const results = await Promise.all(claimIds.map((claimId) => this.readClaim(claimId)));

    const claims: Claim[] = [];
    for (const claim of results) {
      if (claim !== undefined && claim.status === "active") {
        if (new Date(claim.leaseExpiresAt).getTime() >= now.getTime()) {
          claims.push(claim);
        }
      }
    }

    this.activeClaimsCache = {
      claims,
      expiresAt: Date.now() + NexusClaimStore.ACTIVE_CLAIMS_TTL_MS,
    };

    return claims;
  }

  async listClaims(query?: ClaimQuery): Promise<readonly Claim[]> {
    let claims = await this.listAllClaims();

    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      claims = claims.filter((c) => statuses.includes(c.status));
    }
    if (query?.agentId !== undefined) {
      claims = claims.filter((c) => c.agent.agentId === query.agentId);
    }
    if (query?.targetRef !== undefined) {
      claims = claims.filter((c) => c.targetRef === query.targetRef);
    }
    if (query?.ownerRef !== undefined) {
      claims = claims.filter((c) => ownerRefsEqual(c.ownerRef, query.ownerRef));
    }

    claims.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return claims;
  }

  async releaseOwnedBy(ownerRef: OwnerRef): Promise<number> {
    const nowIso = new Date().toISOString();
    const claims = await this.listClaims({ status: "active" as ClaimStatus, ownerRef });
    for (const claim of claims) {
      const result = await this.readClaimWithEtag(claim.claimId);
      if (result === undefined || result.claim.status !== "active") continue;

      const released: Claim = {
        ...result.claim,
        status: "released" as ClaimStatus,
        heartbeatAt: nowIso,
        revision: (result.claim.revision ?? 0) + 1,
      };
      await this.writeClaimCas(released, result.etag);
      await this.deleteActiveIndex(released);
      this.claimCache.set(released.claimId, released);
      this.publishWatch(released, "MODIFIED");
    }
    if (claims.length > 0) {
      this.invalidateActiveClaimsCache();
    }
    return claims.length;
  }

  async cleanCompleted(retentionMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const allClaims = await this.listAllClaims();

    let deleted = 0;
    for (const claim of allClaims) {
      if (["completed", "expired", "released"].includes(claim.status)) {
        if (new Date(claim.heartbeatAt).getTime() < cutoff.getTime()) {
          const path = claimPath(this.zoneId, claim.claimId);
          await withRetry(
            () => withSemaphore(this.semaphore, () => this.client.delete(path)),
            "cleanCompleted",
            this.config,
          );
          this.claimCache.delete(claim.claimId);
          // The row is gone — surface DELETED so watchers can drop their
          // local copy. Subscribers that have not yet seen this claim
          // will simply ignore the event (their fetchEntity returns
          // not-found and the subscriber logs + skips).
          this.publishWatch(claim, "DELETED");
          deleted++;
        }
      }
    }
    return deleted;
  }

  async countActiveClaims(filter?: ActiveClaimFilter): Promise<number> {
    const claims = await this.activeClaims(filter?.targetRef);
    let filtered = claims;
    if (filter?.agentId !== undefined) {
      filtered = filtered.filter((c) => c.agent.agentId === filter.agentId);
    }
    return filtered.length;
  }

  async detectStalled(stallTimeoutMs: number): Promise<readonly Claim[]> {
    const now = new Date();
    const stallCutoff = new Date(now.getTime() - stallTimeoutMs);
    const claims = await this.activeClaims();
    return claims.filter((c) => {
      return (
        new Date(c.leaseExpiresAt).getTime() >= now.getTime() &&
        new Date(c.heartbeatAt).getTime() < stallCutoff.getTime()
      );
    });
  }

  async listEntities(query?: ClaimQuery): Promise<readonly ClaimEntity[]> {
    // query.status filters on the **effective** (lease-aware) phase.
    // Fetch without status, project, then filter on projected phase so
    // an active-but-lease-past row is correctly returned as "expired"
    // and excluded from "active" queries.
    const baseQuery: ClaimQuery | undefined =
      query === undefined ? undefined : { ...query, status: undefined };
    const items = await this.listClaims(baseQuery);
    const entities = items.map((c) => claimToEntity(c, () => Date.now(), this.zoneId));
    if (query?.status === undefined) return entities;
    const wanted = Array.isArray(query.status) ? new Set(query.status) : new Set([query.status]);
    return entities.filter((e) => wanted.has(e.status.phase));
  }

  close(): void {
    // No-op — lifecycle managed by client
  }

  async deleteTerminalOwnedBy(ownerRef: OwnerRef): Promise<number> {
    const claims = await this.listClaims({
      status: ["completed", "expired", "released"] as readonly ClaimStatus[],
      ownerRef,
    });
    for (const claim of claims) {
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.delete(claimPath(this.zoneId, claim.claimId)),
          ),
        "deleteTerminalOwnedBy",
        this.config,
      );
      this.claimCache.delete(claim.claimId);
      this.publishWatch(claim, "DELETED");
    }
    if (claims.length > 0) {
      this.invalidateActiveClaimsCache();
    }
    return claims.length;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async transitionClaim(claimId: string, newStatus: ClaimStatus): Promise<Claim> {
    const result = await this.readClaimWithEtag(claimId);
    validateTransition(result?.claim, claimId, newStatus);
    const { claim: validClaim, etag } = result as ClaimWithEtag;

    // Belt-and-suspenders: re-check the lease immediately before the
    // CAS write. Between the first validate and writeClaimCas, the
    // lease may have passed and another agent may have acquired the
    // target. We cannot make the lease part of the claim-file CAS
    // (the lease and the target lock live in separate VFS nodes), but
    // a second `now` comparison narrows the race to the window between
    // this check and the RPC. If the lease has expired, we surface the
    // same StateConflictError as validateTransition so callers have a
    // single failure mode.
    validateTransition(validClaim, claimId, newStatus);

    // Lock-ownership fence: see assertLockOwned for details. The
    // takeover path in writeActiveIndexExclusive CAS-expires the
    // stale holder before rewriting the lock, so a stale caller's
    // writeClaimCas below would already fail on ETag mismatch — but
    // we belt-and-suspenders the lock check too, to catch empty-bytes
    // tombstones left by deleteActiveIndex's CAS release path.
    await this.assertLockOwned(validClaim.targetRef, claimId);

    const updated: Claim = {
      ...validClaim,
      status: newStatus,
      revision: (validClaim.revision ?? 0) + 1,
    };
    await this.writeClaimCas(updated, etag);
    if (newStatus !== "active") {
      await this.deleteActiveIndex(updated);
    }
    this.claimCache.set(updated.claimId, updated);
    this.invalidateActiveClaimsCache();
    // release / complete / expire all surface as MODIFIED — the row still
    // exists, only its phase changed. Subscribers project the new effective
    // phase via claimToEntity and route accordingly.
    this.publishWatch(updated, "MODIFIED");
    return updated;
  }

  private async readClaim(claimId: string): Promise<Claim | undefined> {
    const cached = this.claimCache.get(claimId);
    if (cached !== undefined) return cached;
    const result = await this.readClaimWithEtag(claimId);
    if (result !== undefined) {
      this.claimCache.set(claimId, result.claim);
    }
    return result?.claim;
  }

  /** Read a claim and its VFS ETag atomically (needed for CAS writes via ifMatch). */
  private async readClaimWithEtag(claimId: string): Promise<ClaimWithEtag | undefined> {
    const p = claimPath(this.zoneId, claimId);
    const result = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.readWithMeta(p)),
      "readClaim",
      this.config,
    );
    if (result === undefined) return undefined;
    return { claim: decodeClaim(result.content), etag: result.etag };
  }

  /** Write claim with ifMatch for CAS safety on mutations. */
  private async writeClaimCas(claim: Claim, expectedEtag: string): Promise<void> {
    const p = claimPath(this.zoneId, claim.claimId);
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(p, encodeClaim(claim), { ifMatch: expectedEtag }),
        ),
      "writeClaimCas",
      this.config,
    );
  }

  private async writeClaim(claim: Claim): Promise<void> {
    const p = claimPath(this.zoneId, claim.claimId);
    await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.write(p, encodeClaim(claim))),
      "writeClaim",
      this.config,
    );
  }

  /** Write claim file with conditional options (e.g. ifNoneMatch for create). */
  private async writeClaimConditional(
    claim: Claim,
    opts: { ifNoneMatch?: string; ifMatch?: string },
  ): Promise<void> {
    const path = claimPath(this.zoneId, claim.claimId);
    await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.write(path, encodeClaim(claim), opts)),
      "writeClaimConditional",
      this.config,
    );
  }

  /**
   * Acquire the per-target lock + write active index marker.
   * The lock file uses ifNoneMatch="*" to atomically enforce one-active-per-target.
   * If the lock is held by a claim that is no longer active (expired/released/completed),
   * the stale lock is cleaned up and the write is retried.
   * Throws NexusConflictError if another claim genuinely owns the target.
   */
  private async writeActiveIndexExclusive(claim: Claim): Promise<void> {
    const lockFile = targetLockPath(this.zoneId, claim.targetRef);

    try {
      // Atomic lock: fails with NexusConflictError if target already has an active claim
      await withSemaphore(this.semaphore, () =>
        this.client.write(lockFile, encoder.encode(claim.claimId), { ifNoneMatch: "*" }),
      );
    } catch (err) {
      if (!(err instanceof NexusConflictError)) throw err;

      // Lock conflict — read the current lock with its ETag so we can
      // CAS-replace it atomically (prevents the stale-takeover race
      // where delete+retry could remove a fresh claimant's lock).
      // IMPORTANT: bypass the cache to get fresh holder state.
      const existingMeta = await withSemaphore(this.semaphore, () =>
        this.client.readWithMeta(lockFile),
      );
      if (existingMeta === undefined) throw err;

      const holderId = decoder.decode(existingMeta.content);

      // Empty bytes => prior owner released via the CAS tombstone path
      // (see deleteActiveIndex). Treat as "no holder" for takeover.
      const isEmptyTombstone = holderId.length === 0;

      let holderStale = isEmptyTombstone;
      let holderResult: ClaimWithEtag | undefined;
      if (!holderStale) {
        holderResult = await this.readClaimWithEtag(holderId);
        const holderClaim = holderResult?.claim;
        holderStale =
          holderClaim === undefined ||
          holderClaim.status !== "active" ||
          new Date(holderClaim.leaseExpiresAt).getTime() < Date.now();
      }

      if (!holderStale) {
        // Genuine conflict — another live active claim owns this target.
        throw err;
      }

      // Before reassigning the lock, CAS-mark the stale holder as
      // `expired` using its current claim-file ETag. This invalidates
      // any in-flight writeClaimCas/heartbeat the stale owner might
      // still attempt — their old ETag no longer matches, so they fail
      // fast instead of resurrecting a zombie active claim. If the
      // holder record has moved under us (another party already
      // expired it, or the record was deleted), fall through: the
      // holder is already non-active and our lock takeover is safe.
      if (holderResult !== undefined && holderResult.claim.status === "active") {
        const expiredHolder: Claim = {
          ...holderResult.claim,
          status: "expired" as ClaimStatus,
          revision: (holderResult.claim.revision ?? 0) + 1,
        };
        try {
          await this.writeClaimCas(expiredHolder, holderResult.etag);
          this.claimCache.set(expiredHolder.claimId, expiredHolder);
        } catch (expireErr) {
          // CAS-expire conflict: the holder record changed under us.
          // This can be benign (another takeover / expireStale already
          // marked it non-active) OR it can be a live heartbeat that
          // refreshed the lease in between. We cannot tell from the
          // conflict alone, so re-read the holder and re-evaluate:
          // only treat as stale if the fresh record confirms it.
          // Any non-conflict error propagates.
          const isConflict =
            expireErr instanceof NexusConflictError ||
            (expireErr as Error | undefined)?.name === "StateConflictError";
          if (!isConflict) throw expireErr;

          const refreshed = await this.readClaimWithEtag(holderId);
          const refreshedIsStale =
            refreshed === undefined ||
            refreshed.claim.status !== "active" ||
            new Date(refreshed.claim.leaseExpiresAt).getTime() < Date.now();
          if (!refreshedIsStale) {
            // The holder heartbeated (or was renewed) and is live
            // again — abort the takeover. Re-throw the ORIGINAL
            // NexusConflictError so the caller sees a genuine
            // "target already has an active claim" error.
            throw err;
          }
          // Still stale on the refresh — safe to proceed. Populate
          // the cache from the refresh so a subsequent same-process
          // reader sees the latest state.
          if (refreshed !== undefined) {
            this.claimCache.set(refreshed.claim.claimId, refreshed.claim);
          }
        }
      }

      // Atomic takeover: CAS-replace the lock with our claimId only if
      // nothing has changed since we read it. If the ETag has moved
      // (another claimant won the takeover race), surface the original
      // conflict — the caller will retry claim creation from scratch.
      try {
        await withSemaphore(this.semaphore, () =>
          this.client.write(lockFile, encoder.encode(claim.claimId), {
            ifMatch: existingMeta.etag,
          }),
        );
      } catch (casErr) {
        if (casErr instanceof NexusConflictError) throw err;
        if ((casErr as Error | undefined)?.name === "StateConflictError") throw err;
        throw casErr;
      }

      // Only after winning the CAS do we clean up the stale per-claim
      // index (safe because its filename includes the old holderId,
      // so it cannot accidentally touch the new owner's index).
      if (!isEmptyTombstone) {
        const staleIndexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, holderId);
        await safeCleanup(
          withSemaphore(this.semaphore, () => this.client.delete(staleIndexFile)),
          "delete stale claim index",
        );
      }
    }

    // Also write the per-claim index marker (for listing)
    const indexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    await withSemaphore(this.semaphore, () => this.client.write(indexFile, new Uint8Array(0)));
  }

  private async deleteActiveIndex(claim: Claim): Promise<void> {
    // Delete the per-claim index unconditionally — it is namespaced by
    // claimId and only this claim can own it.
    const indexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    await safeCleanup(
      withSemaphore(this.semaphore, () => this.client.delete(indexFile)),
      "delete active claim index",
    );

    // Atomic, owner-conditional target-lock release.
    //
    // The shared target lock may already have been reassigned to a
    // fresh claimant across a lease boundary. Blindly deleting it
    // would break the one-active-claim-per-target invariant. We do an
    // ETag-bound CAS that clears the lock to empty bytes only if its
    // current content still matches this claim: a single atomic
    // write-with-ifMatch, no read/delete TOCTOU.
    //
    // An empty-bytes lock is treated as "released" by
    // writeActiveIndexExclusive's takeover path, which removes it and
    // retries the atomic ifNoneMatch="*" create. If another claimant
    // already replaced the lock, the ifMatch CAS fails (StateConflict
    // or NexusConflictError) and we leave their lock untouched.
    const lockFile = targetLockPath(this.zoneId, claim.targetRef);
    const meta = await withSemaphore(this.semaphore, () =>
      this.client.readWithMeta(lockFile),
    ).catch(() => undefined);
    if (meta === undefined) return;
    if (decoder.decode(meta.content) !== claim.claimId) return;
    try {
      await withSemaphore(this.semaphore, () =>
        this.client.write(lockFile, new Uint8Array(0), { ifMatch: meta.etag }),
      );
    } catch (err) {
      // ifMatch mismatch (another claimant replaced the lock between
      // read and write) is a benign no-op — we must not stomp their
      // state. Other errors bubble up: they indicate a real fault.
      if (err instanceof NexusConflictError) return;
      // StateConflictError from the client layer also maps to CAS fail.
      if ((err as Error | undefined)?.name === "StateConflictError") return;
      throw err;
    }
  }

  private async findActiveOnTarget(targetRef: string, now: Date): Promise<Claim | undefined> {
    const dir = activeClaimTargetDir(this.zoneId, targetRef);
    const claims = await this.readActiveClaimsFromDir(dir, now);
    return claims.length > 0 ? claims[0] : undefined;
  }

  private async readActiveClaimsFromDir(dir: string, now: Date): Promise<Claim[]> {
    const entries = await listAllPages(this.client, this.semaphore, this.config, dir);

    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    const claimIds = nonDirEntries.map((entry) => decodeSegment(entry.name));
    const fetched = await batchParallel(claimIds, (claimId) => this.readClaim(claimId));

    const claims: Claim[] = [];
    for (const claim of fetched) {
      if (claim !== undefined && claim.status === "active") {
        if (new Date(claim.leaseExpiresAt).getTime() >= now.getTime()) {
          claims.push(claim);
        }
      }
    }
    return claims;
  }

  private async listAllClaims(): Promise<Claim[]> {
    const results = await this.listAllClaimsWithEtags();
    return results.map((r) => r.claim);
  }

  private async listAllClaimsWithEtags(): Promise<ClaimWithEtag[]> {
    const dir = claimsDir(this.zoneId);
    const entries = await listAllPages(this.client, this.semaphore, this.config, dir);

    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    const claimIds = nonDirEntries.map((entry) => decodeSegment(entry.name.replace(/\.json$/, "")));
    const fetched = await batchParallel(claimIds, (claimId) => this.readClaimWithEtag(claimId));

    return fetched.filter((result): result is ClaimWithEtag => result !== undefined);
  }
}
