/**
 * Spawn manager — encapsulates the spawn/kill lifecycle so it can be
 * tested independently of React components.
 *
 * Manages: workspace checkout → claim creation → tmux session → heartbeat loop.
 * On kill: stop heartbeat → release claim → clean workspace.
 * On tmux failure: roll back claim + workspace.
 */

import type { AgentIdentity, Claim } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { SpawnOptions, TmuxManager } from "./agents/tmux-manager.js";
import { agentIdFromSession } from "./agents/tmux-manager.js";
import type { TuiDataProvider } from "./provider.js";
import type { PersistedSpawnRecord, SessionStore } from "./session-store.js";

/** Lease duration for TUI-spawned agent claims. */
const LEASE_DURATION_MS = 300_000; // 5 minutes

/** Heartbeat interval: renew at ~40% of lease duration. */
const HEARTBEAT_INTERVAL_MS = 120_000; // 2 minutes

/** PR context injected as env vars when spawning agents. */
export interface PrContext {
  readonly number: number;
  readonly title: string;
  readonly filesChanged: number;
}

/** Tracked state for a spawned agent. */
interface SpawnRecord {
  readonly claimId: string;
  readonly targetRef: string;
  readonly agentId: string;
}

/** Result of a spawn attempt. */
export interface SpawnResult {
  readonly spawnId: string;
  readonly claimId: string;
  readonly workspacePath: string;
}

/**
 * Manages the full spawn/kill lifecycle for TUI-spawned agents.
 *
 * Testable without React — timer setup/teardown and failure rollback
 * are exercised directly.
 */
export class SpawnManager {
  private readonly provider: TuiDataProvider;
  private readonly tmux: TmuxManager | undefined;
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly spawnRecords = new Map<string, SpawnRecord>();
  private readonly onError: (message: string) => void;
  private readonly sessionStore: SessionStore | undefined;
  private prContext: PrContext | undefined;

  /** Overridable heartbeat interval for testing. */
  heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS;

  constructor(
    provider: TuiDataProvider,
    tmux: TmuxManager | undefined,
    onError: (message: string) => void,
    sessionStore?: SessionStore,
  ) {
    this.provider = provider;
    this.tmux = tmux;
    this.onError = onError;
    this.sessionStore = sessionStore;
  }

  /**
   * Set PR context to inject into spawned agent environments.
   * When set, GROVE_PR_NUMBER, GROVE_PR_TITLE, and GROVE_PR_FILES
   * are passed as environment variables via the spawn options.
   */
  setPrContext(ctx: PrContext | undefined): void {
    this.prContext = ctx;
  }

  /** Get the current PR context (for testing). */
  getPrContext(): PrContext | undefined {
    return this.prContext;
  }

  /**
   * Spawn a new agent session.
   *
   * Lifecycle: workspace checkout → claim → tmux session → heartbeat.
   * On failure at any step, all previously-created state is rolled back.
   */
  async spawn(
    roleId: string,
    command: string,
    parentAgentId?: string,
    depth = 0,
    context?: Record<string, unknown>,
  ): Promise<SpawnResult> {
    const spawnId = `${roleId}-${Date.now().toString(36)}`;
    const agent: AgentIdentity = {
      agentId: spawnId,
      ...(roleId !== spawnId ? { role: roleId } : {}),
    };

    // Step 1: Checkout isolated workspace.
    let workspacePath: string;
    if (this.provider.checkoutWorkspace) {
      workspacePath = await this.provider.checkoutWorkspace(spawnId, agent);
    } else {
      throw new Error("Provider does not support workspace checkout");
    }

    // Step 2: Create claim.
    let claim: Claim | undefined;
    if (this.provider.createClaim) {
      claim = await this.provider.createClaim({
        targetRef: spawnId,
        agent,
        intentSummary: `TUI-spawned: ${command}`,
        leaseDurationMs: LEASE_DURATION_MS,
        context: {
          tuiSpawned: true,
          spawnId,
          workspacePath,
          ...(parentAgentId !== undefined ? { parentAgentId, depth } : {}),
          ...context,
        },
      });
    }

    // Step 3: Start tmux session. Roll back on failure.
    // If PR context is available, pass GROVE_PR_* as env vars
    // so the agent process sees them from the start.
    try {
      const prEnv: Record<string, string> | undefined = this.prContext
        ? {
            GROVE_PR_NUMBER: String(this.prContext.number),
            GROVE_PR_TITLE: this.prContext.title,
            GROVE_PR_FILES: String(this.prContext.filesChanged),
          }
        : undefined;

      const options: SpawnOptions = {
        agentId: spawnId,
        command,
        targetRef: spawnId,
        workspacePath,
        ...(prEnv ? { env: prEnv } : {}),
      };
      await this.tmux?.spawn(options);
    } catch (spawnErr) {
      // Roll back claim + workspace
      if (claim && this.provider.releaseClaim) {
        await safeCleanup(
          this.provider.releaseClaim(claim.claimId),
          "rollback claim after spawn failure",
          { silent: true },
        );
      }
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(spawnId, spawnId),
          "rollback workspace after spawn failure",
          { silent: true },
        );
      }
      throw spawnErr;
    }

    // Step 4: Start heartbeat + record tracking info.
    if (claim) {
      this.startHeartbeat(claim.claimId);
      this.spawnRecords.set(spawnId, {
        claimId: claim.claimId,
        targetRef: spawnId,
        agentId: spawnId,
      });

      // Step 5: Persist spawn record to session store for crash recovery.
      this.sessionStore?.save({
        spawnId,
        claimId: claim.claimId,
        targetRef: spawnId,
        agentId: spawnId,
        workspacePath,
        spawnedAt: new Date().toISOString(),
      });
    }

    return {
      spawnId,
      claimId: claim?.claimId ?? "",
      workspacePath,
    };
  }

  /**
   * Kill a tmux session and clean up all associated state.
   *
   * Uses local spawn records so cleanup works even if the claim's
   * lease has expired (no longer returned by active claim queries).
   */
  async kill(sessionName: string): Promise<void> {
    // Step 1: Kill tmux session
    await this.tmux?.kill(sessionName);

    // Step 2: Look up from local records
    const killedAgentId = agentIdFromSession(sessionName);
    if (!killedAgentId) return;

    const tracked = this.spawnRecords.get(killedAgentId);
    if (tracked) {
      this.stopHeartbeat(tracked.claimId);
      this.spawnRecords.delete(killedAgentId);
      this.sessionStore?.remove(killedAgentId);

      if (this.provider.releaseClaim) {
        await safeCleanup(
          this.provider.releaseClaim(tracked.claimId),
          "release claim during kill",
          {
            silent: true,
          },
        );
      }
      if (this.provider.cleanWorkspace) {
        await safeCleanup(
          this.provider.cleanWorkspace(tracked.targetRef, killedAgentId),
          "clean workspace during kill",
          { silent: true },
        );
      }
      return;
    }

    // Fallback: query active claims
    const claims = await this.provider.getClaims({ agentId: killedAgentId, status: "active" });
    for (const claim of claims) {
      if (claim.agent.agentId === killedAgentId) {
        this.stopHeartbeat(claim.claimId);
        if (this.provider.releaseClaim) {
          await this.provider.releaseClaim(claim.claimId);
        }
        if (this.provider.cleanWorkspace) {
          await this.provider.cleanWorkspace(claim.targetRef, killedAgentId);
        }
      }
    }
  }

  /** Whether a heartbeat timer is running for the given claimId. */
  hasHeartbeat(claimId: string): boolean {
    return this.heartbeatTimers.has(claimId);
  }

  /** Get the spawn record for an agentId (for testing). */
  getSpawnRecord(agentId: string): SpawnRecord | undefined {
    return this.spawnRecords.get(agentId);
  }

  /**
   * Reconcile persisted session state with live tmux sessions.
   *
   * Called on TUI startup to recover from crashes. Uses two data sources:
   * 1. Local file store (.grove/tui-sessions.json) — fast, survives crashes
   * 2. Claim store (SQLite/Nexus) — authoritative, survives machine migration
   *
   * For each persisted record:
   * - Live tmux session → reattach (restore in-memory state + restart heartbeat)
   * - Dead tmux session → release claim + clean workspace + remove record
   */
  async reconcile(): Promise<{ reattached: number; released: number }> {
    // Collect records from local file store
    const fileRecords = this.sessionStore?.loadAll() ?? [];

    // Also query claims with tuiSpawned context as Nexus-backed fallback.
    // This catches records that survive across machines or when the local
    // file store is lost (e.g., different checkout, wiped .grove).
    const claimRecords = await this.loadRecordsFromClaims();

    // Merge: file records take precedence (more fields), claim records fill gaps
    const seen = new Set<string>();
    const allRecords: PersistedSpawnRecord[] = [];
    for (const r of fileRecords) {
      seen.add(r.spawnId);
      allRecords.push(r);
    }
    for (const r of claimRecords) {
      if (!seen.has(r.spawnId)) {
        allRecords.push(r);
      }
    }

    if (allRecords.length === 0) return { reattached: 0, released: 0 };

    // Get live tmux sessions
    const liveSessions = (await this.tmux?.listSessions()) ?? [];
    const liveSet = new Set(liveSessions);

    let reattached = 0;
    let released = 0;

    for (const record of allRecords) {
      const tmuxName = `grove-${record.spawnId}`;
      if (liveSet.has(tmuxName)) {
        // Re-attach: restore in-memory state + restart heartbeat
        this.spawnRecords.set(record.spawnId, {
          claimId: record.claimId,
          targetRef: record.targetRef,
          agentId: record.agentId,
        });
        this.startHeartbeat(record.claimId);
        reattached++;
      } else {
        // Dead session: release claim + clean workspace + remove record
        if (this.provider.releaseClaim) {
          await safeCleanup(
            this.provider.releaseClaim(record.claimId),
            `release orphaned claim ${record.claimId}`,
            { silent: true },
          );
        }
        if (this.provider.cleanWorkspace) {
          await safeCleanup(
            this.provider.cleanWorkspace(record.targetRef, record.agentId),
            `clean orphaned workspace for ${record.spawnId}`,
            { silent: true },
          );
        }
        this.sessionStore?.remove(record.spawnId);
        released++;
      }
    }

    return { reattached, released };
  }

  /**
   * Query active claims with `tuiSpawned: true` context and convert to
   * PersistedSpawnRecords. This is the Nexus-backed recovery path.
   */
  private async loadRecordsFromClaims(): Promise<readonly PersistedSpawnRecord[]> {
    try {
      const claims = await this.provider.getClaims({ status: "active" });
      const records: PersistedSpawnRecord[] = [];
      for (const claim of claims) {
        const ctx = claim.context as Record<string, unknown> | undefined;
        if (ctx?.tuiSpawned === true && typeof ctx.spawnId === "string") {
          records.push({
            spawnId: ctx.spawnId as string,
            claimId: claim.claimId,
            targetRef: claim.targetRef,
            agentId: claim.agent.agentId,
            workspacePath:
              typeof ctx.workspacePath === "string" ? (ctx.workspacePath as string) : "",
            spawnedAt: claim.createdAt,
          });
        }
      }
      return records;
    } catch {
      // Claims query may fail (e.g., Nexus unreachable) — degrade gracefully
      return [];
    }
  }

  /** Stop all timers and clear state. */
  destroy(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    this.spawnRecords.clear();
  }

  private startHeartbeat(claimId: string): void {
    if (!this.provider.heartbeatClaim) return;
    const heartbeatFn = this.provider.heartbeatClaim.bind(this.provider);
    const timer = setInterval(() => {
      heartbeatFn(claimId, LEASE_DURATION_MS).catch((err) => {
        const msg = err instanceof Error ? err.message : "Heartbeat failed";
        this.onError(`Heartbeat for ${claimId.slice(0, 8)}: ${msg}`);
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimers.set(claimId, timer);
  }

  private stopHeartbeat(claimId: string): void {
    const timer = this.heartbeatTimers.get(claimId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatTimers.delete(claimId);
    }
  }
}
