/**
 * Nexus-backed ContributionStore adapter.
 *
 * Stores contributions as JSON manifests in the Nexus VFS.
 * Maintains index files for tags, relations, and FTS.
 *
 * Storage layout:
 * - Manifests:  /zones/{zoneId}/contributions/{cid}.json
 * - Tags:       /zones/{zoneId}/indexes/tags/{tag}/{cid}
 * - Relations:  /zones/{zoneId}/indexes/relations/{targetCid}/{sourceCid}.json
 * - FTS:        /zones/{zoneId}/indexes/fts/{cid}.json
 */

import { computeContributionContentHash } from "../core/content-dedup.js";
import type { ContributionEntity } from "../core/entity.js";
import { contributionToEntity } from "../core/entity.js";
import { fromManifest, toManifest, verifyCid } from "../core/manifest.js";
import type {
  Contribution,
  ContributionKind,
  JsonValue,
  Relation,
  RelationType,
} from "../core/models.js";
import type {
  ContributionPutResult,
  ContributionQuery,
  ContributionStore,
  HotThreadsOptions,
  ThreadNode,
  ThreadSummary,
} from "../core/store.js";
import { toUtcIso } from "../core/time.js";
import { debugLog } from "../tui/debug-log.js";
import { batchParallel } from "./batch.js";
import type { NexusClient, ReadResult, WriteResult } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { NexusConflictError } from "./errors.js";
import { listAllPages } from "./list-pages.js";
import { LruCache } from "./lru-cache.js";
import type { NexusWatchPublisher } from "./nexus-watch-publisher.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  contributionContentHashIndexPath,
  contributionPath,
  ftsIndexDir,
  ftsIndexPath,
  relationIndexDir,
  relationIndexPath,
  tagIndexPath,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTENT_HASH_REPAIR_STATE = "repairing";
const CONTENT_HASH_REPAIR_STALE_MS = 5 * 60_000;
const CONTENT_HASH_REPAIR_WAIT_MS = 2_000;
const CONTENT_HASH_REPAIR_POLL_MS = 10;

interface ContentHashRepairMarker {
  readonly state: typeof CONTENT_HASH_REPAIR_STATE;
  readonly cid: string;
  readonly token: string;
  readonly startedAt: string;
}

type ContentHashMarker =
  | { readonly kind: "committed"; readonly cid: string }
  | { readonly kind: "repairing"; readonly marker: ContentHashRepairMarker };

function encode(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

function decode<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}

function isContentHashRepairMarker(value: unknown): value is ContentHashRepairMarker {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.state === CONTENT_HASH_REPAIR_STATE &&
    typeof record.cid === "string" &&
    typeof record.token === "string" &&
    typeof record.startedAt === "string"
  );
}

function decodeContentHashMarker(data: Uint8Array): ContentHashMarker {
  const text = decoder.decode(data);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isContentHashRepairMarker(parsed)) {
      return { kind: "repairing", marker: parsed };
    }
  } catch {
    // Legacy committed markers are plain CID strings, not JSON.
  }
  return { kind: "committed", cid: text };
}

function createContentHashRepairMarker(cid: string): ContentHashRepairMarker {
  return {
    state: CONTENT_HASH_REPAIR_STATE,
    cid,
    token: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };
}

function isStaleRepairMarker(marker: ContentHashRepairMarker): boolean {
  const startedAt = Date.parse(marker.startedAt);
  return !Number.isFinite(startedAt) || Date.now() - startedAt > CONTENT_HASH_REPAIR_STALE_MS;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Nexus-backed ContributionStore.
 */
export class NexusContributionStore implements ContributionStore {
  readonly storeIdentity: string;
  private readonly client: NexusClient;
  private readonly config: ResolvedNexusConfig;
  private readonly semaphore: Semaphore;
  private readonly cache: LruCache<Contribution>;
  private readonly zoneId: string;
  private readonly sessionId: string | undefined;
  private readonly watchPublisher: NexusWatchPublisher | undefined;
  // TTL cache for list() — avoids the N+1 VFS read storm (1 list + N FTS + N manifest)
  // that exhausts Nexus's 300/min rate limit when multiple callers poll independently.
  // TTL is short (2s) so SSE-triggered refreshes (running-view bumps refreshSignal
  // on inbox-delivery events) actually return fresh data instead of replaying the
  // last full scan. Anything longer makes the TUI feel laggy: a contribution lands,
  // SSE fires, a refetch happens, but the cache hands back the pre-arrival snapshot
  // and the panel doesn't update until the next 30 s poll. 2 s still de-duplicates
  // the back-to-back fetches that several panels (Feed, DAG, Frontier) issue
  // immediately after a refresh signal — which was the original storm risk.
  //
  // The cache is also explicitly invalidated by `invalidateListCache()` — the
  // SSE/EventBus refresh path calls it before bumping `refreshSignal` so the
  // fan-out re-fetches see fresh data even when an inbox push lands inside
  // the 2 s TTL window. Without that, a remote contribution arriving 1.5 s
  // after the previous scan would still hit the cache and the UI would not
  // update until the next 30 s fallback poll.
  private listCacheResult: Contribution[] | undefined;
  private listCacheTime = 0;
  private readonly listCacheTtlMs = 2_000;

  // Epoch versioning for the list cache. Every invalidate() / write
  // increments the epoch. A list() cache miss captures the epoch at
  // scan start and only commits the result if the epoch is unchanged
  // when the scan returns. Without this, an in-flight scan that
  // started BEFORE an SSE-triggered invalidation could resurrect the
  // pre-arrival snapshot when it resolves, defeating the point of
  // invalidating in the first place.
  private listCacheEpoch = 0;
  // Shared in-flight scan promise — concurrent callers all await the
  // same VFS round trip instead of issuing N parallel scans. Cleared
  // by invalidateListCache() so a post-invalidation call always starts
  // a fresh scan against the latest epoch.
  private listCacheInflight: Promise<Contribution[]> | undefined = undefined;

  /**
   * Drop the cached list() snapshot so the next call re-scans the VFS.
   * Idempotent. Call from any code path that has out-of-band proof of new
   * contributions (e.g. SSE inbox-delivery push) so the next read does not
   * return a stale pre-arrival snapshot from the TTL window. Also bumps
   * the epoch so any concurrent in-flight scan started before this call
   * will discard its result rather than overwrite the cache with a stale
   * snapshot.
   */
  invalidateListCache(): void {
    this.listCacheResult = undefined;
    this.listCacheTime = 0;
    this.listCacheEpoch += 1;
    // Do NOT clear listCacheInflight here. If a scan is already running,
    // the epoch bump guarantees it will throw (stale epoch), which triggers
    // clearIfOwner and naturally opens a slot for one replacement scan.
    // Clearing here would break the single-flight guarantee: each SSE burst
    // event would clear the handle and cause a new full scan to start, up to
    // N parallel scans for N burst events.
  }

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.sessionId = this.config.sessionId;
    this.watchPublisher = this.config.watchPublisher;
    this.storeIdentity = `nexus:${this.zoneId}:contributions`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
    this.cache = new LruCache(this.config.cacheMaxEntries);
  }

  async put(contribution: Contribution): Promise<ContributionPutResult> {
    if (!verifyCid(contribution)) {
      throw new Error(
        `CID integrity check failed for '${contribution.cid}': CID does not match manifest content`,
      );
    }

    const manifestPath = contributionPath(this.zoneId, contribution.cid, this.sessionId);
    const contentHash = computeContributionContentHash(contribution);
    const contentHashPath = contributionContentHashIndexPath(
      this.zoneId,
      contentHash,
      this.sessionId,
    );

    const existingMarker = await this.readContentHashMarker(
      contentHashPath,
      "put:contentHashLookup",
    );
    if (existingMarker !== undefined) {
      return this.resolveExistingContentHash(
        contribution,
        contentHashPath,
        existingMarker,
        Date.now() + CONTENT_HASH_REPAIR_WAIT_MS,
      );
    }

    let reserveResult: WriteResult;
    try {
      const repairMarker = createContentHashRepairMarker(contribution.cid);
      reserveResult = await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(contentHashPath, encode(repairMarker), {
              ifNoneMatch: "*",
            }),
          ),
        "put:contentHashReserve",
        this.config,
      );
    } catch (err) {
      if (err instanceof NexusConflictError) {
        const existing = await this.readContentHashMarker(
          contentHashPath,
          "put:contentHashConflictLookup",
        );
        if (existing !== undefined) {
          return this.resolveExistingContentHash(
            contribution,
            contentHashPath,
            existing,
            Date.now() + CONTENT_HASH_REPAIR_WAIT_MS,
          );
        }
      }
      throw err;
    }

    const result = await this.finishContentHashRepair(contribution, contentHashPath, reserveResult);
    debugLog(
      "store.put",
      `cid=${contribution.cid.slice(0, 16)} sessionId=${this.sessionId ?? "none"} path=${manifestPath}`,
    );
    return result;
  }

  private async readContentHashMarker(
    contentHashPath: string,
    context: string,
  ): Promise<ReadResult | undefined> {
    return withRetry(
      () => withSemaphore(this.semaphore, () => this.client.readWithMeta(contentHashPath)),
      context,
      this.config,
    );
  }

  private async resolveExistingContentHash(
    contribution: Contribution,
    contentHashPath: string,
    markerResult: ReadResult,
    waitUntilMs: number,
  ): Promise<ContributionPutResult> {
    const marker = decodeContentHashMarker(markerResult.content);
    if (marker.kind === "repairing") {
      return this.resolveRepairingContentHash(
        contribution,
        contentHashPath,
        markerResult,
        marker.marker,
        waitUntilMs,
      );
    }

    const existingCid = marker.cid;
    const existing = await this.get(existingCid);
    if (existing !== undefined) {
      const repaired = await this.repairContributionRecordIfIncomplete(
        existing,
        "put:repairExistingIndexes",
      );
      return {
        cid: existingCid,
        isNew: repaired && existing.cid === contribution.cid,
        contribution: existing,
      };
    }

    return this.claimContentHashRepair(contribution, contentHashPath, markerResult, waitUntilMs);
  }

  private async resolveRepairingContentHash(
    contribution: Contribution,
    contentHashPath: string,
    markerResult: ReadResult,
    marker: ContentHashRepairMarker,
    waitUntilMs: number,
  ): Promise<ContributionPutResult> {
    const existing = await this.get(marker.cid);
    if (existing !== undefined) {
      await this.repairContributionRecordIfIncomplete(existing, "put:repairExistingIndexes");
      try {
        await withRetry(
          () =>
            withSemaphore(this.semaphore, () =>
              this.client.write(contentHashPath, encoder.encode(existing.cid), {
                ifMatch: markerResult.etag,
              }),
            ),
          "put:finalizeExistingRepairMarker",
          this.config,
        );
      } catch (err) {
        if (!(err instanceof NexusConflictError)) throw err;
      }
      return { cid: existing.cid, isNew: marker.cid === contribution.cid, contribution: existing };
    }

    if (marker.cid === contribution.cid || isStaleRepairMarker(marker)) {
      return this.claimContentHashRepair(contribution, contentHashPath, markerResult, waitUntilMs);
    }

    if (Date.now() < waitUntilMs) {
      await sleep(CONTENT_HASH_REPAIR_POLL_MS);
      const latest = await this.readContentHashMarker(
        contentHashPath,
        "put:waitForContentHashRepair",
      );
      if (latest === undefined) return this.put(contribution);
      return this.resolveExistingContentHash(contribution, contentHashPath, latest, waitUntilMs);
    }

    throw new NexusConflictError({
      message: `Content-hash repair is in progress for ${contentHashPath}`,
      actualEtag: markerResult.etag,
    });
  }

  private async claimContentHashRepair(
    contribution: Contribution,
    contentHashPath: string,
    markerResult: ReadResult,
    waitUntilMs: number,
  ): Promise<ContributionPutResult> {
    let repairClaim: WriteResult;
    try {
      const repairMarker = createContentHashRepairMarker(contribution.cid);
      repairClaim = await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(contentHashPath, encode(repairMarker), {
              ifMatch: markerResult.etag,
            }),
          ),
        "put:claimContentHashRepair",
        this.config,
      );
    } catch (err) {
      if (err instanceof NexusConflictError) {
        const latest = await this.readContentHashMarker(
          contentHashPath,
          "put:contentHashRepairConflictLookup",
        );
        if (latest !== undefined) {
          return this.resolveExistingContentHash(
            contribution,
            contentHashPath,
            latest,
            waitUntilMs,
          );
        }
      }
      throw err;
    }

    return this.finishContentHashRepair(contribution, contentHashPath, repairClaim);
  }

  private async finishContentHashRepair(
    contribution: Contribution,
    contentHashPath: string,
    repairClaim: WriteResult,
  ): Promise<ContributionPutResult> {
    await withRetry(
      () => this.writeContributionManifest(contribution),
      "put:writeContributionManifest",
      this.config,
    );
    try {
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(contentHashPath, encoder.encode(contribution.cid), {
              ifMatch: repairClaim.etag,
            }),
          ),
        "put:commitContentHashRepair",
        this.config,
      );
    } catch (err) {
      if (err instanceof NexusConflictError) {
        const latest = await this.readContentHashMarker(
          contentHashPath,
          "put:commitContentHashRepairConflictLookup",
        );
        if (latest !== undefined) {
          return this.resolveExistingContentHash(
            contribution,
            contentHashPath,
            latest,
            Date.now() + CONTENT_HASH_REPAIR_WAIT_MS,
          );
        }
      }
      throw err;
    }
    await withRetry(
      () => this.writeContributionIndexes(contribution),
      "put:writeContributionIndexes",
      this.config,
    );
    this.cache.set(contribution.cid, contribution);
    this.invalidateListCache();
    this.publishContributionAdded(contribution);
    return { cid: contribution.cid, isNew: true, contribution };
  }

  private async isContributionRecordComplete(cid: string): Promise<boolean> {
    const ftsPath = ftsIndexPath(this.zoneId, cid, this.sessionId);
    const data = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.read(ftsPath)),
      "put:repairCompletionCheck",
      this.config,
    );
    return data !== undefined;
  }

  private async repairContributionRecordIfIncomplete(
    contribution: Contribution,
    context: string,
  ): Promise<boolean> {
    if (await this.isContributionRecordComplete(contribution.cid)) return false;
    await withRetry(() => this.writeContributionRecord(contribution), context, this.config);
    this.invalidateListCache();
    return true;
  }

  private async writeContributionRecord(contribution: Contribution): Promise<void> {
    await this.writeContributionManifest(contribution);
    await this.writeContributionIndexes(contribution);
  }

  private async writeContributionManifest(contribution: Contribution): Promise<void> {
    const manifestPath = contributionPath(this.zoneId, contribution.cid, this.sessionId);
    const manifest = toManifest(contribution);
    await withSemaphore(this.semaphore, () => this.client.write(manifestPath, encode(manifest)));
  }

  private async writeContributionIndexes(contribution: Contribution): Promise<void> {
    for (const rel of contribution.relations) {
      const relPath = relationIndexPath(this.zoneId, rel.targetCid, contribution.cid);
      const relData = encode({
        relationType: rel.relationType,
        ...(rel.metadata !== undefined ? { metadata: rel.metadata } : {}),
      });
      await withSemaphore(this.semaphore, () => this.client.write(relPath, relData));
    }

    for (const tag of contribution.tags) {
      const tp = tagIndexPath(this.zoneId, tag, contribution.cid);
      await withSemaphore(this.semaphore, () => this.client.write(tp, new Uint8Array(0)));
    }

    const ftsPath = ftsIndexPath(this.zoneId, contribution.cid, this.sessionId);
    await withSemaphore(this.semaphore, () =>
      this.client.write(
        ftsPath,
        encode({
          cid: contribution.cid,
          summary: contribution.summary,
          description: contribution.description ?? "",
          kind: contribution.kind,
          mode: contribution.mode,
          agentId: contribution.agent.agentId,
          agentName: contribution.agent.agentName ?? null,
          createdAt: toUtcIso(contribution.createdAt),
          tags: contribution.tags,
        }),
      ),
    );
  }

  private publishContributionAdded(contribution: Contribution): void {
    if (!this.watchPublisher) return;
    void this.watchPublisher.publish({
      kind: "Contribution",
      namespace: this.zoneId,
      op: "ADDED",
      entityId: contribution.cid,
      generation: 1,
      emittedAt: new Date().toISOString(),
    });
  }

  async putMany(contributions: readonly Contribution[]): Promise<readonly ContributionPutResult[]> {
    const unique = new Map<string, Contribution>();
    for (const c of contributions) {
      unique.set(c.cid, c);
    }
    return batchParallel([...unique.values()], (c) => this.put(c));
  }

  async getMany(cids: readonly string[]): Promise<ReadonlyMap<string, Contribution>> {
    const result = new Map<string, Contribution>();
    if (cids.length === 0) return result;
    const entries = await Promise.all(cids.map(async (cid) => [cid, await this.get(cid)] as const));
    for (const [cid, contribution] of entries) {
      if (contribution !== undefined) {
        result.set(cid, contribution);
      }
    }
    return result;
  }

  async get(cid: string): Promise<Contribution | undefined> {
    const cached = this.cache.get(cid);
    if (cached !== undefined) return cached;

    const path = contributionPath(this.zoneId, cid, this.sessionId);
    const data = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.read(path)),
      "get",
      this.config,
    );
    if (data === undefined) return undefined;

    const manifest = decode<Record<string, unknown>>(data);
    const contribution = fromManifest(manifest, { verify: false });
    this.cache.set(cid, contribution);
    return contribution;
  }

  async getByContentHash(contentHash: string): Promise<Contribution | undefined> {
    const contentHashPath = contributionContentHashIndexPath(
      this.zoneId,
      contentHash,
      this.sessionId,
    );
    const markerResult = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.readWithMeta(contentHashPath)),
      "getByContentHash",
      this.config,
    );
    if (markerResult === undefined) return undefined;
    const marker = decodeContentHashMarker(markerResult.content);
    if (marker.kind === "repairing") return undefined;

    const existing = await this.get(marker.cid);
    if (existing === undefined) return undefined;
    if (!(await this.isContributionRecordComplete(existing.cid))) return undefined;

    return existing;
  }

  async list(query?: ContributionQuery): Promise<readonly Contribution[]> {
    // TTL cache: fetch ALL contributions once, then filter in-memory.
    // Without this, each list() does 1 + 2N VFS reads (list + N FTS + N manifest).
    // Multiple callers with different queries (limit, kind, etc.) each triggered
    // a full VFS scan — 35 contributions × 70 reads = 2450 reads/min, far exceeding
    // Nexus's 300/min rate limit. Now we read once per TTL window and filter locally.
    let allContributions: Contribution[];
    const cacheHit =
      this.listCacheResult !== undefined && Date.now() - this.listCacheTime < this.listCacheTtlMs;
    const ftsDir = ftsIndexDir(this.zoneId, this.sessionId);
    debugLog(
      "store.list",
      `sessionId=${this.sessionId ?? "none"} ftsDir=${ftsDir} cacheHit=${cacheHit}`,
    );
    if (cacheHit) {
      allContributions = [...(this.listCacheResult as Contribution[])];
    } else {
      // Deduplicate concurrent scans: all callers that arrive during an
      // in-flight VFS round trip share the same promise instead of
      // issuing N parallel scans. This prevents the refresh fan-out
      // (feed + dashboard + frontier all refetch on SSE push) from
      // stampeding Nexus with redundant reads.
      if (!this.listCacheInflight) {
        const scanPromise: Promise<Contribution[]> = this.runListScan(ftsDir);
        this.listCacheInflight = scanPromise;
        // Clear ownership on both fulfillment and rejection so the next
        // cache miss can start a fresh scan. Using then/catch instead of
        // finally().catch() avoids an unhandled-rejection from the new
        // Promise that finally() returns (which rejects when the scan throws).
        const clearIfOwner = () => {
          if (this.listCacheInflight === scanPromise) {
            this.listCacheInflight = undefined;
          }
        };
        void scanPromise.then(clearIfOwner, clearIfOwner);
      }
      allContributions = [...(await this.listCacheInflight)];
    }

    // Apply query filters in-memory (cheap — no VFS calls)
    let contributions = allContributions;
    if (query?.kind !== undefined)
      contributions = contributions.filter((c) => c.kind === query.kind);
    if (query?.mode !== undefined)
      contributions = contributions.filter((c) => c.mode === query.mode);
    if (query?.agentId !== undefined)
      contributions = contributions.filter((c) => c.agent.agentId === query.agentId);
    if (query?.agentName !== undefined)
      contributions = contributions.filter((c) => c.agent.agentName === query.agentName);
    if (query?.platform !== undefined)
      contributions = contributions.filter((c) => c.agent.platform === query.platform);
    if (query?.tags !== undefined && query.tags.length > 0) {
      const requiredTags = query.tags;
      contributions = contributions.filter((c) => requiredTags.every((t) => c.tags.includes(t)));
    }

    // Apply limit/offset
    const offset = query?.offset ?? 0;
    const limited =
      query?.limit !== undefined
        ? contributions.slice(offset, offset + query.limit)
        : contributions.slice(offset);

    return limited;
  }

  private async runListScan(ftsDir: string): Promise<Contribution[]> {
    // Capture epoch before any awaits so we can detect mid-scan invalidations.
    const epochAtStart = this.listCacheEpoch;

    const entries = await listAllPages(this.client, this.semaphore, this.config, ftsDir, {
      recursive: true,
    });

    const nonDirEntries = entries.filter((e) => !e.isDirectory);

    const ftsResults = await batchParallel(nonDirEntries, async (entry) => {
      const ftsData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
      if (ftsData === undefined) return undefined;
      const fts = decode<Record<string, JsonValue>>(ftsData);
      return fts.cid as string;
    });

    const allCids = ftsResults.filter((cid): cid is string => cid !== undefined);
    const ftsComplete = ftsResults.every((r) => r !== undefined);

    const fetched = await batchParallel(allCids, (cid) => this.get(cid));
    const allContributions = fetched.filter((c): c is Contribution => c !== undefined);
    const manifestComplete = fetched.every((c) => c !== undefined);
    debugLog(
      "store.list",
      `ftsEntries=${nonDirEntries.length} matchingCids=${allCids.length} total=${allContributions.length} complete=${ftsComplete && manifestComplete}`,
    );

    allContributions.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    if (this.listCacheEpoch !== epochAtStart) {
      // An invalidation arrived while we were scanning. Throw so all
      // waiting callers (usePolledData et al.) preserve their last-known-
      // good data instead of overwriting it with a stale pre-invalidation
      // snapshot. The post-invalidation scan (started by the SSE refresh
      // handler) will resolve with fresh data on the next await.
      throw new Error("list scan superseded by cache invalidation — discard result");
    }

    if (ftsComplete && manifestComplete) {
      this.listCacheResult = allContributions;
      this.listCacheTime = Date.now();
    }
    return allContributions;
  }

  async children(cid: string): Promise<readonly Contribution[]> {
    const relDir = relationIndexDir(this.zoneId, cid);
    // Expected: directory may not exist yet
    const entries = await listAllPages(this.client, this.semaphore, this.config, relDir);

    const seen = new Set<string>();
    const cids: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const sourceCid = entry.name.replace(/\.json$/, "");
      if (seen.has(sourceCid)) continue;
      seen.add(sourceCid);
      cids.push(sourceCid);
    }
    // Fetch in parallel — semaphore in get() limits actual concurrency
    const results = await Promise.all(cids.map((c) => this.get(c)));
    return results.filter((c): c is Contribution => c !== undefined);
  }

  async incomingSources(targetCids: readonly string[]): Promise<readonly Contribution[]> {
    if (targetCids.length === 0) return [];
    // Batch children() calls and deduplicate results
    const childSets = await batchParallel(targetCids, (cid) => this.children(cid));
    const seen = new Set<string>();
    const results: Contribution[] = [];
    for (const children of childSets) {
      for (const c of children) {
        if (!seen.has(c.cid)) {
          seen.add(c.cid);
          results.push(c);
        }
      }
    }
    return results;
  }

  async ancestors(cid: string): Promise<readonly Contribution[]> {
    const contribution = await this.get(cid);
    if (contribution === undefined) return [];

    const seen = new Set<string>();
    const targetCids: string[] = [];
    for (const rel of contribution.relations) {
      if (seen.has(rel.targetCid)) continue;
      seen.add(rel.targetCid);
      targetCids.push(rel.targetCid);
    }
    // Fetch in parallel — semaphore in get() limits actual concurrency
    const results = await Promise.all(targetCids.map((c) => this.get(c)));
    return results.filter((c): c is Contribution => c !== undefined);
  }

  async relationsOf(cid: string, relationType?: RelationType): Promise<readonly Relation[]> {
    const contribution = await this.get(cid);
    if (contribution === undefined) return [];

    let relations = contribution.relations;
    if (relationType !== undefined) {
      relations = relations.filter((r) => r.relationType === relationType);
    }
    return relations;
  }

  async relatedTo(cid: string, relationType?: RelationType): Promise<readonly Contribution[]> {
    const relDir = relationIndexDir(this.zoneId, cid);
    // Expected: directory may not exist yet
    const entries = await listAllPages(this.client, this.semaphore, this.config, relDir);

    const contributions: Contribution[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const sourceCid = entry.name.replace(/\.json$/, "");
      if (seen.has(sourceCid)) continue;

      // Filter by relationType if specified
      if (relationType !== undefined) {
        const relData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
        if (relData !== undefined) {
          const rel = decode<{ relationType: string }>(relData);
          if (rel.relationType !== relationType) continue;
        }
      }

      seen.add(sourceCid);
      const c = await this.get(sourceCid);
      if (c !== undefined) contributions.push(c);
    }
    return contributions;
  }

  async search(query: string, filters?: ContributionQuery): Promise<readonly Contribution[]> {
    // Try Nexus native search first (not all Nexus versions support it)
    const ftsDir = ftsIndexDir(this.zoneId, this.sessionId);
    try {
      const results = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.search(query, { path: ftsDir })),
        "search",
        this.config,
      );

      if (results.length > 0) {
        const contributions: Contribution[] = [];
        for (const r of results) {
          const filename = r.path.split("/").pop() ?? "";
          const cid = filename.replace(/\.json$/, "");
          if (!cid) continue;

          const ftsData = await withSemaphore(this.semaphore, () => this.client.read(r.path));
          if (ftsData === undefined) continue;
          const fts = decode<Record<string, JsonValue>>(ftsData);
          if (!matchesFtsQuery(fts, filters)) continue;

          const c = await this.get(cid);
          if (c !== undefined) contributions.push(c);
        }
        return contributions;
      }
    } catch {
      // Nexus search not supported — fall through to manual scan
    }

    // Fallback: list all FTS entries and filter by text
    const allEntries = await listAllPages(this.client, this.semaphore, this.config, ftsDir, {
      recursive: true,
    });

    const lowerQuery = query.toLowerCase();
    const contributions: Contribution[] = [];
    for (const entry of allEntries) {
      if (entry.isDirectory) continue;
      const ftsData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
      if (ftsData === undefined) continue;

      const fts = decode<Record<string, JsonValue>>(ftsData);
      const summary = ((fts.summary as string) ?? "").toLowerCase();
      const description = ((fts.description as string) ?? "").toLowerCase();
      if (!summary.includes(lowerQuery) && !description.includes(lowerQuery)) continue;
      if (!matchesFtsQuery(fts, filters)) continue;

      const c = await this.get(fts.cid as string);
      if (c !== undefined) contributions.push(c);
    }
    return contributions;
  }

  async findExisting(
    agentId: string,
    targetCid: string,
    kind: ContributionKind,
    relationType?: RelationType,
  ): Promise<readonly Contribution[]> {
    const relDir = relationIndexDir(this.zoneId, targetCid);
    // Expected: directory may not exist yet
    const allEntries = await listAllPages(this.client, this.semaphore, this.config, relDir);

    const contributions: Contribution[] = [];
    for (const entry of allEntries) {
      if (entry.isDirectory) continue;

      // Filter by relationType if specified
      if (relationType !== undefined) {
        const relData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
        if (relData !== undefined) {
          const rel = decode<{ relationType: string }>(relData);
          if (rel.relationType !== relationType) continue;
        }
      }

      const sourceCid = entry.name.replace(/\.json$/, "");
      const c = await this.get(sourceCid);
      if (c !== undefined && c.agent.agentId === agentId && c.kind === kind) {
        contributions.push(c);
      }
    }

    contributions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return contributions;
  }

  async count(query?: ContributionQuery): Promise<number> {
    // Strip limit/offset so we count ALL matching contributions, not just a page.
    const countQuery =
      query !== undefined ? { ...query, limit: undefined, offset: undefined } : undefined;
    const all = await this.list(countQuery);
    return all.length;
  }

  async countSince(query: { agentId?: string; since: string }): Promise<number> {
    const all = await this.list(
      query.agentId !== undefined ? { agentId: query.agentId } : undefined,
    );
    const sinceTime = new Date(query.since).getTime();
    return all.filter((c) => new Date(c.createdAt).getTime() >= sinceTime).length;
  }

  async thread(
    rootCid: string,
    opts?: { readonly maxDepth?: number; readonly limit?: number },
  ): Promise<readonly ThreadNode[]> {
    const maxDepth = opts?.maxDepth ?? 50;

    const root = await this.get(rootCid);
    if (root === undefined) return [];

    const result: ThreadNode[] = [{ contribution: root, depth: 0 }];
    const seen = new Set<string>([rootCid]);
    let currentLevel = [rootCid];

    for (let depth = 1; depth <= maxDepth && currentLevel.length > 0; depth++) {
      const nextLevel: string[] = [];

      for (const parentCid of currentLevel) {
        const relDir = relationIndexDir(this.zoneId, parentCid);
        // Expected: directory may not exist yet
        const entries = await listAllPages(this.client, this.semaphore, this.config, relDir);

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          // Read relation to check type
          const relData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
          if (relData === undefined) continue;
          const rel = decode<{ relationType: string }>(relData);
          if (rel.relationType !== "responds_to") continue;

          const childCid = entry.name.replace(/\.json$/, "");
          if (seen.has(childCid)) continue;
          seen.add(childCid);

          const c = await this.get(childCid);
          if (c !== undefined) {
            result.push({ contribution: c, depth });
            nextLevel.push(childCid);
          }
        }
      }

      currentLevel = nextLevel;
      if (opts?.limit !== undefined && result.length >= opts.limit) {
        return result.slice(0, opts.limit);
      }
    }

    result.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return (
        new Date(a.contribution.createdAt).getTime() - new Date(b.contribution.createdAt).getTime()
      );
    });

    return opts?.limit !== undefined ? result.slice(0, opts.limit) : result;
  }

  async replyCounts(cids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const result = new Map<string, number>();
    for (const cid of cids) {
      result.set(cid, 0);
    }
    if (cids.length === 0) return result;

    for (const cid of cids) {
      const relDir = relationIndexDir(this.zoneId, cid);
      // Expected: directory may not exist yet
      const entries = await listAllPages(this.client, this.semaphore, this.config, relDir);

      let count = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const relData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
        if (relData === undefined) continue;
        const rel = decode<{ relationType: string }>(relData);
        if (rel.relationType !== "responds_to") continue;
        if (this.sessionId !== undefined) {
          const sourceCid = entry.name.replace(/\.json$/, "");
          const source = await this.get(sourceCid);
          if (source === undefined) continue;
        }
        count++;
      }
      result.set(cid, count);
    }

    return result;
  }

  async hotThreads(opts?: HotThreadsOptions): Promise<readonly ThreadSummary[]> {
    const limit = opts?.limit ?? 20;
    const uniqueTags =
      opts?.tags !== undefined && opts.tags.length > 0 ? [...new Set(opts.tags)] : undefined;

    // Scan all contributions to find roots with responds_to replies
    const all = await this.list();
    const threadInfo = new Map<
      string,
      { contribution: Contribution; replyCount: number; lastReplyAt: string }
    >();

    for (const c of all) {
      for (const rel of c.relations) {
        if (rel.relationType !== "responds_to") continue;
        const existing = threadInfo.get(rel.targetCid);
        if (existing) {
          existing.replyCount++;
          if (new Date(c.createdAt).getTime() > new Date(existing.lastReplyAt).getTime()) {
            existing.lastReplyAt = c.createdAt;
          }
        } else {
          const root = await this.get(rel.targetCid);
          if (root !== undefined) {
            threadInfo.set(rel.targetCid, {
              contribution: root,
              replyCount: 1,
              lastReplyAt: c.createdAt,
            });
          }
        }
      }
    }

    let summaries = [...threadInfo.values()];

    // Tag filter
    if (uniqueTags !== undefined) {
      summaries = summaries.filter((s) => uniqueTags.every((t) => s.contribution.tags.includes(t)));
    }

    // Sort: reply count DESC, then last reply UTC epoch DESC
    summaries.sort((a, b) => {
      if (b.replyCount !== a.replyCount) return b.replyCount - a.replyCount;
      return new Date(b.lastReplyAt).getTime() - new Date(a.lastReplyAt).getTime();
    });

    return summaries.slice(0, limit);
  }

  async listEntities(query?: ContributionQuery): Promise<readonly ContributionEntity[]> {
    const items = await this.list(query);
    return items.map((c) => contributionToEntity(c, this.zoneId));
  }

  close(): void {
    // No-op — lifecycle managed by client
  }
}

// ---------------------------------------------------------------------------
// FTS query matching helper
// ---------------------------------------------------------------------------

function matchesFtsQuery(fts: Record<string, JsonValue>, query?: ContributionQuery): boolean {
  if (query === undefined) return true;
  if (query.kind !== undefined && fts.kind !== query.kind) return false;
  if (query.mode !== undefined && fts.mode !== query.mode) return false;
  if (query.agentId !== undefined && fts.agentId !== query.agentId) return false;
  if (query.agentName !== undefined && fts.agentName !== query.agentName) return false;
  if (query.tags !== undefined && query.tags.length > 0) {
    const recordTags = fts.tags as string[];
    if (!query.tags.every((t) => recordTags.includes(t))) return false;
  }
  return true;
}
