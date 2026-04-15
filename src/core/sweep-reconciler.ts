/**
 * Unified sweep reconciler with pluggable strategies.
 *
 * Runs registered SweepStrategy instances on a shared timer. Each strategy
 * independently scans a store for inconsistencies and repairs them using
 * idempotent writes. Strategies run sequentially within a cycle to avoid
 * contention on shared stores.
 *
 * Distinct from the claim/workspace Reconciler in reconciler.ts — this
 * framework handles bounty-store atomicity, handoff orphans, and settlement
 * resumption.
 *
 * Usage:
 *   const sr = new SweepReconciler({ intervalMs: 60_000 });
 *   sr.register(new BountyIndexSweep(bountyStore));
 *   sr.register(new SettlementSweep(bountyStore, creditsService));
 *   sr.start();
 *   // later:
 *   sr.stop();
 */

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

/** Result of a single sweep execution. */
export interface SweepResult {
  /** Strategy name (for logging). */
  readonly strategy: string;
  /** Number of inconsistencies found. */
  readonly found: number;
  /** Number of inconsistencies repaired. */
  readonly repaired: number;
  /** Errors encountered during sweep (non-fatal). */
  readonly errors: readonly Error[];
}

/**
 * A sweep strategy that scans for and repairs a specific class of
 * inconsistency. Strategies must be idempotent — running the same
 * sweep twice with no intervening changes should be a no-op.
 */
export interface SweepStrategy {
  /** Human-readable name for logging. */
  readonly name: string;

  /**
   * Execute the sweep. Returns a summary of what was found and repaired.
   * Must not throw — errors should be collected in the result.
   */
  sweep(): Promise<SweepResult>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for the sweep reconciler. */
export interface SweepReconcilerConfig {
  /** Interval between sweep cycles in milliseconds. Default: 60_000 (1 minute). */
  readonly intervalMs?: number | undefined;

  /**
   * Called after each sweep cycle with results from all strategies.
   * Use for logging, monitoring, or alerting.
   */
  readonly onCycle?: (results: readonly SweepResult[]) => void;

  /**
   * Called when the reconciler encounters an unexpected error
   * (not from individual strategy sweeps, which report their own errors).
   */
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// SweepReconciler
// ---------------------------------------------------------------------------

/**
 * Periodic sweep reconciler.
 *
 * Strategies are executed sequentially per cycle. Each strategy must
 * handle its own errors and report them in the SweepResult. An
 * unhandled throw from a strategy is caught and reported via onError.
 */
export class SweepReconciler {
  private readonly strategies: SweepStrategy[] = [];
  private readonly intervalMs: number;
  private readonly onCycle?: (results: readonly SweepResult[]) => void;
  private readonly onError?: (error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private cycleInFlight = false;

  constructor(config?: SweepReconcilerConfig) {
    this.intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onCycle = config?.onCycle;
    this.onError = config?.onError;
  }

  /** Register a sweep strategy. Must be called before start(). */
  register(strategy: SweepStrategy): void {
    this.strategies.push(strategy);
  }

  /** Start the reconciler timer. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
  }

  /** Stop the reconciler timer and cancel any pending cycle. */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one sweep cycle immediately (useful for testing or on-demand).
   * Serialized: if a cycle is already in flight, returns empty results.
   */
  async runCycle(): Promise<readonly SweepResult[]> {
    if (this.cycleInFlight) return [];
    this.cycleInFlight = true;
    try {
      const results: SweepResult[] = [];
      for (const strategy of this.strategies) {
        try {
          const result = await strategy.sweep();
          results.push(result);
        } catch (err) {
          // Strategy.sweep() should not throw, but guard against it
          results.push({
            strategy: strategy.name,
            found: 0,
            repaired: 0,
            errors: [err instanceof Error ? err : new Error(String(err))],
          });
          this.onError?.(err);
        }
      }
      this.onCycle?.(results);
      return results;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** Whether the reconciler is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Number of registered strategies. */
  get strategyCount(): number {
    return this.strategies.length;
  }
}
