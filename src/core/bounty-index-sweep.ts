/**
 * BountyIndexSweep — reconciler strategy for NexusBountyStore dual-write consistency.
 *
 * Detection-based: for each bounty, checks whether it appears in its
 * status-filtered query result. Only calls repairIndex() when an actual
 * inconsistency is found (missing current-status entry or stale old-status
 * marker). Does NOT rewrite healthy indexes, avoiding unnecessary VFS
 * pressure under Nexus rate limits.
 *
 * For stores without a separate index (e.g., SQLite), this sweep is a no-op.
 */

import type { BountyStore } from "./bounty-store.js";
import type { SweepResult, SweepStrategy } from "./sweep-reconciler.js";

export class BountyIndexSweep implements SweepStrategy {
  readonly name = "BountyIndexSweep";
  private readonly bountyStore: BountyStore;

  constructor(bountyStore: BountyStore) {
    this.bountyStore = bountyStore;
  }

  async sweep(): Promise<SweepResult> {
    let found = 0;
    let repaired = 0;
    const errors: Error[] = [];

    // Skip entirely if the store has no index to repair
    if (!this.bountyStore.repairIndex) {
      return { strategy: this.name, found: 0, repaired: 0, errors: [] };
    }

    try {
      // Unfiltered list gives us the authoritative document state.
      const allBounties = await this.bountyStore.listBounties();

      // Build a set of bountyIds per status from status-filtered queries
      // to detect both missing entries and stale entries.
      const statusSets = new Map<string, Set<string>>();
      for (const bounty of allBounties) {
        if (!statusSets.has(bounty.status)) {
          const byStatus = await this.bountyStore.listBounties({ status: bounty.status });
          statusSets.set(bounty.status, new Set(byStatus.map((b) => b.bountyId)));
        }
      }

      for (const bounty of allBounties) {
        const inCorrectIndex = statusSets.get(bounty.status)?.has(bounty.bountyId) ?? false;
        if (!inCorrectIndex) {
          // Missing from the correct status index — needs repair
          found++;
          try {
            await this.bountyStore.repairIndex!(bounty.bountyId);
            repaired++;
          } catch (err) {
            errors.push(
              err instanceof Error
                ? err
                : new Error(`Index repair failed for bounty ${bounty.bountyId}: ${String(err)}`),
            );
          }
        }
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err : new Error(`BountyIndexSweep failed: ${String(err)}`),
      );
    }

    return { strategy: this.name, found, repaired, errors };
  }
}
