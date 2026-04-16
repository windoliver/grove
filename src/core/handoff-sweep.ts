/**
 * HandoffSweep — reconciler strategy for detecting orphaned contributions.
 *
 * Finds contributions that have zero handoff records where the contribution
 * kind normally generates handoffs (work, review, reproduction, adoption).
 * Reports them for operator attention.
 *
 * Detection-only: repair requires re-running the routing logic from the
 * topology/contract, which this sweep doesn't have access to. Full
 * auto-repair is a follow-up (tracked in Issue #240).
 *
 * Absorbs the handoff reconciler scope from Issue #227 → #240.
 */

import type { HandoffStore } from "./handoff.js";
import type { ContributionStore } from "./store.js";
import type { SweepResult, SweepStrategy } from "./sweep-reconciler.js";

/** Contribution kinds that normally generate handoff records. */
const HANDOFF_ELIGIBLE_KINDS = new Set(["work", "review", "reproduction", "adoption"]);

export class HandoffSweep implements SweepStrategy {
  readonly name = "HandoffSweep";
  private readonly contributionStore: ContributionStore;
  private readonly handoffStore: HandoffStore;

  constructor(contributionStore: ContributionStore, handoffStore: HandoffStore) {
    this.contributionStore = contributionStore;
    this.handoffStore = handoffStore;
  }

  async sweep(): Promise<SweepResult> {
    let found = 0;
    const errors: Error[] = [];

    try {
      // Scan recent contributions that should have handoffs
      const contributions = await this.contributionStore.list({ limit: 500 });
      const eligible = contributions.filter((c) => HANDOFF_ELIGIBLE_KINDS.has(c.kind));

      // Check each eligible contribution for any handoff records
      const handoffs = await this.handoffStore.list();
      const cidsWithHandoffs = new Set(handoffs.map((h) => h.sourceCid));

      for (const contribution of eligible) {
        if (!cidsWithHandoffs.has(contribution.cid)) {
          found++;
        }
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err : new Error(`HandoffSweep scan failed: ${String(err)}`),
      );
    }

    // Detection-only: repaired is always 0. Operator acts on found > 0.
    return { strategy: this.name, found, repaired: 0, errors };
  }
}
