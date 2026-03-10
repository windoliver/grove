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
import type { NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { isRetryable, mapNexusError } from "./errors.js";
import { Semaphore } from "./semaphore.js";
import {
  activeClaimIndexPath,
  activeClaimsDir,
  activeClaimTargetDir,
  claimPath,
  claimsDir,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeClaim(claim: Claim): Uint8Array {
  return encoder.encode(JSON.stringify(claim));
}

function decodeClaim(data: Uint8Array): Claim {
  return JSON.parse(decoder.decode(data)) as Claim;
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

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.storeIdentity = `nexus:${this.zoneId}:claims`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
  }

  async createClaim(claim: Claim): Promise<Claim> {
    validateClaimContext(claim);

    // Check for duplicate claimId
    const existingById = await this.readClaim(claim.claimId);
    if (existingById !== undefined) {
      throw new Error(`Claim with id '${claim.claimId}' already exists`);
    }

    // Check for active claim on target
    const now = new Date();
    const activeOnTarget = await this.findActiveOnTarget(claim.targetRef, now);
    if (activeOnTarget !== undefined) {
      throw new Error(
        `Target '${claim.targetRef}' already has an active claim '${activeOnTarget.claimId}'`,
      );
    }

    const createdClaim: Claim = {
      ...claim,
      createdAt: toUtcIso(claim.createdAt),
      heartbeatAt: toUtcIso(claim.heartbeatAt),
      leaseExpiresAt: toUtcIso(claim.leaseExpiresAt),
      revision: 1,
    };

    await this.writeClaim(createdClaim);
    await this.writeActiveIndex(createdClaim);
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
      const existing = activeOnTarget;
      const durationMs = computeLeaseDuration(claim);
      const renewed: Claim = {
        ...existing,
        heartbeatAt: nowIso,
        leaseExpiresAt: new Date(now.getTime() + durationMs).toISOString(),
        intentSummary: claim.intentSummary,
        revision: (existing.revision ?? 0) + 1,
      };
      await this.writeClaim(renewed);
      return renewed;
    }

    // Create new claim
    const existingById = await this.readClaim(claim.claimId);
    if (existingById !== undefined) {
      throw new Error(`Claim with id '${claim.claimId}' already exists`);
    }

    const createdClaim: Claim = {
      ...claim,
      createdAt: toUtcIso(claim.createdAt),
      heartbeatAt: toUtcIso(claim.heartbeatAt),
      leaseExpiresAt: toUtcIso(claim.leaseExpiresAt),
      revision: 1,
    };
    await this.writeClaim(createdClaim);
    await this.writeActiveIndex(createdClaim);
    return createdClaim;
  }

  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.readClaim(claimId);
  }

  async heartbeat(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    const existing = await this.readClaim(claimId);
    validateHeartbeat(existing, claimId);
    const validClaim = existing as Claim;

    const now = new Date();
    const duration = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    const updated: Claim = {
      ...validClaim,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + duration).toISOString(),
      revision: (validClaim.revision ?? 0) + 1,
    };

    await this.writeClaim(updated);
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
    const allClaims = await this.listAllClaims();

    for (const claim of allClaims) {
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
        await this.writeClaim(expired);
        await this.deleteActiveIndex(expired);
        results.push({ claim: expired, reason });
      }
    }

    return results;
  }

  async activeClaims(targetRef?: string): Promise<readonly Claim[]> {
    const now = new Date();

    if (targetRef !== undefined) {
      const dir = activeClaimTargetDir(this.zoneId, targetRef);
      return this.readActiveClaimsFromDir(dir, now);
    }

    const dir = activeClaimsDir(this.zoneId);
    const listing = await this.withRetry(
      () => this.run(() => this.client.list(dir, { recursive: true })),
      "activeClaims",
    ).catch(() => ({ files: [], hasMore: false }));

    const claims: Claim[] = [];
    for (const entry of listing.files) {
      if (entry.isDirectory) continue;
      const claimId = entry.name;
      const claim = await this.readClaim(claimId);
      if (claim !== undefined && claim.status === "active") {
        if (new Date(claim.leaseExpiresAt).getTime() >= now.getTime()) {
          claims.push(claim);
        }
      }
    }
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
          await this.withRetry(() => this.run(() => this.client.delete(path)), "cleanCompleted");
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
    const existing = await this.readClaim(claimId);
    validateTransition(existing, claimId, newStatus);
    const validClaim = existing as Claim;

    const updated: Claim = {
      ...validClaim,
      status: newStatus,
      revision: (validClaim.revision ?? 0) + 1,
    };
    await this.writeClaim(updated);
    if (newStatus !== "active") {
      await this.deleteActiveIndex(updated);
    }
    return updated;
  }

  private async readClaim(claimId: string): Promise<Claim | undefined> {
    const path = claimPath(this.zoneId, claimId);
    const data = await this.withRetry(() => this.run(() => this.client.read(path)), "readClaim");
    if (data === undefined) return undefined;
    return decodeClaim(data);
  }

  private async writeClaim(claim: Claim): Promise<void> {
    const path = claimPath(this.zoneId, claim.claimId);
    await this.withRetry(
      () => this.run(() => this.client.write(path, encodeClaim(claim))),
      "writeClaim",
    );
  }

  private async writeActiveIndex(claim: Claim): Promise<void> {
    const path = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    await this.run(() => this.client.write(path, new Uint8Array(0)));
  }

  private async deleteActiveIndex(claim: Claim): Promise<void> {
    const path = activeClaimIndexPath(this.zoneId, claim.targetRef, claim.claimId);
    await this.run(() => this.client.delete(path)).catch(() => {});
  }

  private async findActiveOnTarget(targetRef: string, now: Date): Promise<Claim | undefined> {
    const dir = activeClaimTargetDir(this.zoneId, targetRef);
    const claims = await this.readActiveClaimsFromDir(dir, now);
    return claims.length > 0 ? claims[0] : undefined;
  }

  private async readActiveClaimsFromDir(dir: string, now: Date): Promise<Claim[]> {
    const listing = await this.withRetry(
      () => this.run(() => this.client.list(dir)),
      "readActiveClaimsFromDir",
    ).catch(() => ({ files: [], hasMore: false }));

    const claims: Claim[] = [];
    for (const entry of listing.files) {
      if (entry.isDirectory) continue;
      const claimId = entry.name;
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
    const dir = claimsDir(this.zoneId);
    const listing = await this.withRetry(
      () => this.run(() => this.client.list(dir)),
      "listAllClaims",
    ).catch(() => ({ files: [], hasMore: false }));

    const claims: Claim[] = [];
    for (const entry of listing.files) {
      if (entry.isDirectory) continue;
      const data = await this.run(() => this.client.read(entry.path));
      if (data !== undefined) {
        claims.push(decodeClaim(data));
      }
    }
    return claims;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    return this.semaphore.run(fn);
  }

  private async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.retryMaxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.config.retryMaxAttempts - 1) {
          throw mapNexusError(error, context);
        }
        const delay = Math.min(
          this.config.retryBaseDelayMs * 2 ** attempt,
          this.config.retryMaxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw mapNexusError(lastError, context);
  }
}
