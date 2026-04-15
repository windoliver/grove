/**
 * FailingBountyStore — test wrapper that injects failures between internal
 * store steps to simulate dual-write partial failures.
 *
 * Wraps a real BountyStore and can be configured to fail after specific
 * operations, simulating the gap between document write and index write
 * in NexusBountyStore.
 *
 * Usage:
 *   const real = new SqliteBountyStore(db);
 *   const failing = new FailingBountyStore(real);
 *   failing.failOnNext("createBounty"); // next createBounty throws after real store commits
 *   await createBountyOperation(input, { bountyStore: failing, ... });
 */

import type { Bounty, RewardRecord } from "../bounty.js";
import type { BountyQuery, BountyStore, RewardQuery } from "../bounty-store.js";
import type { AgentIdentity } from "../models.js";

export class FailingBountyStore implements BountyStore {
  readonly storeIdentity: string | undefined;
  private readonly delegate: BountyStore;
  private failureTarget: string | undefined;
  private failureError: Error;

  constructor(delegate: BountyStore) {
    this.delegate = delegate;
    this.storeIdentity = delegate.storeIdentity;
    this.failureError = new Error("Simulated post-commit failure");
  }

  /**
   * Configure the next call to the named method to succeed internally
   * (the delegate commits the change) but throw to the caller, simulating
   * a failure AFTER the document write but BEFORE the caller sees success.
   */
  failOnNext(method: string, error?: Error): void {
    this.failureTarget = method;
    if (error) this.failureError = error;
  }

  /** Clear any pending failure configuration. */
  clearFailure(): void {
    this.failureTarget = undefined;
  }

  private async maybeFailAfter<T>(method: string, result: T): Promise<T> {
    if (this.failureTarget === method) {
      this.failureTarget = undefined; // one-shot
      throw this.failureError;
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Delegated methods with failure injection
  // -----------------------------------------------------------------------

  async createBounty(bounty: Bounty): Promise<Bounty> {
    const result = await this.delegate.createBounty(bounty);
    return this.maybeFailAfter("createBounty", result);
  }

  async getBounty(bountyId: string): Promise<Bounty | undefined> {
    return this.delegate.getBounty(bountyId);
  }

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    return this.delegate.listBounties(query);
  }

  async countBounties(query?: BountyQuery): Promise<number> {
    return this.delegate.countBounties(query);
  }

  async fundBounty(bountyId: string, reservationId: string): Promise<Bounty> {
    const result = await this.delegate.fundBounty(bountyId, reservationId);
    return this.maybeFailAfter("fundBounty", result);
  }

  async claimBounty(bountyId: string, claimedBy: AgentIdentity, claimId: string): Promise<Bounty> {
    const result = await this.delegate.claimBounty(bountyId, claimedBy, claimId);
    return this.maybeFailAfter("claimBounty", result);
  }

  async beginSettlement(bountyId: string, fulfilledByCid: string): Promise<Bounty> {
    const result = await this.delegate.beginSettlement(bountyId, fulfilledByCid);
    return this.maybeFailAfter("beginSettlement", result);
  }

  async completeBounty(bountyId: string, fulfilledByCid: string): Promise<Bounty> {
    const result = await this.delegate.completeBounty(bountyId, fulfilledByCid);
    return this.maybeFailAfter("completeBounty", result);
  }

  async settleBounty(bountyId: string): Promise<Bounty> {
    const result = await this.delegate.settleBounty(bountyId);
    return this.maybeFailAfter("settleBounty", result);
  }

  async expireBounty(bountyId: string): Promise<Bounty> {
    const result = await this.delegate.expireBounty(bountyId);
    return this.maybeFailAfter("expireBounty", result);
  }

  async cancelBounty(bountyId: string): Promise<Bounty> {
    const result = await this.delegate.cancelBounty(bountyId);
    return this.maybeFailAfter("cancelBounty", result);
  }

  async findExpiredBounties(): Promise<readonly Bounty[]> {
    return this.delegate.findExpiredBounties();
  }

  async recordReward(reward: RewardRecord): Promise<void> {
    return this.delegate.recordReward(reward);
  }

  async hasReward(rewardId: string): Promise<boolean> {
    return this.delegate.hasReward(rewardId);
  }

  async listRewards(query?: RewardQuery): Promise<readonly RewardRecord[]> {
    return this.delegate.listRewards(query);
  }

  async repairIndex(bountyId: string): Promise<void> {
    return this.delegate.repairIndex?.(bountyId);
  }

  async listIndexStatuses(bountyId: string): Promise<readonly string[]> {
    return this.delegate.listIndexStatuses?.(bountyId) ?? [];
  }

  close(): void {
    this.delegate.close();
  }
}
