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
import type { WorkspaceInfo, WorkspaceManager } from "./workspace.js";
import { WorkspaceStatus } from "./workspace.js";

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
  /** Active workspaces with no corresponding active claim (orphaned). */
  readonly orphanedWorkspaces: readonly WorkspaceInfo[];
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

    // Step 2: Detect orphaned workspaces — active workspaces with no active claim.
    // This cross-references workspaces and claims rather than using idle-based
    // detection, which would incorrectly flag healthy long-lived workspaces and
    // miss recently-created orphans.
    const orphanedWorkspaces = await this.detectOrphanedWorkspaces();

    return { expiredClaims, orphanedWorkspaces };
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
        const claim = group[i];
        if (!claim) continue;
        try {
          await this.claimStore.release(claim.claimId);
          deduplicatedIds.push(claim.claimId);
        } catch {
          // Claim may have been released/expired concurrently — safe to ignore
        }
      }
    }

    return deduplicatedIds;
  }

  /**
   * Detect orphaned workspaces: active workspaces with no corresponding
   * active claim by the same agent on the same target (CID).
   *
   * Unlike idle-based `markStale()`, this cross-references workspace state
   * with claim state, so it correctly identifies:
   * - Recent orphans (active workspace, no claim) → detected
   * - Healthy long-lived workspaces (active workspace, active claim) → NOT flagged
   */
  private async detectOrphanedWorkspaces(): Promise<readonly WorkspaceInfo[]> {
    if (this.workspaceManager === undefined) return [];

    const activeWorkspaces = await this.workspaceManager.listWorkspaces({
      status: WorkspaceStatus.Active,
    });

    if (activeWorkspaces.length === 0) return [];

    // Build a set of active (targetRef, agentId) pairs from claims
    const allActiveClaims = await this.claimStore.activeClaims();
    const activeClaimKeys = new Set<string>();
    for (const claim of allActiveClaims) {
      activeClaimKeys.add(`${claim.targetRef}::${claim.agent.agentId}`);
    }

    // A workspace is orphaned if no active claim matches (cid, agentId)
    const orphaned: WorkspaceInfo[] = [];
    for (const ws of activeWorkspaces) {
      const key = `${ws.cid}::${ws.agent.agentId}`;
      if (!activeClaimKeys.has(key)) {
        // Mark orphaned workspace as stale so it's flagged for cleanup
        const staleWs = await this.workspaceManager?.markWorkspaceStale(ws.cid, ws.agent.agentId);
        orphaned.push(staleWs);
      }
    }

    return orphaned;
  }
}
