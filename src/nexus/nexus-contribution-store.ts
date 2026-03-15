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

import { fromManifest, toManifest, verifyCid } from "../core/manifest.js";
import type {
  Contribution,
  ContributionKind,
  JsonValue,
  Relation,
  RelationType,
} from "../core/models.js";
import type {
  ContributionQuery,
  ContributionStore,
  HotThreadsOptions,
  ThreadNode,
  ThreadSummary,
} from "../core/store.js";
import { toUtcIso } from "../core/time.js";
import { batchParallel } from "./batch.js";
import type { ListEntry, ListOptions, NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { LruCache } from "./lru-cache.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  contributionPath,
  ftsIndexDir,
  ftsIndexPath,
  relationIndexDir,
  relationIndexPath,
  tagIndexPath,
} from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

function decode<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
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

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.storeIdentity = `nexus:${this.zoneId}:contributions`;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
    this.cache = new LruCache(this.config.cacheMaxEntries);
  }

  async put(contribution: Contribution): Promise<void> {
    if (!verifyCid(contribution)) {
      throw new Error(
        `CID integrity check failed for '${contribution.cid}': CID does not match manifest content`,
      );
    }

    const manifestPath = contributionPath(this.zoneId, contribution.cid);

    await withRetry(
      async () => {
        // Store manifest (idempotent — overwrites are safe since CID is content-addressed)
        const manifest = toManifest(contribution);
        await withSemaphore(this.semaphore, () =>
          this.client.write(manifestPath, encode(manifest)),
        );

        // Write relation index entries (idempotent writes)
        for (const rel of contribution.relations) {
          const relPath = relationIndexPath(this.zoneId, rel.targetCid, contribution.cid);
          const relData = encode({
            relationType: rel.relationType,
            ...(rel.metadata !== undefined ? { metadata: rel.metadata } : {}),
          });
          await withSemaphore(this.semaphore, () => this.client.write(relPath, relData));
        }

        // Write tag index markers (idempotent writes)
        for (const tag of contribution.tags) {
          const tp = tagIndexPath(this.zoneId, tag, contribution.cid);
          await withSemaphore(this.semaphore, () => this.client.write(tp, new Uint8Array(0)));
        }

        // Write FTS index entry (idempotent write)
        const ftsPath = ftsIndexPath(this.zoneId, contribution.cid);
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
      },
      "put",
      this.config,
    );

    this.cache.set(contribution.cid, contribution);
  }

  async putMany(contributions: readonly Contribution[]): Promise<void> {
    const unique = new Map<string, Contribution>();
    for (const c of contributions) {
      unique.set(c.cid, c);
    }
    for (const c of unique.values()) {
      await this.put(c);
    }
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

    const path = contributionPath(this.zoneId, cid);
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

  async list(query?: ContributionQuery): Promise<readonly Contribution[]> {
    const ftsDir = ftsIndexDir(this.zoneId);
    const entries = await this.listAllPages(ftsDir, { recursive: true });

    const nonDirEntries = entries.filter((e) => !e.isDirectory);

    // Read FTS entries in parallel and filter by query
    const ftsResults = await batchParallel(nonDirEntries, async (entry) => {
      const ftsData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
      if (ftsData === undefined) return undefined;
      const fts = decode<Record<string, JsonValue>>(ftsData);
      if (!matchesFtsQuery(fts, query)) return undefined;
      return fts.cid as string;
    });

    const matchingCids = ftsResults.filter((cid): cid is string => cid !== undefined);

    // Fetch matching contributions in parallel
    const fetched = await batchParallel(matchingCids, (cid) => this.get(cid));
    const contributions = fetched.filter((c): c is Contribution => c !== undefined);

    // Sort by createdAt ascending (matches SQLite store behavior)
    contributions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Apply limit/offset
    const offset = query?.offset ?? 0;
    const limited =
      query?.limit !== undefined
        ? contributions.slice(offset, offset + query.limit)
        : contributions.slice(offset);

    return limited;
  }

  async children(cid: string): Promise<readonly Contribution[]> {
    const relDir = relationIndexDir(this.zoneId, cid);
    // Expected: directory may not exist yet
    const entries = await this.listAllPages(relDir).catch(() => []);

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
    const entries = await this.listAllPages(relDir).catch(() => []);

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
    const ftsDir = ftsIndexDir(this.zoneId);
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
    const allEntries = await this.listAllPages(ftsDir, { recursive: true });

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
    const allEntries = await this.listAllPages(relDir).catch(() => []);

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
        const entries = await this.listAllPages(relDir).catch(() => []);

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
      const entries = await this.listAllPages(relDir).catch(() => []);

      let count = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const relData = await withSemaphore(this.semaphore, () => this.client.read(entry.path));
        if (relData === undefined) continue;
        const rel = decode<{ relationType: string }>(relData);
        if (rel.relationType === "responds_to") count++;
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

  close(): void {
    // No-op — lifecycle managed by client
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
