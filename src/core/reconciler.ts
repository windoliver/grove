/**
 * Reconciliation protocol for Grove.
 *
 * Implements the "reconcile before dispatch" pattern (Symphony §16.1):
 * expire stale claims, detect duplicate active claims, clean completed
 * claims, and flag orphaned workspaces — all before frontier computation
 * or new work dispatch.
 *
 * The Reconciler is a composed behavior over ClaimStore, ContributionStore,
 * and WorkspaceManager. It does not own these resources — callers provide
 * them and manage their lifecycles.
 */

import type { ClaimStore, ExpiredClaim } from "./store.js";
import type { WorkspaceManager, StaleOptions } from "./workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a reconciliation sweep. */
export interface ReconcileResult {
  /** Claims expired due to lease expiry or stall detection. */
  readonly expiredClaims: readonly ExpiredClaim[];
  /** Claims expired because another claim by the same agent on the same target was newer. */
  readonly deduplicatedClaims: readonly string[];
  /** Number of terminal claims cleaned up (deleted). */
  readonly cleanedCount: number;
}

/** Result of a startup reconciliation sweep. */
export interface StartupReconcileResult {
  /** Claims expired during startup. */
  readonly expiredClaims: readonly ExpiredClaim[];
  /** Workspaces flagged as stale (no active claim). */
  readonly staleWorkspaceCount: number;
}

/** Configuration for reconciliation behavior. */
export interface ReconcilerConfig {
  /**
   * Stall threshold in milliseconds. Claims whose heartbeat_at is older
   * than `now - stallThresholdMs` are expired even if their lease hasn't
   * ended. Detects dead agents that set long leases.
   *
   * Default: undefined (no stall detection, only lease-based expiry).
   */
  readonly stallThresholdMs?: number | undefined;

  /**
   * Retention period for terminal claims (completed, expired, released).
   * Claims older than this are deleted during reconciliation.
   *
   * Default: 7 days (604_800_000 ms).
   */
  readonly retentionMs?: number | undefined;

  /**
   * Maximum idle time for workspaces before they are flagged as stale
   * during startup reconciliation.
   *
   * Default: 1 hour (3_600_000 ms).
   */
  readonly workspaceMaxIdleMs?: number | undefined;
}

/** Protocol for reconciliation. */
export interface Reconciler {
  /**
   * Run a full reconciliation sweep.
   *
   * Steps (in order):
   * 1. Expire stale claims (lease expired + stall detection)
   * 2. Deduplicate active claims (same agent, same target → keep newest)
   * 3. Clean terminal claims past retention period
   */
  reconcile(): Promise<ReconcileResult>;

  /**
   * Run startup-specific reconciliation.
   *
   * Called once when the system initializes. Steps:
   * 1. Expire all claims past their lease
   * 2. Flag orphaned workspaces (active workspace but no active claim)
   */
  startupReconcile(): Promise<StartupReconcileResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default retention period: 7 days. */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default workspace idle threshold: 1 hour. */
const DEFAULT_WORKSPACE_MAX_IDLE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// DefaultReconciler
// ---------------------------------------------------------------------------

/**
 * Concrete reconciler backed by ClaimStore and optional WorkspaceManager.
 *
 * Follows the Kubernetes controller pattern: level-triggered, idempotent,
 * and safe to call concurrently (all mutations use atomic SQL operations).
 */
export class DefaultReconciler implements Reconciler {
  private readonly claimStore: ClaimStore;
  private readonly workspaceManager: WorkspaceManager | undefined;
  private readonly config: {
    readonly stallThresholdMs: number | undefined;
    readonly retentionMs: number;
    readonly workspaceMaxIdleMs: number;
  };

  constructor(
    claimStore: ClaimStore,
    workspaceManager?: WorkspaceManager,
    config?: ReconcilerConfig,
  ) {
    this.claimStore = claimStore;
    this.workspaceManager = workspaceManager;
    this.config = {
      stallThresholdMs: config?.stallThresholdMs,
      retentionMs: config?.retentionMs ?? DEFAULT_RETENTION_MS,
      workspaceMaxIdleMs: config?.workspaceMaxIdleMs ?? DEFAULT_WORKSPACE_MAX_IDLE_MS,
    };
  }

  async reconcile(): Promise<ReconcileResult> {
    // Step 1: Expire stale claims (lease + stall detection)
    const expiredClaims = await this.claimStore.expireStale({
      stallThresholdMs: this.config.stallThresholdMs,
    });

    // Step 2: Deduplicate active claims (same agent, same target)
    const deduplicatedClaims = await this.deduplicateActiveClaims();

    // Step 3: Clean terminal claims past retention
    const cleanedCount = await this.claimStore.cleanCompleted(this.config.retentionMs);

    return { expiredClaims, deduplicatedClaims, cleanedCount };
  }

  async startupReconcile(): Promise<StartupReconcileResult> {
    // Step 1: Expire all claims past their lease (no stall detection on startup —
    // we don't know how long the system was down, so only use hard lease expiry)
    const expiredClaims = await this.claimStore.expireStale();

    // Step 2: Flag orphaned workspaces
    let staleWorkspaceCount = 0;
    if (this.workspaceManager !== undefined) {
      const staleOptions: StaleOptions = { maxIdleMs: this.config.workspaceMaxIdleMs };
      const staleWorkspaces = await this.workspaceManager.markStale(staleOptions);
      staleWorkspaceCount = staleWorkspaces.length;
    }

    return { expiredClaims, staleWorkspaceCount };
  }

  /**
   * Find and expire duplicate active claims: same agent on same target.
   *
   * If an agent has multiple active claims on the same target (shouldn't
   * happen with claimOrRenew, but possible with direct createClaim calls
   * or race conditions), keep the most recent and expire the rest.
   *
   * Returns the claim IDs that were expired.
   */
  private async deduplicateActiveClaims(): Promise<readonly string[]> {
    const allActive = await this.claimStore.activeClaims();

    // Group by (agentId, targetRef)
    const groups = new Map<string, { claimId: string; createdAt: string }[]>();
    for (const claim of allActive) {
      const key = `${claim.agent.agentId}::${claim.targetRef}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = [];
        groups.set(key, group);
      }
      group.push({ claimId: claim.claimId, createdAt: claim.createdAt });
    }

    // For groups with >1 claim, keep newest, release rest
    const deduplicatedIds: string[] = [];
    for (const group of groups.values()) {
      if (group.length <= 1) continue;

      // Sort by createdAt descending — keep first (newest)
      group.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));

      for (let i = 1; i < group.length; i++) {
        try {
          await this.claimStore.release(group[i]!.claimId);
          deduplicatedIds.push(group[i]!.claimId);
        } catch {
          // Claim may have been released/expired concurrently — safe to ignore
        }
      }
    }

    return deduplicatedIds;
  }
}
