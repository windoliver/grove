/**
 * BountyIndexSweep — reconciler strategy for NexusBountyStore dual-write consistency.
 *
 * Detection-based: for each bounty, compares the authoritative document status
 * against actual index entries using listIndexStatuses(). Calls repairIndex()
 * only when an inconsistency is found:
 * 1. Missing current-status index entry (new index write failed)
 * 2. Stale old-status index entry (old index delete failed)
 *
 * For stores without listIndexStatuses (e.g., SQLite), falls back to checking
 * whether the bounty appears in its status-filtered query result.
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

    if (!this.bountyStore.repairIndex) {
      return { strategy: this.name, found: 0, repaired: 0, errors: [] };
    }

    try {
      const allBounties = await this.bountyStore.listBounties();

      for (const bounty of allBounties) {
        try {
          let needsRepair = false;

          if (this.bountyStore.listIndexStatuses) {
            // Precise detection: check raw index entries directly
            const indexStatuses = await this.bountyStore.listIndexStatuses(bounty.bountyId);
            const hasCorrect = indexStatuses.includes(bounty.status);
            const hasStale = indexStatuses.some((s) => s !== bounty.status);
            needsRepair = !hasCorrect || hasStale;
          } else {
            // Fallback: check if bounty appears in its status-filtered query
            const byStatus = await this.bountyStore.listBounties({ status: bounty.status });
            needsRepair = !byStatus.some((b) => b.bountyId === bounty.bountyId);
          }

          if (needsRepair) {
            found++;
            await this.bountyStore.repairIndex?.(bounty.bountyId);
            repaired++;
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
