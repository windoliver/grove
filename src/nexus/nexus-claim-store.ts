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
import { claimToEntity, claimViewToEntity } from "../core/entity.js";
import { NotFoundError, StateConflictError } from "../core/errors.js";
import {
  type Claim,
  type ClaimSpecRecord,
  type ClaimStatus,
  type ClaimStatusRecord,
  type ClaimView,
  claimToSpecRecord,
  claimToStatusRecord,
  claimViewToClaim,
} from "../core/models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStatusPatch,
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

interface ClaimDocument {
  readonly spec: ClaimSpecRecord;
  readonly status: ClaimStatusRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClaimDocument(value: unknown): value is ClaimDocument {
  return (
    isRecord(value) &&
    isRecord(value.spec) &&
    isRecord(value.status) &&
    typeof value.spec.id === "string" &&
    typeof value.status.id === "string"
  );
}

function claimToDocument(claim: Claim): ClaimDocument {
  return {
    spec: claimToSpecRecord(claim),
    status: claimToStatusRecord(claim),
  };
}

function claimToDocumentPreservingSplitFields(
  claim: Claim,
  existingDocument: ClaimDocument | undefined,
): ClaimDocument {
  if (existingDocument === undefined) return claimToDocument(claim);

  const specWithContext: ClaimSpecRecord = {
    ...existingDocument.spec,
    id: claim.claimId,
    targetRef: claim.targetRef,
    agent: claim.agent,
    intentSummary: claim.intentSummary,
    createdAt: claim.createdAt,
    ...(claim.context === undefined ? {} : { context: claim.context }),
  };
  const spec =
    claim.context === undefined
      ? (({ context: _context, ...rest }) => rest)(specWithContext)
      : specWithContext;

  return {
    spec,
    status: {
      ...existingDocument.status,
      id: claim.claimId,
      phase: claim.status,
      lastHeartbeatAt: claim.heartbeatAt,
      leaseExpiresAt: claim.leaseExpiresAt,
      attemptCount: claim.attemptCount ?? existingDocument.status.attemptCount,
      revision: claim.revision ?? existingDocument.status.revision,
    },
  };
}

function decodeClaimDocument(data: Uint8Array): ClaimDocument {
  const parsed = JSON.parse(decoder.decode(data)) as unknown;
  if (isClaimDocument(parsed)) return parsed;
  return claimToDocument(parsed as Claim);
}

function encodeClaimDocument(document: ClaimDocument): Uint8Array {
  return encoder.encode(JSON.stringify(document));
}

function targetRefFromActiveIndexPath(zoneId: string, path: string): string | undefined {
  const prefix = `${activeClaimsDir(zoneId)}/`;
  if (!path.startsWith(prefix)) return undefined;
  const relative = path.slice(prefix.length);
  const slashIndex = relative.lastIndexOf("/");
  if (slashIndex < 0) return undefined;
  return decodeSegment(relative.slice(0, slashIndex));
}

/** A claim document bundled with its VFS ETag for CAS writes. */
interface ClaimDocumentWithEtag {
  readonly document: ClaimDocument;
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

  async putClaimSpec(spec: ClaimSpecRecord): Promise<ClaimView> {
    const existing = await this.readClaimWithEtag(spec.id);

    if (existing === undefined) {
      const now = new Date();
      const nowIso = now.toISOString();
      const createdAt = toUtcIso(spec.createdAt);
      const createdAtMs = new Date(createdAt).getTime();
      const leaseDeadlineSec = spec.leaseDeadlineSec ?? DEFAULT_LEASE_DURATION_MS / 1000;
      const document: ClaimDocument = {
        spec: { ...spec, generation: 1, createdAt },
        status: {
          id: spec.id,
          phase: "active" as ClaimStatus,
          observedGeneration: 0,
          lastHeartbeatAt: nowIso,
          leaseExpiresAt: new Date(createdAtMs + leaseDeadlineSec * 1000).toISOString(),
          conditions: [],
          lastTransitionAt: nowIso,
          attemptCount: 0,
          revision: 1,
        },
      };
      const flatClaim = claimViewToClaim(document);
      validateClaimContext(flatClaim);

      try {
        await this.writeActiveIndexExclusive(flatClaim);
      } catch (err) {
        if (err instanceof NexusConflictError) {
          const activeOnTarget = await this.findActiveOnTarget(spec.targetRef, new Date());
          const existingId = activeOnTarget?.claimId ?? "(unknown)";
          throw new StateConflictError({
            resource: "Claim",
            reason: "target already has an active claim",
            message: `Target '${spec.targetRef}' already has an active claim '${existingId}'`,
          });
        }
        throw err;
      }

      try {
        await this.writeClaimDocumentConditional(spec.id, document, {
          ifNoneMatch: "*",
        });
      } catch (err) {
        await safeCleanup(
          this.deleteActiveIndexUnlessCurrentClaimOwns(flatClaim),
          "rollback active index after split spec write failure",
          { silent: true },
        );
        if (err instanceof NexusConflictError) {
          throw new StateConflictError({
            resource: "Claim",
            reason: "already exists",
            message: `Claim with id '${spec.id}' already exists`,
          });
        }
        throw err;
      }

      this.claimCache.set(flatClaim.claimId, flatClaim);
      this.invalidateActiveClaimsCache();
      this.publishWatch(flatClaim, "ADDED");
      return document;
    }

    const existingDocument = existing.document;
    const updatedDocument: ClaimDocument = {
      spec: {
        ...spec,
        createdAt: existingDocument.spec.createdAt,
        generation: existingDocument.spec.generation + 1,
      },
      status: existingDocument.status,
    };
    const existingClaim = claimViewToClaim(existingDocument);
    const updatedClaim = claimViewToClaim(updatedDocument);
    validateClaimContext(updatedClaim);

    const now = new Date();
    const existingIsActive =
      existingClaim.status === "active" &&
      new Date(existingClaim.leaseExpiresAt).getTime() >= now.getTime();
    const activeTargetChanged =
      existingIsActive && existingClaim.targetRef !== updatedClaim.targetRef;

    if (activeTargetChanged) {
      const activeOnNewTarget = await this.findActiveOnTarget(updatedClaim.targetRef, now);
      if (activeOnNewTarget !== undefined && activeOnNewTarget.claimId !== updatedClaim.claimId) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "target already has an active claim",
          message: `Target '${updatedClaim.targetRef}' already has an active claim '${activeOnNewTarget.claimId}'`,
        });
      }
      await this.assertLockOwned(existingClaim.targetRef, existingClaim.claimId);
      await this.writeActiveIndexExclusive(updatedClaim);
    }

    try {
      await this.writeClaimDocumentCas(spec.id, updatedDocument, existing.etag);
    } catch (err) {
      if (activeTargetChanged) {
        await safeCleanup(
          this.deleteActiveIndexUnlessCurrentClaimOwns(updatedClaim),
          "rollback moved active index",
          {
            silent: true,
          },
        );
      }
      throw err;
    }

    if (activeTargetChanged) {
      await this.deleteActiveIndex(existingClaim);
    }

    this.claimCache.set(updatedClaim.claimId, updatedClaim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(updatedClaim, "MODIFIED");
    return updatedDocument;
  }

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    const result = await this.readClaimWithEtag(claimId);
    return result?.document;
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const existing = await this.readClaimWithEtag(claimId);
    if (existing === undefined) {
      throw new NotFoundError({
        resource: "Claim",
        identifier: claimId,
        message: `Claim '${claimId}' not found`,
      });
    }

    const updatedDocument: ClaimDocument = {
      spec: existing.document.spec,
      status: {
        ...existing.document.status,
        phase: patch.phase ?? existing.document.status.phase,
        observedGeneration: patch.observedGeneration ?? existing.document.status.observedGeneration,
        agentSessionId: patch.agentSessionId ?? existing.document.status.agentSessionId,
        lastHeartbeatAt:
          patch.lastHeartbeatAt !== undefined
            ? toUtcIso(patch.lastHeartbeatAt)
            : existing.document.status.lastHeartbeatAt,
        leaseExpiresAt:
          patch.leaseExpiresAt !== undefined
            ? toUtcIso(patch.leaseExpiresAt)
            : existing.document.status.leaseExpiresAt,
        currentContributionCid:
          patch.currentContributionCid ?? existing.document.status.currentContributionCid,
        conditions: patch.conditions ?? existing.document.status.conditions,
        lastTransitionAt:
          patch.lastTransitionAt !== undefined
            ? toUtcIso(patch.lastTransitionAt)
            : existing.document.status.lastTransitionAt,
        revision: existing.document.status.revision + 1,
      },
    };

    const existingClaim = claimViewToClaim(existing.document);
    const updatedClaim = claimViewToClaim(updatedDocument);
    const now = new Date();
    const existingActiveUnexpired =
      existingClaim.status === "active" &&
      new Date(existingClaim.leaseExpiresAt).getTime() >= now.getTime();
    const updatedActiveUnexpired =
      updatedClaim.status === "active" &&
      new Date(updatedClaim.leaseExpiresAt).getTime() >= now.getTime();
    const needsActiveAcquire = updatedActiveUnexpired && !existingActiveUnexpired;
    const needsActiveDelete = !updatedActiveUnexpired && existingClaim.status === "active";

    if (needsActiveAcquire) {
      try {
        await this.writeActiveIndexExclusive(updatedClaim);
      } catch (err) {
        if (err instanceof NexusConflictError) {
          const activeOnTarget = await this.findActiveOnTarget(updatedClaim.targetRef, now);
          const existingId = activeOnTarget?.claimId ?? "(unknown)";
          throw new StateConflictError({
            resource: "Claim",
            reason: "target already has an active claim",
            message: `Target '${updatedClaim.targetRef}' already has an active claim '${existingId}'`,
          });
        }
        throw err;
      }
    }

    try {
      await this.writeClaimDocumentCas(claimId, updatedDocument, existing.etag);
    } catch (err) {
      if (needsActiveAcquire) {
        await safeCleanup(
          this.deleteActiveIndexUnlessCurrentClaimOwns(updatedClaim),
          "rollback status active index",
          {
            silent: true,
          },
        );
      }
      throw err;
    }

    if (needsActiveDelete) {
      await this.deleteActiveIndex(updatedClaim);
    }

    this.claimCache.set(updatedClaim.claimId, updatedClaim);
    this.invalidateActiveClaimsCache();
    this.publishWatch(updatedClaim, "MODIFIED");
    return updatedDocument;
  }

  async createClaim(claim: Claim): Promise<Claim> {
    validateClaimContext(claim);

    // Acquire target ownership before exposing the claim file. If the
    // subsequent conditional claim write fails, rollback is limited to
    // active-index state this operation still appears to own.
    const createdClaim: Claim = {
      ...claim,
      createdAt: toUtcIso(claim.createdAt),
      heartbeatAt: toUtcIso(claim.heartbeatAt),
      leaseExpiresAt: toUtcIso(claim.leaseExpiresAt),
      revision: 1,
    };

    try {
      await this.writeActiveIndexExclusive(createdClaim);
    } catch (err) {
      if (err instanceof NexusConflictError) {
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

    try {
      await this.writeClaimConditional(createdClaim, { ifNoneMatch: "*" });
    } catch (err) {
      await safeCleanup(
        this.deleteActiveIndexUnlessCurrentClaimOwns(createdClaim),
        "rollback active index after claim write failure",
        { silent: true },
      );
      if (err instanceof NexusConflictError) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
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
      const existing =
        withEtag !== undefined ? claimViewToClaim(withEtag.document) : activeOnTarget;
      const durationMs = computeLeaseDuration(claim);
      const renewed: Claim = {
        ...existing,
        heartbeatAt: nowIso,
        leaseExpiresAt: new Date(now.getTime() + durationMs).toISOString(),
        intentSummary: claim.intentSummary,
        revision: (existing.revision ?? 0) + 1,
      };
      if (withEtag !== undefined) {
        await this.writeClaimCas(renewed, withEtag.etag, withEtag.document);
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
      await this.writeActiveIndexExclusive(createdClaim);
    } catch (err) {
      if (err instanceof NexusConflictError) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "target already has an active claim",
          message: `Target '${claim.targetRef}' already has an active claim`,
        });
      }
      throw err;
    }

    try {
      await this.writeClaimConditional(createdClaim, { ifNoneMatch: "*" });
    } catch (err) {
      await safeCleanup(
        this.deleteActiveIndexUnlessCurrentClaimOwns(createdClaim),
        "rollback active index after claimOrRenew write failure",
        { silent: true },
      );
      if (err instanceof NexusConflictError) {
        throw new StateConflictError({
          resource: "Claim",
          reason: "already exists",
          message: `Claim with id '${claim.claimId}' already exists`,
        });
      }
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
    const claim = result !== undefined ? claimViewToClaim(result.document) : undefined;
    validateHeartbeat(claim, claimId);
    const validClaim = claim as Claim;
    const etag = result?.etag as string;

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

    await this.writeClaimCas(updated, etag, result?.document);
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

    for (const { document, etag } of allClaimsWithEtags) {
      const claim = claimViewToClaim(document);
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
        await this.writeClaimCas(expired, etag, document);
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
      return this.readActiveClaimsFromDir(dir, now, targetRef);
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
    const indexedClaims = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({
        claimId: decodeSegment(entry.name),
        targetRef: targetRefFromActiveIndexPath(this.zoneId, entry.path),
      }));

    const results = await Promise.all(
      indexedClaims.map(async ({ claimId, targetRef: indexedTargetRef }) => {
        const result = await this.readClaimWithEtag(claimId);
        const claim = result !== undefined ? claimViewToClaim(result.document) : undefined;
        return { claim, indexedTargetRef };
      }),
    );

    const claims: Claim[] = [];
    const seen = new Set<string>();
    for (const { claim, indexedTargetRef } of results) {
      if (claim !== undefined && claim.status === "active") {
        if (
          indexedTargetRef === claim.targetRef &&
          new Date(claim.leaseExpiresAt).getTime() >= now.getTime() &&
          !seen.has(claim.claimId)
        ) {
          claims.push(claim);
          seen.add(claim.claimId);
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
    const items = await this.listClaimViews(baseQuery);
    const entities = items.map((view) => claimViewToEntity(view, () => Date.now(), this.zoneId));
    if (query?.status === undefined) return entities;
    const wanted = Array.isArray(query.status) ? new Set(query.status) : new Set([query.status]);
    return entities.filter((e) => wanted.has(e.status.phase));
  }

  private async listClaimViews(query?: ClaimQuery): Promise<readonly ClaimView[]> {
    let views = (await this.listAllClaimsWithEtags()).map((result) => result.document);

    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      views = views.filter((view) => statuses.includes(view.status.phase));
    }
    if (query?.agentId !== undefined) {
      views = views.filter((view) => view.spec.agent.agentId === query.agentId);
    }
    if (query?.targetRef !== undefined) {
      views = views.filter((view) => view.spec.targetRef === query.targetRef);
    }

    views.sort(
      (a, b) => new Date(b.spec.createdAt).getTime() - new Date(a.spec.createdAt).getTime(),
    );
    return views;
  }

  close(): void {
    // No-op — lifecycle managed by client
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async transitionClaim(claimId: string, newStatus: ClaimStatus): Promise<Claim> {
    const result = await this.readClaimWithEtag(claimId);
    const claim = result !== undefined ? claimViewToClaim(result.document) : undefined;
    validateTransition(claim, claimId, newStatus);
    const validClaim = claim as Claim;
    const etag = result?.etag as string;

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
    await this.writeClaimCas(updated, etag, result?.document);
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
    const claim = result !== undefined ? claimViewToClaim(result.document) : undefined;
    if (result !== undefined) {
      this.claimCache.set(claimId, claimViewToClaim(result.document));
    }
    return claim;
  }

  /** Read a claim and its VFS ETag atomically (needed for CAS writes via ifMatch). */
  private async readClaimWithEtag(claimId: string): Promise<ClaimDocumentWithEtag | undefined> {
    const p = claimPath(this.zoneId, claimId);
    const result = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.readWithMeta(p)),
      "readClaim",
      this.config,
    );
    if (result === undefined) return undefined;
    return { document: decodeClaimDocument(result.content), etag: result.etag };
  }

  /** Write claim with ifMatch for CAS safety on mutations. */
  private async writeClaimCas(
    claim: Claim,
    expectedEtag: string,
    existingDocument?: ClaimDocument,
  ): Promise<void> {
    await this.writeClaimDocumentCas(
      claim.claimId,
      claimToDocumentPreservingSplitFields(claim, existingDocument),
      expectedEtag,
    );
  }

  private async writeClaim(claim: Claim): Promise<void> {
    const p = claimPath(this.zoneId, claim.claimId);
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(p, encodeClaimDocument(claimToDocument(claim))),
        ),
      "writeClaim",
      this.config,
    );
  }

  /** Write claim file with conditional options (e.g. ifNoneMatch for create). */
  private async writeClaimConditional(
    claim: Claim,
    opts: { ifNoneMatch?: string; ifMatch?: string },
  ): Promise<string> {
    const path = claimPath(this.zoneId, claim.claimId);
    const result = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(path, encodeClaimDocument(claimToDocument(claim)), opts),
        ),
      "writeClaimConditional",
      this.config,
    );
    return result.etag;
  }

  private async writeClaimDocumentConditional(
    claimId: string,
    document: ClaimDocument,
    opts: { readonly ifNoneMatch: "*" },
  ): Promise<string> {
    const result = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(claimPath(this.zoneId, claimId), encodeClaimDocument(document), opts),
        ),
      "writeClaimDocumentConditional",
      this.config,
    );
    return result.etag;
  }

  private async writeClaimDocumentCas(
    claimId: string,
    document: ClaimDocument,
    etag: string,
  ): Promise<void> {
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(claimPath(this.zoneId, claimId), encodeClaimDocument(document), {
            ifMatch: etag,
          }),
        ),
      "writeClaimDocumentCas",
      this.config,
    );
  }

  private async deleteActiveIndexUnlessCurrentClaimOwns(claim: Claim): Promise<void> {
    const current = await this.readClaimWithEtag(claim.claimId);
    const currentClaim = current !== undefined ? claimViewToClaim(current.document) : undefined;
    if (
      currentClaim !== undefined &&
      currentClaim.status === "active" &&
      currentClaim.targetRef === claim.targetRef &&
      new Date(currentClaim.leaseExpiresAt).getTime() >= Date.now()
    ) {
      return;
    }
    await this.deleteActiveIndex(claim);
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
      let holderTargetMismatch = false;
      let holderResult: ClaimDocumentWithEtag | undefined;
      if (!holderStale) {
        holderResult = await this.readClaimWithEtag(holderId);
        const holderClaim =
          holderResult !== undefined ? claimViewToClaim(holderResult.document) : undefined;
        holderTargetMismatch =
          holderClaim !== undefined && holderClaim.targetRef !== claim.targetRef;
        holderStale =
          holderClaim === undefined ||
          holderClaim.status !== "active" ||
          holderTargetMismatch ||
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
      const holderClaim =
        holderResult !== undefined ? claimViewToClaim(holderResult.document) : undefined;
      if (holderResult !== undefined && holderClaim?.status === "active" && !holderTargetMismatch) {
        const expiredHolder: Claim = {
          ...holderClaim,
          status: "expired" as ClaimStatus,
          revision: (holderClaim.revision ?? 0) + 1,
        };
        try {
          await this.writeClaimCas(expiredHolder, holderResult.etag, holderResult.document);
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
          const refreshedClaim =
            refreshed !== undefined ? claimViewToClaim(refreshed.document) : undefined;
          const refreshedTargetMismatch =
            refreshedClaim !== undefined && refreshedClaim.targetRef !== claim.targetRef;
          const refreshedIsStale =
            refreshed === undefined ||
            refreshedClaim?.status !== "active" ||
            refreshedTargetMismatch ||
            new Date(refreshedClaim.leaseExpiresAt).getTime() < Date.now();
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
          if (refreshed !== undefined && refreshedClaim !== undefined) {
            this.claimCache.set(refreshedClaim.claimId, refreshedClaim);
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
    const claims = await this.readActiveClaimsFromDir(dir, now, targetRef);
    return claims.length > 0 ? claims[0] : undefined;
  }

  private async readActiveClaimsFromDir(
    dir: string,
    now: Date,
    targetRef: string,
  ): Promise<Claim[]> {
    const entries = await listAllPages(this.client, this.semaphore, this.config, dir);

    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    const claimIds = nonDirEntries.map((entry) => decodeSegment(entry.name));
    const fetched = await batchParallel(claimIds, async (claimId) => {
      const result = await this.readClaimWithEtag(claimId);
      return result !== undefined ? claimViewToClaim(result.document) : undefined;
    });

    const claims: Claim[] = [];
    const seen = new Set<string>();
    for (const claim of fetched) {
      if (claim !== undefined && claim.status === "active") {
        if (
          claim.targetRef === targetRef &&
          new Date(claim.leaseExpiresAt).getTime() >= now.getTime() &&
          !seen.has(claim.claimId)
        ) {
          claims.push(claim);
          seen.add(claim.claimId);
        }
      }
    }
    return claims;
  }

  private async listAllClaims(): Promise<Claim[]> {
    const results = await this.listAllClaimsWithEtags();
    return results.map((r) => claimViewToClaim(r.document));
  }

  private async listAllClaimsWithEtags(): Promise<ClaimDocumentWithEtag[]> {
    const dir = claimsDir(this.zoneId);
    const entries = await listAllPages(this.client, this.semaphore, this.config, dir);

    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    const claimIds = nonDirEntries.map((entry) => decodeSegment(entry.name.replace(/\.json$/, "")));
    const fetched = await batchParallel(claimIds, (claimId) => this.readClaimWithEtag(claimId));

    return fetched.filter((result): result is ClaimDocumentWithEtag => result !== undefined);
  }
}
