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
import type { ListEntry, ListOptions, NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { NexusConflictError } from "./errors.js";
import { LruCache } from "./lru-cache.js";
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
  /** Cached activeClaims result with TTL. */
  private activeClaimsCache:
    | { readonly claims: readonly Claim[]; readonly expiresAt: number }
    | undefined;
  private static readonly ACTIVE_CLAIMS_TTL_MS = 2_500;

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.storeIdentity = `nexus:${this.zoneId}:claims`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
    this.claimCache = new LruCache(this.config.cacheMaxEntries);
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
        throw new Error(`Claim with id '${claim.claimId}' already exists`);
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
        throw new Error(`Target '${claim.targetRef}' already has an active claim '${existingId}'`);
      }
      throw err;
    }

    this.claimCache.set(createdClaim.claimId, createdClaim);
    this.invalidateActiveClaimsCache();
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
        throw new Error(`Claim with id '${claim.claimId}' already exists`);
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
    return createdClaim;
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.readClaim(claimId);
  }

  async heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    const result = await this.readClaimWithEtag(claimId);
    validateHeartbeat(result?.claim, claimId);
    const { claim: validClaim, etag } = result as ClaimWithEtag;

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
    return updated;
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
    const entries = await this.listAllPages(dir, { recursive: true });

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

    claims.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return claims;
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

  close(): void {
    // No-op — lifecycle managed by client
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async transitionClaim(claimId: string, newStatus: ClaimStatus): Promise<Claim> {
    const result = await this.readClaimWithEtag(claimId);
    validateTransition(result?.claim, claimId, newStatus);
    const { claim: validClaim, etag } = result as ClaimWithEtag;

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

      // Lock conflict — check if the holder is still active.
      // IMPORTANT: bypass cache to get fresh state (the holder may have
      // heartbeated recently, and stale cache would cause false expiry).
      const existingLockData = await withSemaphore(this.semaphore, () =>
        this.client.read(lockFile),
      );
      if (existingLockData !== undefined) {
        const holderId = decoder.decode(existingLockData);
        const holderResult = await this.readClaimWithEtag(holderId);
        const holderClaim = holderResult?.claim;

        // If the holder is gone, expired, released, or completed, clean up and retry
        if (
          holderClaim === undefined ||
          holderClaim.status !== "active" ||
          new Date(holderClaim.leaseExpiresAt).getTime() < Date.now()
        ) {
          // Clean up stale lock and index
          await safeCleanup(
            withSemaphore(this.semaphore, () => this.client.delete(lockFile)),
            "delete stale target lock",
          );
          const staleIndexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, holderId);
          await safeCleanup(
            withSemaphore(this.semaphore, () => this.client.delete(staleIndexFile)),
            "delete stale claim index",
          );

          // Retry the lock
          await withSemaphore(this.semaphore, () =>
            this.client.write(lockFile, encoder.encode(claim.claimId), { ifNoneMatch: "*" }),
          );
        } else {
          // Genuine conflict — another active claim owns this target
          throw err;
        }
      } else {
        throw err;
      }
    }

    // Also write the per-claim index marker (for listing)
    const indexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    await withSemaphore(this.semaphore, () => this.client.write(indexFile, new Uint8Array(0)));
  }

  private async deleteActiveIndex(claim: Claim): Promise<void> {
    // Delete both the per-claim index and the target lock
    const indexFile = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    const lockFile = targetLockPath(this.zoneId, claim.targetRef);
    await safeCleanup(
      withSemaphore(this.semaphore, () => this.client.delete(indexFile)),
      "delete active claim index",
    );
    await safeCleanup(
      withSemaphore(this.semaphore, () => this.client.delete(lockFile)),
      "delete target lock",
    );
  }

  private async findActiveOnTarget(targetRef: string, now: Date): Promise<Claim | undefined> {
    const dir = activeClaimTargetDir(this.zoneId, targetRef);
    const claims = await this.readActiveClaimsFromDir(dir, now);
    return claims.length > 0 ? claims[0] : undefined;
  }

  private async readActiveClaimsFromDir(dir: string, now: Date): Promise<Claim[]> {
    const entries = await this.listAllPages(dir);

    const claims: Claim[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const claimId = decodeSegment(entry.name);
      const claim = await this.readClaim(claimId);
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
    const entries = await this.listAllPages(dir);

    const claims: ClaimWithEtag[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const claimId = decodeSegment(entry.name.replace(/\.json$/, ""));
      const result = await this.readClaimWithEtag(claimId);
      if (result !== undefined) {
        claims.push(result);
      }
    }
    return claims;
  }

  /** Paginate through all pages of a list() call, collecting all entries. */
  private async listAllPages(
    dir: string,
    opts?: Omit<ListOptions, "cursor">,
  ): Promise<readonly ListEntry[]> {
    const entries: ListEntry[] = [];
    let cursor: string | undefined;

    do {
      const listing = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.list(dir, { ...opts, cursor })),
        "listAllPages",
        this.config,
      ).catch(() => ({
        files: [] as ListEntry[],
        hasMore: false as boolean,
        nextCursor: undefined,
      }));

      for (const entry of listing.files) {
        entries.push(entry);
      }
      cursor = listing.hasMore ? listing.nextCursor : undefined;
    } while (cursor !== undefined);

    return entries;
  }
}
