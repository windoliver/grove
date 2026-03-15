/**
 * Nexus-backed BountyStore adapter.
 *
 * Stores bounty records as JSON files in the Nexus VFS with
 * status index markers for efficient filtered listing.
 *
 * Storage layout:
 * - Bounties:       /zones/{zoneId}/bounties/{bountyId}.json
 * - Status index:   /zones/{zoneId}/indexes/bounties/status/{status}/{bountyId}
 */

import type { Bounty, BountyStatus, RewardRecord } from "../core/bounty.js";
import type { BountyQuery, BountyStore, RewardQuery } from "../core/bounty-store.js";
import { NotFoundError } from "../core/errors.js";
import type { AgentIdentity } from "../core/models.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import { batchParallel } from "./batch.js";
import type { ListEntry, ListOptions, NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  bountiesDir,
  bountyPath,
  bountyStatusIndexDir,
  bountyStatusIndexPath,
  decodeSegment,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBounty(bounty: Bounty): Uint8Array {
  return encoder.encode(JSON.stringify(bounty));
}

function decodeBounty(data: Uint8Array): Bounty {
  return JSON.parse(decoder.decode(data)) as Bounty;
}

/**
 * Nexus-backed BountyStore.
 *
 * Implements the BountyStore interface using the Nexus VFS for
 * persistence. Follows the same patterns as NexusOutcomeStore:
 * resolveConfig, Semaphore, retry with backoff, mapNexusError.
 */
export class NexusBountyStore implements BountyStore {
  readonly storeIdentity: string;
  private readonly client: NexusClient;
  private readonly config: ResolvedNexusConfig;
  private readonly semaphore: Semaphore;
  private readonly zoneId: string;

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.storeIdentity = `nexus:${this.zoneId}:bounties`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
  }

  async createBounty(bounty: Bounty): Promise<Bounty> {
    const now = new Date().toISOString();
    const created: Bounty = {
      ...bounty,
      createdAt: bounty.createdAt || now,
      updatedAt: now,
    };

    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(bountyPath(this.zoneId, bounty.bountyId), encodeBounty(created)),
        ),
      "createBounty",
      this.config,
    );

    await this.writeStatusIndex(created);
    return created;
  }

  async getBounty(bountyId: string): Promise<Bounty | undefined> {
    const data = await withRetry(
      () =>
        withSemaphore(this.semaphore, () => this.client.read(bountyPath(this.zoneId, bountyId))),
      "getBounty",
      this.config,
    );
    if (data === undefined) return undefined;
    return decodeBounty(data);
  }

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    let entries: readonly ListEntry[];

    if (query?.status !== undefined && typeof query.status === "string") {
      const dir = bountyStatusIndexDir(this.zoneId, query.status);
      entries = await this.listAllPages(dir);
    } else {
      const dir = bountiesDir(this.zoneId);
      entries = await this.listAllPages(dir);
    }

    const nonDirEntries = entries.filter((e) => !e.isDirectory);
    const bountyIds = nonDirEntries.map((entry) =>
      query?.status !== undefined && typeof query.status === "string"
        ? decodeSegment(entry.name)
        : decodeSegment(entry.name.replace(/\.json$/, "")),
    );

    const fetched = await batchParallel(bountyIds, (id) => this.getBounty(id));

    const bounties: Bounty[] = [];
    for (const bounty of fetched) {
      if (bounty === undefined) continue;

      // Apply status filter for array queries
      if (query?.status !== undefined && Array.isArray(query.status)) {
        if (!query.status.includes(bounty.status)) continue;
      }

      if (query?.creatorAgentId !== undefined && bounty.creator.agentId !== query.creatorAgentId) {
        continue;
      }
      if (query?.claimedByAgentId !== undefined) {
        if (!bounty.claimedBy || bounty.claimedBy.agentId !== query.claimedByAgentId) continue;
      }
      if (query?.zoneId !== undefined && bounty.zoneId !== query.zoneId) {
        continue;
      }

      bounties.push(bounty);
    }

    // Sort by createdAt descending
    bounties.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? bounties.length;
    return bounties.slice(offset, offset + limit);
  }

  async countBounties(query?: BountyQuery): Promise<number> {
    const bounties = await this.listBounties(query);
    return bounties.length;
  }

  async fundBounty(bountyId: string, reservationId: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "open" as BountyStatus, (b) => ({
      ...b,
      reservationId,
    }));
  }

  async claimBounty(bountyId: string, claimedBy: AgentIdentity, claimId: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "claimed" as BountyStatus, (b) => ({
      ...b,
      claimedBy,
      claimId,
    }));
  }

  async completeBounty(bountyId: string, fulfilledByCid: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "completed" as BountyStatus, (b) => ({
      ...b,
      fulfilledByCid,
    }));
  }

  async settleBounty(bountyId: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "settled" as BountyStatus);
  }

  async expireBounty(bountyId: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "expired" as BountyStatus);
  }

  async cancelBounty(bountyId: string): Promise<Bounty> {
    return this.transitionBounty(bountyId, "cancelled" as BountyStatus);
  }

  async findExpiredBounties(): Promise<readonly Bounty[]> {
    const now = new Date();
    const openBounties = await this.listBounties({ status: "open" as BountyStatus });
    const claimedBounties = await this.listBounties({ status: "claimed" as BountyStatus });
    const all = [...openBounties, ...claimedBounties];
    return all.filter((b) => new Date(b.deadline).getTime() < now.getTime());
  }

  async recordReward(_reward: RewardRecord): Promise<void> {
    // Rewards are not yet stored in Nexus VFS (future work)
  }

  async hasReward(_rewardId: string): Promise<boolean> {
    return false;
  }

  async listRewards(_query?: RewardQuery): Promise<readonly RewardRecord[]> {
    return [];
  }

  close(): void {
    // No-op — no local state to release
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async transitionBounty(
    bountyId: string,
    newStatus: BountyStatus,
    transform?: (b: Bounty) => Bounty,
  ): Promise<Bounty> {
    const existing = await this.getBounty(bountyId);
    if (!existing)
      throw new NotFoundError({
        resource: "Bounty",
        identifier: bountyId,
        message: `Bounty not found: ${bountyId}`,
      });

    const oldStatus = existing.status;
    let updated: Bounty = {
      ...existing,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };
    if (transform) updated = transform(updated);

    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(bountyPath(this.zoneId, bountyId), encodeBounty(updated)),
        ),
      `transitionBounty:${newStatus}`,
      this.config,
    );

    // Clean up old status index
    if (oldStatus !== newStatus) {
      await safeCleanup(
        withSemaphore(this.semaphore, () =>
          this.client.delete(bountyStatusIndexPath(this.zoneId, oldStatus, bountyId)),
        ),
        "delete old bounty status index",
        { silent: true },
      );
    }
    await this.writeStatusIndex(updated);

    return updated;
  }

  private async writeStatusIndex(bounty: Bounty): Promise<void> {
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(
            bountyStatusIndexPath(this.zoneId, bounty.status, bounty.bountyId),
            new Uint8Array(0),
          ),
        ),
      "writeStatusIndex",
      this.config,
    );
  }

  private async listAllPages(
    dir: string,
    opts?: Omit<ListOptions, "cursor">,
  ): Promise<readonly ListEntry[]> {
    const entries: ListEntry[] = [];
    let cursor: string | undefined;

    do {
      const listing = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.list(dir, { ...opts, cursor })),
        "listAllPages",
        this.config,
      ).catch(() => ({
        files: [] as ListEntry[],
        hasMore: false as boolean,
        nextCursor: undefined,
      }));

      for (const entry of listing.files) {
        entries.push(entry);
      }
      cursor = listing.hasMore ? listing.nextCursor : undefined;
    } while (cursor !== undefined);

    return entries;
  }
}
