/**
 * NexusCas unit tests.
 *
 * Runs the full ContentStore conformance suite against NexusCas + MockNexusClient,
 * plus adapter-specific tests for zone isolation and exists-before-put behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runContentStoreTests } from "../../../src/core/cas.conformance.js";
import type {
  FileMeta,
  ListOptions,
  ListResult,
  MkdirOptions,
  NexusClient,
  ReadResult,
  SearchOptions,
  SearchResult,
  WriteOptions,
  WriteResult,
} from "../../../src/nexus/client.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusCas } from "../../../src/nexus/nexus-cas.js";

class EncodedStorageSizeClient implements NexusClient {
  private readonly files = new Map<
    string,
    { readonly raw: Uint8Array; readonly stored: Uint8Array; readonly etag: string }
  >();
  private nextVersion = 0;

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path)?.raw;
  }

  async readWithMeta(path: string): Promise<ReadResult | undefined> {
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    return { content: file.raw, etag: file.etag };
  }

  async write(path: string, content: Uint8Array, _opts?: WriteOptions): Promise<WriteResult> {
    const stored = new TextEncoder().encode(Buffer.from(content).toString("base64"));
    const etag = `etag-${String(++this.nextVersion)}`;
    this.files.set(path, { raw: new Uint8Array(content), stored, etag });
    return { bytesWritten: stored.byteLength, etag, version: this.nextVersion };
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async stat(path: string): Promise<FileMeta | undefined> {
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    return { size: file.stored.byteLength, etag: file.etag };
  }

  async delete(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async list(_path: string, _opts?: ListOptions): Promise<ListResult> {
    return { files: [], hasMore: false };
  }

  async mkdir(_path: string, _opts?: MkdirOptions): Promise<void> {
    /* no-op */
  }

  async search(_query: string, _opts?: SearchOptions): Promise<readonly SearchResult[]> {
    return [];
  }

  async close(): Promise<void> {
    this.files.clear();
  }
}

// ---------------------------------------------------------------------------
// Conformance tests
// ---------------------------------------------------------------------------

runContentStoreTests(async () => {
  const client = new MockNexusClient();
  const store = new NexusCas({
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

describe("NexusCas adapter-specific", () => {
  let client: MockNexusClient;

  beforeEach(() => {
    client = new MockNexusClient();
  });

  afterEach(async () => {
    await client.close();
  });

  test("zone isolation: different zones cannot read each other's blobs", async () => {
    const storeA = new NexusCas({ client, zoneId: "zone-a", retryMaxAttempts: 1 });
    const storeB = new NexusCas({ client, zoneId: "zone-b", retryMaxAttempts: 1 });

    const data = new TextEncoder().encode("zone-scoped data");
    const hash = await storeA.put(data);

    // Same zone can read
    expect(await storeA.exists(hash)).toBe(true);
    const retrieved = await storeA.get(hash);
    expect(retrieved).toEqual(data);

    // Different zone cannot read (different key prefix)
    expect(await storeB.exists(hash)).toBe(false);
    expect(await storeB.get(hash)).toBeUndefined();

    storeA.close();
    storeB.close();
  });

  test("exists-before-put skips upload for large blobs that already exist", async () => {
    const store = new NexusCas({
      client,
      zoneId: "test",
      existsThresholdBytes: 10, // Low threshold for testing
      retryMaxAttempts: 1,
    });

    // Create data above threshold
    const data = new Uint8Array(20);
    for (let i = 0; i < 20; i++) data[i] = i;

    const hash1 = await store.put(data);
    const hash2 = await store.put(data); // Should skip upload

    expect(hash1).toBe(hash2);
    expect(await store.exists(hash1)).toBe(true);

    store.close();
  });

  test("exists-before-put does not check for small blobs", async () => {
    const store = new NexusCas({
      client,
      zoneId: "test",
      existsThresholdBytes: 1000, // High threshold
      retryMaxAttempts: 1,
    });

    const data = new TextEncoder().encode("small");
    const hash = await store.put(data);
    expect(await store.exists(hash)).toBe(true);

    store.close();
  });

  test("stat returns logical byte size when backend storage is base64 encoded", async () => {
    const encodedClient = new EncodedStorageSizeClient();
    const store = new NexusCas({ client: encodedClient, zoneId: "test", retryMaxAttempts: 1 });
    const data = new TextEncoder().encode("hello");

    const hash = await store.put(data);
    const artifact = await store.stat(hash);

    expect(artifact?.sizeBytes).toBe(data.byteLength);
    store.close();
    await encodedClient.close();
  });

  test("putFile rejects files above configured maxPutFileBytes before upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-cas-putfile-limit-"));
    const filePath = join(dir, "artifact.bin");
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4]));
    const store = new NexusCas({
      client,
      zoneId: "test",
      maxPutFileBytes: 3,
      retryMaxAttempts: 1,
    });
    try {
      await expect(store.putFile(filePath)).rejects.toThrow("exceeds Nexus CAS putFile limit");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("existsMany", () => {
    test("empty input returns empty map", async () => {
      const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

      const result = await store.existsMany([]);
      expect(result.size).toBe(0);

      store.close();
    });

    test("single existing hash", async () => {
      const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

      const data = new TextEncoder().encode("existsMany single");
      const hash = await store.put(data);

      const result = await store.existsMany([hash]);
      expect(result.size).toBe(1);
      expect(result.get(hash)).toBe(true);

      store.close();
    });

    test("single missing hash", async () => {
      const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await store.existsMany([fakeHash]);
      expect(result.size).toBe(1);
      expect(result.get(fakeHash)).toBe(false);

      store.close();
    });

    test("mixed existing and missing", async () => {
      const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

      const data1 = new TextEncoder().encode("existsMany mix-a");
      const data2 = new TextEncoder().encode("existsMany mix-b");
      const hash1 = await store.put(data1);
      const hash2 = await store.put(data2);
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";

      const result = await store.existsMany([hash1, hash2, fakeHash]);
      expect(result.size).toBe(3);
      expect(result.get(hash1)).toBe(true);
      expect(result.get(hash2)).toBe(true);
      expect(result.get(fakeHash)).toBe(false);

      store.close();
    });

    test("duplicate hashes in input returns single map entry", async () => {
      const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

      const data = new TextEncoder().encode("existsMany dup");
      const hash = await store.put(data);

      const result = await store.existsMany([hash, hash]);
      expect(result.size).toBe(1);
      expect(result.get(hash)).toBe(true);

      store.close();
    });
  });

  test("stat caches results for subsequent calls", async () => {
    const store = new NexusCas({ client, zoneId: "test", retryMaxAttempts: 1 });

    const data = new TextEncoder().encode("cacheable");
    const hash = await store.put(data, { mediaType: "text/plain" });

    const stat1 = await store.stat(hash);
    const stat2 = await store.stat(hash); // Should come from cache

    expect(stat1).toEqual(stat2);
    expect(stat1?.contentHash).toBe(hash);
    expect(stat1?.mediaType).toBe("text/plain");

    store.close();
  });
});
