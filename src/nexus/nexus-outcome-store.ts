/**
 * Nexus-backed OutcomeStore adapter.
 *
 * Stores outcome records as JSON files in the Nexus VFS with
 * status index markers for efficient filtered listing.
 *
 * Storage layout:
 * - Outcomes:       /zones/{zoneId}/outcomes/{cid}.json
 * - Status index:   /zones/{zoneId}/indexes/outcomes/status/{status}/{cid}
 */

import type {
  OutcomeInput,
  OutcomeQuery,
  OutcomeRecord,
  OutcomeStats,
  OutcomeStore,
} from "../core/outcome.js";
import { OutcomeStatus } from "../core/outcome.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { ListEntry, ListOptions, NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  decodeSegment,
  outcomePath,
  outcomeStatusIndexDir,
  outcomeStatusIndexPath,
  outcomesDir,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeOutcome(record: OutcomeRecord): Uint8Array {
  return encoder.encode(JSON.stringify(record));
}

function decodeOutcome(data: Uint8Array): OutcomeRecord {
  return JSON.parse(decoder.decode(data)) as OutcomeRecord;
}

/**
 * Nexus-backed OutcomeStore.
 *
 * Implements the OutcomeStore interface using the Nexus VFS for
 * persistence. Follows the same patterns as NexusClaimStore:
 * resolveConfig, Semaphore, retry with backoff, mapNexusError.
 */
export class NexusOutcomeStore implements OutcomeStore {
  private readonly client: NexusClient;
  private readonly config: ResolvedNexusConfig;
  private readonly semaphore: Semaphore;
  private readonly zoneId: string;

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
  }

  async set(cid: string, input: OutcomeInput): Promise<OutcomeRecord> {
    // Read existing record to detect status change for index cleanup
    const existing = await this.get(cid);

    const record: OutcomeRecord = {
      cid,
      status: input.status,
      reason: input.reason,
      baselineCid: input.baselineCid,
      evaluatedAt: new Date().toISOString(),
      evaluatedBy: input.evaluatedBy,
    };

    // Write the outcome JSON
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(outcomePath(this.zoneId, cid), encodeOutcome(record)),
        ),
      "set",
      this.config,
    );

    // Delete old status index marker if the status changed
    if (existing !== undefined && existing.status !== record.status) {
      await safeCleanup(
        withSemaphore(this.semaphore, () =>
          this.client.delete(outcomeStatusIndexPath(this.zoneId, existing.status, cid)),
        ),
        "delete old outcome status index",
        { silent: true },
      );
    }

    // Write new status index marker
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.write(
            outcomeStatusIndexPath(this.zoneId, record.status, cid),
            new Uint8Array(0),
          ),
        ),
      "set:index",
      this.config,
    );

    return record;
  }

  async get(cid: string): Promise<OutcomeRecord | undefined> {
    const data = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.read(outcomePath(this.zoneId, cid))),
      "get",
      this.config,
    );
    if (data === undefined) return undefined;
    return decodeOutcome(data);
  }

  async getBatch(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    const results = new Map<string, OutcomeRecord>();
    const promises: Array<Promise<void>> = cids.map(async (cid) => {
      const record = await this.get(cid);
      if (record !== undefined) {
        results.set(cid, record);
      }
    });
    await Promise.all(promises);
    return results;
  }

  async list(query?: OutcomeQuery): Promise<readonly OutcomeRecord[]> {
    let entries: readonly ListEntry[];

    if (query?.status !== undefined) {
      // Use the status index for efficient filtering
      const dir = outcomeStatusIndexDir(this.zoneId, query.status);
      entries = await this.listAllPages(dir);
    } else {
      // List all outcomes
      const dir = outcomesDir(this.zoneId);
      entries = await this.listAllPages(dir);
    }

    // Read records from entries
    const records: OutcomeRecord[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;

      let cid: string;
      if (query?.status !== undefined) {
        // Status index entries: name is the CID (encoded)
        cid = decodeSegment(entry.name);
      } else {
        // Outcome dir entries: name is {cid}.json
        cid = decodeSegment(entry.name.replace(/\.json$/, ""));
      }

      const record = await this.get(cid);
      if (record === undefined) continue;

      // Apply evaluatedBy filter if specified
      if (query?.evaluatedBy !== undefined && record.evaluatedBy !== query.evaluatedBy) {
        continue;
      }

      records.push(record);
    }

    // Apply offset and limit
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  async getStats(): Promise<OutcomeStats> {
    const statuses = Object.values(OutcomeStatus);
    const counts: Record<string, number> = {};

    // Count entries in each status index dir in parallel
    const promises: Array<Promise<void>> = statuses.map(async (status) => {
      const dir = outcomeStatusIndexDir(this.zoneId, status);
      const entries = await this.listAllPages(dir);
      counts[status] = entries.filter((e) => !e.isDirectory).length;
    });
    await Promise.all(promises);

    const accepted = counts[OutcomeStatus.Accepted] ?? 0;
    const rejected = counts[OutcomeStatus.Rejected] ?? 0;
    const crashed = counts[OutcomeStatus.Crashed] ?? 0;
    const invalidated = counts[OutcomeStatus.Invalidated] ?? 0;
    const total = accepted + rejected + crashed + invalidated;
    const acceptanceRate = total > 0 ? accepted / total : 0;

    return {
      total,
      accepted,
      rejected,
      crashed,
      invalidated,
      acceptanceRate,
    };
  }

  close(): void {
    // No-op — no local state to release
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Paginate through all pages of a list() call, collecting all entries. */
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
