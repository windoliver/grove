/**
 * Enforcement wrappers for ContributionStore and ClaimStore.
 *
 * These decorators compose a raw store with a GroveContract to enforce:
 * - Concurrency limits (global, per-agent, per-target)
 * - Rate limits (per-agent, per-grove contributions per hour)
 * - Artifact limits (size, count)
 * - Lease duration limits (on create AND heartbeat)
 *
 * Write operations are serialized via a shared in-process mutex keyed
 * by inner store identity (WeakMap), so multiple wrappers over the same
 * backing store share one mutex and cannot bypass limits via independent
 * check-then-act sequences. The raw stores remain contract-agnostic;
 * all policy enforcement lives in these wrappers.
 */

import type { ContentStore } from "./cas.js";
import type { GroveContract } from "./contract.js";
import {
  ArtifactLimitError,
  ConcurrencyLimitError,
  LeaseViolationError,
  RateLimitError,
} from "./errors.js";
import type { Claim, Contribution, ContributionKind, Relation, RelationType } from "./models.js";
import type {
  ActiveClaimFilter,
  ClaimQuery,
  ClaimStore,
  ContributionQuery,
  ContributionStore,
  ExpiredClaim,
  ExpireStaleOptions,
  ThreadNode,
} from "./store.js";

// ---------------------------------------------------------------------------
// Rate limit window
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour

/**
 * Maximum allowed clock skew for contribution timestamps (in ms).
 * Contributions with `createdAt` more than this far in the past are
 * rejected to prevent rate-limit bypass via backdating.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// In-process mutex for serializing write operations
// ---------------------------------------------------------------------------

class AsyncMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this.locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Shared mutex registries.
 *
 * Multiple EnforcingStore wrappers over the same backing store MUST
 * share a single mutex, otherwise concurrent callers using separate
 * wrappers can bypass limits via independent check-then-act sequences.
 *
 * Stores that implement storeIdentity (e.g., SQLite stores returning
 * the database filename) use a string-keyed Map so that independently
 * constructed store objects for the same database share a mutex.
 *
 * Stores without storeIdentity fall back to a WeakMap keyed by object
 * identity — safe only when a single wrapper exists per backing store.
 */
const namedMutexes = new Map<string, AsyncMutex>();
const anonymousMutexes = new WeakMap<object, AsyncMutex>();

function getMutexForStore(store: ContributionStore | ClaimStore): AsyncMutex {
  const identity = store.storeIdentity;
  if (identity !== undefined) {
    let mutex = namedMutexes.get(identity);
    if (mutex === undefined) {
      mutex = new AsyncMutex();
      namedMutexes.set(identity, mutex);
    }
    return mutex;
  }
  // Fallback: per-object identity
  let mutex = anonymousMutexes.get(store);
  if (mutex === undefined) {
    mutex = new AsyncMutex();
    anonymousMutexes.set(store, mutex);
  }
  return mutex;
}

// ---------------------------------------------------------------------------
// EnforcingContributionStore
// ---------------------------------------------------------------------------

/**
 * Wraps a ContributionStore with rate-limit and artifact-limit enforcement.
 *
 * All read operations delegate directly to the inner store.
 * Write operations (`put`, `putMany`) check the contract before delegating.
 * Writes are serialized via a mutex to prevent TOCTOU races.
 */
export class EnforcingContributionStore implements ContributionStore {
  private readonly inner: ContributionStore;
  private readonly cas: ContentStore | undefined;
  private readonly contract: GroveContract;
  private readonly clock: () => Date;
  private readonly writeMutex: AsyncMutex;

  /**
   * Per-request pre-write hooks, keyed by CID. Each contributeOperation sets
   * its own hook before calling put(). The hook runs inside the mutex then
   * is deleted — no shared mutable state, no race between concurrent requests.
   */
  private readonly preWriteHooks = new Map<string, (contribution: Contribution) => Promise<void>>();

  /** Register a pre-write hook for a specific contribution CID. */
  setPreWriteHook(cid: string, hook: (contribution: Contribution) => Promise<void>): void {
    this.preWriteHooks.set(cid, hook);
  }

  constructor(
    inner: ContributionStore,
    contract: GroveContract,
    options?: {
      cas?: ContentStore;
      clock?: () => Date;
    },
  ) {
    this.inner = inner;
    this.contract = contract;
    this.cas = options?.cas;
    this.clock = options?.clock ?? (() => new Date());
    this.writeMutex = getMutexForStore(inner);
  }

  put = async (contribution: Contribution): Promise<void> => {
    return this.writeMutex.runExclusive(async () => {
      // Idempotent: if CID already exists, skip enforcement and delegate (no-op)
      const existing = await this.inner.get(contribution.cid);
      if (existing !== undefined) {
        return this.inner.put(contribution);
      }

      await this.enforceContributionLimits(contribution, 0, []);
      // Run per-CID policy enforcement inside mutex (TOCTOU-safe, no shared state race)
      const hook = this.preWriteHooks.get(contribution.cid);
      if (hook) {
        this.preWriteHooks.delete(contribution.cid);
        await hook(contribution);
      }
      return await this.inner.put(contribution);
    });
  };

  putMany = async (contributions: readonly Contribution[]): Promise<void> => {
    return this.writeMutex.runExclusive(async () => {
      // Filter out already-existing CIDs and intra-batch duplicates.
      // Idempotent puts should not be rate-limited, and putMany([c, c])
      // must behave the same as put(c); put(c) — the second is a no-op.
      const uniqueByBatch = new Map<string, Contribution>();
      for (const c of contributions) {
        if (!uniqueByBatch.has(c.cid)) uniqueByBatch.set(c.cid, c);
      }

      // Batch existence check instead of per-item get()
      const uniqueCids = [...uniqueByBatch.keys()];
      const existingMap = await this.inner.getMany(uniqueCids);
      const newContributions: Contribution[] = [];
      for (const [cid, contribution] of uniqueByBatch) {
        if (!existingMap.has(cid)) {
          newContributions.push(contribution);
        }
      }

      // Enforce limits for new contributions only, tracking per-agent pending counts
      for (let i = 0; i < newContributions.length; i++) {
        const contribution = newContributions[i];
        if (contribution !== undefined) {
          const preceding = newContributions.slice(0, i);
          await this.enforceContributionLimits(contribution, i, preceding);
        }
      }

      return await this.inner.putMany(contributions);
    });
  };

  // Read operations — direct delegation
  get = (cid: string): Promise<Contribution | undefined> => this.inner.get(cid);
  getMany = (cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> =>
    this.inner.getMany(cids);
  list = (query?: ContributionQuery): Promise<readonly Contribution[]> => this.inner.list(query);
  children = (cid: string): Promise<readonly Contribution[]> => this.inner.children(cid);
  incomingSources = (targetCids: readonly string[]): Promise<readonly Contribution[]> =>
    this.inner.incomingSources(targetCids);
  ancestors = (cid: string): Promise<readonly Contribution[]> => this.inner.ancestors(cid);
  relationsOf = (cid: string, relationType?: RelationType): Promise<readonly Relation[]> =>
    this.inner.relationsOf(cid, relationType);
  relatedTo = (cid: string, relationType?: RelationType): Promise<readonly Contribution[]> =>
    this.inner.relatedTo(cid, relationType);
  search = (query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> =>
    this.inner.search(query, filters);
  findExisting = (
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> =>
    this.inner.findExisting(agentId, targetCid, kind, relationType);
  count = (query?: ContributionQuery): Promise<number> => this.inner.count(query);
  countSince = (query: { agentId?: string; since: string }): Promise<number> =>
    this.inner.countSince(query);
  thread = (
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> => this.inner.thread(rootCid, opts);
  replyCounts = (cids: readonly string[]): Promise<ReadonlyMap<string, number>> =>
    this.inner.replyCounts(cids);
  hotThreads = (
    opts?: import("./store.js").HotThreadsOptions,
  ): Promise<readonly import("./store.js").ThreadSummary[]> => this.inner.hotThreads(opts);
  close = (): void => this.inner.close();

  // ========================================================================
  // Private enforcement
  // ========================================================================

  private async enforceContributionLimits(
    contribution: Contribution,
    _batchIndex: number,
    precedingInBatch: readonly Contribution[],
  ): Promise<void> {
    const rl = this.contract.rateLimits;

    // Reject backdated / future-dated contributions to prevent rate-limit bypass.
    // Only enforced when rate limits are configured — without rate limits there is
    // no sliding window to game.
    if (rl !== undefined) {
      this.enforceClockSkew(contribution);
    }

    // Check per-agent rate limit
    if (rl?.maxContributionsPerAgentPerHour !== undefined) {
      const agentPendingCount = precedingInBatch.filter(
        (c) => c.agent.agentId === contribution.agent.agentId,
      ).length;
      await this.enforceAgentRateLimit(
        contribution.agent.agentId,
        rl.maxContributionsPerAgentPerHour,
        agentPendingCount,
      );
    }

    // Check per-grove rate limit
    if (rl?.maxContributionsPerGrovePerHour !== undefined) {
      await this.enforceGroveRateLimit(rl.maxContributionsPerGrovePerHour, precedingInBatch.length);
    }

    // Check artifact count
    if (rl?.maxArtifactsPerContribution !== undefined) {
      const artifactCount = Object.keys(contribution.artifacts).length;
      if (artifactCount > rl.maxArtifactsPerContribution) {
        throw new ArtifactLimitError({
          limitType: "count",
          current: artifactCount,
          limit: rl.maxArtifactsPerContribution,
        });
      }
    }

    // Check artifact sizes via CAS
    if (rl?.maxArtifactSizeBytes !== undefined && this.cas !== undefined) {
      for (const [name, contentHash] of Object.entries(contribution.artifacts)) {
        const stat = await this.cas.stat(contentHash);
        if (stat !== undefined && stat.sizeBytes > rl.maxArtifactSizeBytes) {
          throw new ArtifactLimitError({
            limitType: "size",
            current: stat.sizeBytes,
            limit: rl.maxArtifactSizeBytes,
            message: `Artifact '${name}' size ${stat.sizeBytes} bytes exceeds limit of ${rl.maxArtifactSizeBytes} bytes`,
          });
        }
      }
    }
  }

  /**
   * Reject contributions whose createdAt is more than MAX_CLOCK_SKEW_MS
   * away from "now" in either direction. Past-dated timestamps bypass the
   * sliding-window rate limit; future-dated timestamps poison the window
   * count for subsequent submissions.
   */
  private enforceClockSkew(contribution: Contribution): void {
    const now = this.clock();
    const createdAt = new Date(contribution.createdAt).getTime();
    const lowerBound = now.getTime() - MAX_CLOCK_SKEW_MS;
    const upperBound = now.getTime() + MAX_CLOCK_SKEW_MS;

    if (createdAt < lowerBound) {
      throw new RateLimitError({
        limitType: "per_agent",
        current: 0,
        limit: 0,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        retryAfterMs: 0,
        message: `Contribution createdAt ${contribution.createdAt} is too far in the past (max skew: ${MAX_CLOCK_SKEW_MS}ms)`,
      });
    }

    if (createdAt > upperBound) {
      throw new RateLimitError({
        limitType: "per_agent",
        current: 0,
        limit: 0,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        retryAfterMs: 0,
        message: `Contribution createdAt ${contribution.createdAt} is too far in the future (max skew: ${MAX_CLOCK_SKEW_MS}ms)`,
      });
    }
  }

  private async enforceAgentRateLimit(
    agentId: string,
    limit: number,
    pendingCount: number,
  ): Promise<void> {
    const now = this.clock();
    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_SECONDS * 1000);

    // Count contributions by this agent in the last hour using indexed query
    const storedCount = await this.inner.countSince({
      agentId,
      since: windowStart.toISOString(),
    });
    const count = storedCount + pendingCount;

    if (count >= limit) {
      // Fetch full list only when we need to compute retryAfterMs
      const recentContributions = await this.inner.list({ agentId });
      const retryAfterMs = this.computeRetryAfterMs(recentContributions, windowStart);
      throw new RateLimitError({
        limitType: "per_agent",
        current: count,
        limit,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        retryAfterMs,
      });
    }
  }

  private async enforceGroveRateLimit(limit: number, pendingCount: number): Promise<void> {
    const now = this.clock();
    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_SECONDS * 1000);

    // Count all contributions in the last hour using indexed query
    const storedCount = await this.inner.countSince({
      since: windowStart.toISOString(),
    });
    const count = storedCount + pendingCount;

    if (count >= limit) {
      // Fetch full list only when we need to compute retryAfterMs
      const allContributions = await this.inner.list();
      const retryAfterMs = this.computeRetryAfterMs(allContributions, windowStart);
      throw new RateLimitError({
        limitType: "per_grove",
        current: count,
        limit,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        retryAfterMs,
      });
    }
  }

  /**
   * Compute how long until a slot opens in the rate limit window.
   * Finds the oldest in-window contribution and calculates when it rolls out.
   */
  private computeRetryAfterMs(contributions: readonly Contribution[], windowStart: Date): number {
    const now = this.clock();
    const inWindow = contributions
      .filter((c) => new Date(c.createdAt).getTime() >= windowStart.getTime())
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const oldest = inWindow[0];
    if (oldest === undefined) return 0;

    const oldestTime = new Date(oldest.createdAt).getTime();
    const rolloutTime = oldestTime + RATE_LIMIT_WINDOW_SECONDS * 1000;
    return Math.max(0, rolloutTime - now.getTime());
  }
}

// ---------------------------------------------------------------------------
// EnforcingClaimStore
// ---------------------------------------------------------------------------

/**
 * Wraps a ClaimStore with concurrency-limit and lease-limit enforcement.
 *
 * All read operations delegate directly to the inner store.
 * `createClaim` checks concurrency and lease limits before delegating.
 * `heartbeat` enforces maxLeaseSeconds and honors defaultLeaseSeconds.
 * Write operations are serialized via a mutex to prevent TOCTOU races.
 */
export class EnforcingClaimStore implements ClaimStore {
  private readonly inner: ClaimStore;
  private readonly contract: GroveContract;
  private readonly writeMutex: AsyncMutex;

  constructor(inner: ClaimStore, contract: GroveContract) {
    this.inner = inner;
    this.contract = contract;
    this.writeMutex = getMutexForStore(inner);
  }

  createClaim = async (claim: Claim): Promise<Claim> => {
    return this.writeMutex.runExclusive(async () => {
      await this.enforceConcurrencyLimits(claim);
      this.enforceLeaseLimit(claim);
      return await this.inner.createClaim(claim);
    });
  };

  heartbeat = async (claimId: string, leaseDurationMs?: number): Promise<Claim> => {
    // Determine effective lease duration: caller > contract default > store default
    const contractDefaultMs =
      this.contract.execution?.defaultLeaseSeconds !== undefined
        ? this.contract.execution.defaultLeaseSeconds * 1000
        : undefined;
    const effectiveDurationMs = leaseDurationMs ?? contractDefaultMs;

    // Enforce max lease if configured
    const maxLeaseSeconds = this.contract.execution?.maxLeaseSeconds;
    if (maxLeaseSeconds !== undefined && effectiveDurationMs !== undefined) {
      const effectiveSeconds = effectiveDurationMs / 1000;
      if (effectiveSeconds > maxLeaseSeconds) {
        throw new LeaseViolationError({
          requestedSeconds: Math.ceil(effectiveSeconds),
          maxSeconds: maxLeaseSeconds,
        });
      }
    }

    return this.inner.heartbeat(claimId, effectiveDurationMs);
  };

  // claimOrRenew — enforced via mutex with concurrency + lease checks
  claimOrRenew = async (claim: Claim): Promise<Claim> => {
    return this.writeMutex.runExclusive(async () => {
      // Determine if this is a renewal (agent already has an active claim on the target)
      // or a new claim (no existing active claim by this agent on this target).
      const existingCount = await this.inner.countActiveClaims({
        targetRef: claim.targetRef,
        agentId: claim.agent.agentId,
      });

      if (existingCount === 0) {
        // New claim path: enforce concurrency limits (adding a new active claim)
        await this.enforceConcurrencyLimits(claim);
      }
      // Both paths: enforce lease limits
      this.enforceLeaseLimit(claim);

      return await this.inner.claimOrRenew(claim);
    });
  };

  // Read/mutation operations — direct delegation
  getClaim = (claimId: string): Promise<Claim | undefined> => this.inner.getClaim(claimId);
  release = (claimId: string): Promise<Claim> => this.inner.release(claimId);
  complete = (claimId: string): Promise<Claim> => this.inner.complete(claimId);
  expireStale = (options?: ExpireStaleOptions): Promise<readonly ExpiredClaim[]> =>
    this.inner.expireStale(options);
  activeClaims = (targetRef?: string): Promise<readonly Claim[]> =>
    this.inner.activeClaims(targetRef);
  listClaims = (query?: ClaimQuery): Promise<readonly Claim[]> => this.inner.listClaims(query);
  cleanCompleted = (retentionMs: number): Promise<number> => this.inner.cleanCompleted(retentionMs);
  countActiveClaims = (filter?: ActiveClaimFilter): Promise<number> =>
    this.inner.countActiveClaims(filter);
  detectStalled = (stallTimeoutMs: number): Promise<readonly Claim[]> =>
    this.inner.detectStalled(stallTimeoutMs);
  close = (): void => this.inner.close();

  // ========================================================================
  // Private enforcement
  // ========================================================================

  private async enforceConcurrencyLimits(claim: Claim): Promise<void> {
    const concurrency = this.contract.concurrency;
    if (concurrency === undefined) return;

    // Check global active claim limit
    if (concurrency.maxActiveClaims !== undefined) {
      const globalCount = await this.inner.countActiveClaims();
      if (globalCount >= concurrency.maxActiveClaims) {
        throw new ConcurrencyLimitError({
          limitType: "global",
          current: globalCount,
          limit: concurrency.maxActiveClaims,
        });
      }
    }

    // Check per-agent claim limit (0 means unlimited)
    if (concurrency.maxClaimsPerAgent !== undefined && concurrency.maxClaimsPerAgent > 0) {
      const agentCount = await this.inner.countActiveClaims({
        agentId: claim.agent.agentId,
      });
      if (agentCount >= concurrency.maxClaimsPerAgent) {
        throw new ConcurrencyLimitError({
          limitType: "per_agent",
          current: agentCount,
          limit: concurrency.maxClaimsPerAgent,
        });
      }
    }

    // Check per-target claim limit
    if (concurrency.maxClaimsPerTarget !== undefined) {
      const targetCount = await this.inner.countActiveClaims({
        targetRef: claim.targetRef,
      });
      if (targetCount >= concurrency.maxClaimsPerTarget) {
        throw new ConcurrencyLimitError({
          limitType: "per_target",
          current: targetCount,
          limit: concurrency.maxClaimsPerTarget,
        });
      }
    }
  }

  private enforceLeaseLimit(claim: Claim): void {
    const maxLeaseSeconds = this.contract.execution?.maxLeaseSeconds;
    if (maxLeaseSeconds === undefined) return;

    const leaseMs = new Date(claim.leaseExpiresAt).getTime() - new Date(claim.createdAt).getTime();
    const leaseSeconds = leaseMs / 1000;

    if (leaseSeconds > maxLeaseSeconds) {
      throw new LeaseViolationError({
        requestedSeconds: Math.ceil(leaseSeconds),
        maxSeconds: maxLeaseSeconds,
      });
    }
  }
}
