/**
 * NexusContributionStore unit tests.
 *
 * Runs the full ContributionStore conformance suite against
 * NexusContributionStore + MockNexusClient, plus adapter-specific tests
 * for LRU cache behavior, retry on network error, and zone isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { computeContributionContentHash } from "../../../src/core/content-dedup.js";
import { toManifest } from "../../../src/core/manifest.js";
import { type Contribution, RelationType } from "../../../src/core/models.js";
import { runContributionStoreTests } from "../../../src/core/store.conformance.js";
import { makeContribution } from "../../../src/core/test-helpers.js";
import type { WriteOptions, WriteResult } from "../../../src/nexus/client.js";
import { NexusConflictError } from "../../../src/nexus/errors.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";
import {
  contributionContentHashIndexPath,
  contributionPath,
  ftsIndexPath,
  relationIndexPath,
  tagIndexPath,
} from "../../../src/nexus/vfs-paths.js";

interface RecordedBatchFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly opts?: WriteOptions | undefined;
}

class RecordingBatchClient extends MockNexusClient {
  readonly writeCalls: string[] = [];
  readonly writeBatchCalls: RecordedBatchFile[][] = [];

  override async write(
    path: string,
    content: Uint8Array,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    this.writeCalls.push(path);
    return super.write(path, content, opts);
  }

  async writeBatch(files: readonly RecordedBatchFile[]): Promise<readonly WriteResult[]> {
    this.writeBatchCalls.push(
      files.map((file) => ({
        path: file.path,
        content: new Uint8Array(file.content),
        ...(file.opts !== undefined ? { opts: file.opts } : {}),
      })),
    );
    const results: WriteResult[] = [];
    for (const file of files) {
      results.push(await super.write(file.path, file.content, file.opts));
    }
    return results;
  }
}

class ContentHashCommitConflictClient extends MockNexusClient {
  private conflicted = false;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly zoneId: string,
    private readonly contentHashPath: string,
    private readonly winner: Contribution,
  ) {
    super();
  }

  override async write(
    path: string,
    content: Uint8Array,
    opts?: WriteOptions,
  ): Promise<WriteResult> {
    if (path === this.contentHashPath && opts?.ifMatch !== undefined && !this.conflicted) {
      this.conflicted = true;
      await super.write(
        contributionPath(this.zoneId, this.winner.cid),
        this.encoder.encode(JSON.stringify(toManifest(this.winner))),
      );
      await super.write(
        ftsIndexPath(this.zoneId, this.winner.cid),
        this.encoder.encode(JSON.stringify({ cid: this.winner.cid })),
      );
      await super.write(this.contentHashPath, this.encoder.encode(this.winner.cid));
      throw new NexusConflictError({
        message: `simulated content-hash commit race for ${path}`,
        expectedEtag: opts.ifMatch,
      });
    }
    return super.write(path, content, opts);
  }
}

// ---------------------------------------------------------------------------
// Conformance tests
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusContributionStore({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1, // No retries in conformance tests
  });
  return {
    store,
    cleanup: async () => {
      await client.close();
    },
  };
});

// ---------------------------------------------------------------------------
// Adapter-specific tests
// ---------------------------------------------------------------------------

describe("NexusContributionStore adapter-specific", () => {
  let client: MockNexusClient;
  let store: NexusContributionStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusContributionStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  // -----------------------------------------------------------------------
  // Zone isolation
  // -----------------------------------------------------------------------

  test("zone isolation: different zones have separate contributions", async () => {
    const storeB = new NexusContributionStore({
      client,
      zoneId: "other-zone",
      retryMaxAttempts: 1,
    });

    const c = makeContribution({ summary: "zone test" });
    await store.put(c);

    expect(await store.get(c.cid)).toBeDefined();
    expect(await storeB.get(c.cid)).toBeUndefined();

    storeB.close();
  });

  // -----------------------------------------------------------------------
  // LRU cache behavior
  // -----------------------------------------------------------------------

  test("get returns cached contribution without hitting client on second read", async () => {
    const c = makeContribution({ summary: "cache hit" });
    await store.put(c);

    // First get populates cache
    const first = await store.get(c.cid);
    expect(first).toBeDefined();
    expect(first?.summary).toBe("cache hit");

    // Close the client to prove the second read comes from cache
    await client.close();

    // Second get should return from LRU cache (not hit the closed client)
    const second = await store.get(c.cid);
    expect(second).toBeDefined();
    expect(second?.cid).toBe(c.cid);
    expect(second?.summary).toBe("cache hit");
  });

  test("cache eviction: oldest entries are evicted when cache is full", async () => {
    // Create store with tiny cache
    const tinyStore = new NexusContributionStore({
      client,
      zoneId: "test-zone",
      cacheMaxEntries: 2,
      retryMaxAttempts: 1,
    });

    const c1 = makeContribution({ summary: "first" });
    const c2 = makeContribution({ summary: "second" });
    const c3 = makeContribution({ summary: "third" });

    await tinyStore.put(c1);
    await tinyStore.put(c2);
    await tinyStore.put(c3); // This should evict c1 from cache

    // c3 and c2 should be in cache, c1 evicted but still in VFS
    // All three should still be retrievable (c1 from VFS, c2/c3 from cache)
    expect(await tinyStore.get(c1.cid)).toBeDefined();
    expect(await tinyStore.get(c2.cid)).toBeDefined();
    expect(await tinyStore.get(c3.cid)).toBeDefined();

    tinyStore.close();
  });

  // -----------------------------------------------------------------------
  // Retry on network error
  // -----------------------------------------------------------------------

  test("put retries on transient connection error and succeeds", async () => {
    const retryClient = new MockNexusClient();
    const retryStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const c = makeContribution({ summary: "retry me" });

    // First 2 calls fail, then succeeds
    retryClient.setFailureMode({ failNext: 2, failWith: "connection" });
    await retryStore.put(c);

    const retrieved = await retryStore.get(c.cid);
    expect(retrieved).toBeDefined();
    expect(retrieved?.summary).toBe("retry me");

    retryStore.close();
    await retryClient.close();
  });

  test("get retries on transient timeout error and succeeds", async () => {
    const retryClient = new MockNexusClient();
    const retryStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const c = makeContribution({ summary: "timeout retry" });
    await retryStore.put(c);

    // Inject timeout for the next read
    retryClient.setFailureMode({ failNext: 1, failWith: "timeout" });

    // Clear the cache so get actually hits the client
    retryStore.close();
    const freshStore = new NexusContributionStore({
      client: retryClient,
      zoneId: "retry-zone",
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 10,
    });

    const retrieved = await freshStore.get(c.cid);
    expect(retrieved).toBeDefined();
    expect(retrieved?.summary).toBe("timeout retry");

    freshStore.close();
    await retryClient.close();
  });

  test("put repairs orphaned content-hash marker before returning", async () => {
    const c = makeContribution({ summary: "repair orphan marker" });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(c.cid),
    );

    const result = await store.put(c);

    expect(result.isNew).toBe(true);
    expect(result.contribution?.cid).toBe(c.cid);
    expect(await store.get(c.cid)).toBeDefined();
    expect((await store.list()).map((entry) => entry.cid)).toContain(c.cid);
  });

  test("put serializes concurrent orphan marker repairs to one visible contribution", async () => {
    const c1 = makeContribution({
      summary: "concurrent orphan repair",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const c2 = makeContribution({
      summary: "concurrent orphan repair",
      createdAt: "2026-01-01T00:00:01Z",
    });
    const contentHash = computeContributionContentHash(c1);
    expect(c2.cid).not.toBe(c1.cid);
    expect(computeContributionContentHash(c2)).toBe(contentHash);
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(`blake3:${"0".repeat(64)}`),
    );

    const results = await Promise.all([store.put(c1), store.put(c2)]);

    expect(new Set(results.map((result) => result.cid)).size).toBe(1);
    const visibleCids = (await store.list())
      .filter((entry) => entry.summary === "concurrent orphan repair")
      .map((entry) => entry.cid);
    expect(new Set(visibleCids).size).toBe(1);
  });

  test("put resumes an abandoned repair marker for the same contribution", async () => {
    const c = makeContribution({ summary: "resume repair marker" });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(
        JSON.stringify({
          state: "repairing",
          cid: c.cid,
          token: "abandoned",
          startedAt: new Date().toISOString(),
        }),
      ),
    );

    const result = await store.put(c);

    expect(result.isNew).toBe(true);
    expect(await store.get(c.cid)).toBeDefined();
    expect((await store.list()).map((entry) => entry.cid)).toContain(c.cid);
  });

  test("put reports new when repairing committed incomplete manifest records", async () => {
    const c = makeContribution({ summary: "repair secondary indexes", tags: ["repair"] });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionPath("test-zone", c.cid),
      new TextEncoder().encode(JSON.stringify(toManifest(c))),
    );
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(c.cid),
    );

    expect(await store.list()).toEqual([]);

    const result = await store.put(c);

    expect(result.isNew).toBe(true);
    expect(result.contribution?.cid).toBe(c.cid);
    expect((await store.list()).map((entry) => entry.cid)).toContain(c.cid);
    expect((await store.search("secondary")).map((entry) => entry.cid)).toContain(c.cid);
  });

  test("put reports new when finishing same-cid repair marker with manifest", async () => {
    const c = makeContribution({ summary: "finish repair marker", tags: ["finish"] });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionPath("test-zone", c.cid),
      new TextEncoder().encode(JSON.stringify(toManifest(c))),
    );
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(
        JSON.stringify({
          state: "repairing",
          cid: c.cid,
          token: "interrupted",
          startedAt: new Date().toISOString(),
        }),
      ),
    );

    const result = await store.put(c);

    expect(result.isNew).toBe(true);
    expect(result.contribution?.cid).toBe(c.cid);
    expect((await store.list()).map((entry) => entry.cid)).toContain(c.cid);
    expect((await store.search("finish")).map((entry) => entry.cid)).toContain(c.cid);
  });

  test("put writes manifest and secondary indexes in one batch", async () => {
    const batchClient = new RecordingBatchClient();
    const batchStore = new NexusContributionStore({
      client: batchClient,
      zoneId: "batch-zone",
      retryMaxAttempts: 1,
    });
    const targetCid = `blake3:${"a".repeat(64)}`;
    const c = makeContribution({
      summary: "batch contribution record",
      description: "batch indexed text",
      relations: [{ targetCid, relationType: RelationType.DerivesFrom }],
      tags: ["alpha", "beta"],
    });
    const expectedRecordPaths = [
      contributionPath("batch-zone", c.cid),
      relationIndexPath("batch-zone", targetCid, c.cid),
      tagIndexPath("batch-zone", "alpha", c.cid),
      tagIndexPath("batch-zone", "beta", c.cid),
      ftsIndexPath("batch-zone", c.cid),
    ].sort();

    await batchStore.put(c);

    const firstBatch = batchClient.writeBatchCalls.at(0);
    if (firstBatch === undefined) {
      throw new Error("expected contribution record to be written with writeBatch");
    }
    expect(batchClient.writeBatchCalls).toHaveLength(1);
    expect(firstBatch.map((file) => file.path).sort()).toEqual(expectedRecordPaths);
    for (const path of expectedRecordPaths) {
      expect(batchClient.writeCalls).not.toContain(path);
    }

    batchStore.close();
    await batchClient.close();
  });

  test("put removes loser record files when content-hash commit races", async () => {
    const winner = makeContribution({
      summary: "same logical payload",
      tags: ["race"],
      createdAt: "2026-01-01T00:00:00Z",
    });
    const loser = makeContribution({
      summary: "same logical payload",
      tags: ["race"],
      createdAt: "2026-01-02T00:00:00Z",
    });
    const contentHash = computeContributionContentHash(loser);
    expect(computeContributionContentHash(winner)).toBe(contentHash);
    expect(winner.cid).not.toBe(loser.cid);

    const raceClient = new ContentHashCommitConflictClient(
      "race-zone",
      contributionContentHashIndexPath("race-zone", contentHash),
      winner,
    );
    const raceStore = new NexusContributionStore({
      client: raceClient,
      zoneId: "race-zone",
      retryMaxAttempts: 1,
    });

    const result = await raceStore.put(loser);

    expect(result.cid).toBe(winner.cid);
    expect(await raceStore.get(loser.cid)).toBeUndefined();
    expect((await raceStore.list()).map((entry) => entry.cid)).toEqual([winner.cid]);

    raceStore.close();
    await raceClient.close();
  });

  test("getByContentHash ignores committed incomplete manifest records", async () => {
    const c = makeContribution({ summary: "repair content hash lookup", tags: ["lookup"] });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionPath("test-zone", c.cid),
      new TextEncoder().encode(JSON.stringify(toManifest(c))),
    );
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(c.cid),
    );

    const found = await store.getByContentHash(contentHash);

    expect(found).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test("getByContentHash ignores repairing incomplete manifest records", async () => {
    const c = makeContribution({ summary: "skip repairing content hash lookup" });
    const contentHash = computeContributionContentHash(c);
    await client.write(
      contributionPath("test-zone", c.cid),
      new TextEncoder().encode(JSON.stringify(toManifest(c))),
    );
    await client.write(
      contributionContentHashIndexPath("test-zone", contentHash),
      new TextEncoder().encode(
        JSON.stringify({
          state: "repairing",
          cid: c.cid,
          token: "interrupted",
          startedAt: new Date().toISOString(),
        }),
      ),
    );

    const found = await store.getByContentHash(contentHash);

    expect(found).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // storeIdentity
  // -----------------------------------------------------------------------

  test("storeIdentity includes zone", () => {
    expect(store.storeIdentity).toBe("nexus:test-zone:contributions");
  });
});
