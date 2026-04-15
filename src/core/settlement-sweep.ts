/**
 * SettlementSweep — reconciler strategy for resuming stalled bounty settlements.
 *
 * Finds bounties stuck in "pending_settlement" (the saga pivot state) and
 * attempts to resume them: capture credits (idempotent), then advance through
 * completed → settled.
 *
 * This handles the case where the client crashed after the pivot transition
 * but before completing the settle flow (Issue #240, finding #1).
 */

import type { Bounty, BountyStatus } from "./bounty.js";
import type { BountyStore } from "./bounty-store.js";
import type { CreditsService } from "./credits.js";
import type { SweepResult, SweepStrategy } from "./sweep-reconciler.js";

export class SettlementSweep implements SweepStrategy {
  readonly name = "SettlementSweep";
  private readonly bountyStore: BountyStore;
  private readonly creditsService: CreditsService | undefined;

  constructor(bountyStore: BountyStore, creditsService?: CreditsService) {
    this.bountyStore = bountyStore;
    this.creditsService = creditsService;
  }

  async sweep(): Promise<SweepResult> {
    let found = 0;
    let repaired = 0;
    const errors: Error[] = [];

    try {
      // Scan both pending_settlement AND completed bounties that have a
      // fulfilledByCid — the latter covers the case where capture succeeded
      // and completeBounty committed but settleBounty failed.
      const pending = await this.bountyStore.listBounties({
        status: "pending_settlement" as BountyStatus,
      });
      const completed = await this.bountyStore.listBounties({
        status: "completed" as BountyStatus,
      });
      // Only resume completed bounties that have a fulfillment CID
      // (indicating they were mid-settlement, not just manually completed).
      const stalled = [...pending, ...completed.filter((b) => b.fulfilledByCid)];
      found = stalled.length;

      for (const bounty of stalled) {
        try {
          await this.resumeSettlement(bounty);
          repaired++;
        } catch (err) {
          errors.push(
            err instanceof Error
              ? err
              : new Error(`Settlement resume failed for ${bounty.bountyId}: ${String(err)}`),
          );
        }
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err : new Error(`SettlementSweep scan failed: ${String(err)}`),
      );
    }

    return { strategy: this.name, found, repaired, errors };
  }

  /**
   * Resume a stalled settlement. Idempotent — safe to call multiple times.
   *
   * Handles both pending_settlement (pre-capture) and completed (post-capture).
   */
  private async resumeSettlement(bounty: Bounty): Promise<void> {
    // Capture credits if escrow is active (idempotent — already-captured is a no-op)
    if (this.creditsService && bounty.reservationId) {
      if (bounty.claimedBy) {
        await this.creditsService.capture(bounty.reservationId, {
          toAgentId: bounty.claimedBy.agentId,
        });
      } else {
        await this.creditsService.capture(bounty.reservationId);
      }
    }

    // Advance through remaining states (skip steps already done)
    if (bounty.status !== "completed") {
      await this.bountyStore.completeBounty(bounty.bountyId, bounty.fulfilledByCid ?? "");
    }
    await this.bountyStore.settleBounty(bounty.bountyId);
  }
}
