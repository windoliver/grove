/**
 * BountyIndexSweep — reconciler strategy for NexusBountyStore dual-write consistency.
 *
 * Scans all bounty documents and calls repairIndex() for each one.
 * repairIndex() ensures the correct status index entry exists AND deletes
 * stale entries for other statuses. This covers both failure modes:
 * 1. Missing current-status index (new index write failed)
 * 2. Stale old-status index (old index delete failed)
 *
 * For stores without a separate index (e.g., SQLite), repairIndex is
 * undefined and this sweep is a no-op.
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
    let repaired = 0;
    const errors: Error[] = [];

    // Skip entirely if the store has no index to repair
    if (!this.bountyStore.repairIndex) {
      return { strategy: this.name, found: 0, repaired: 0, errors: [] };
    }

    try {
      const allBounties = await this.bountyStore.listBounties();

      for (const bounty of allBounties) {
        try {
          // repairIndex ensures the correct status index entry exists and
          // deletes stale entries for all other statuses. Idempotent.
          await this.bountyStore.repairIndex(bounty.bountyId);
          repaired++;
        } catch (err) {
          errors.push(
            err instanceof Error
              ? err
              : new Error(`Index repair failed for bounty ${bounty.bountyId}: ${String(err)}`),
          );
        }
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err : new Error(`BountyIndexSweep failed: ${String(err)}`),
      );
    }

    // "found" = total bounties scanned (all repaired unconditionally)
    return { strategy: this.name, found: repaired, repaired, errors };
  }
}
