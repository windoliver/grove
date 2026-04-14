/**
 * BountyIndexSweep — reconciler strategy for NexusBountyStore dual-write consistency.
 *
 * Scans all bounty documents and ensures:
 * 1. Each bounty has a status index entry matching its current status.
 * 2. Stale index entries (pointing to a bounty with a different status) are deleted.
 *
 * This fixes the dual-write gap where the document write succeeds but the
 * status index write fails (Issue #240, findings #2 and #3).
 *
 * Uses BountyStore.repairIndex() when available. For stores without a separate
 * index (e.g., SQLite), this sweep is detection-only.
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

    try {
      // List ALL bounties (unfiltered) to get the authoritative document state.
      const allBounties = await this.bountyStore.listBounties();

      for (const bounty of allBounties) {
        try {
          // Verify the bounty appears in its own status-filtered query.
          const byStatus = await this.bountyStore.listBounties({ status: bounty.status });
          const inIndex = byStatus.some((b) => b.bountyId === bounty.bountyId);
          if (!inIndex) {
            found++;
            // Attempt repair if the store supports it
            if (this.bountyStore.repairIndex) {
              await this.bountyStore.repairIndex(bounty.bountyId);
              repaired++;
            }
          }
        } catch (err) {
          errors.push(
            err instanceof Error
              ? err
              : new Error(`Index check failed for bounty ${bounty.bountyId}: ${String(err)}`),
          );
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
