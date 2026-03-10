/**
 * Concurrency tests for the filesystem-backed CAS.
 *
 * Exercises race conditions and concurrent operations to validate
 * atomicity and idempotency guarantees.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsCas } from "./fs-cas.js";

describe("FsCas concurrency", () => {
  let store: FsCas;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-cas-concurrency-"));
    store = new FsCas(dir);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("concurrent puts of the same content all return the same hash", async () => {
    const data = new TextEncoder().encode("concurrent same content");
    const results = await Promise.all(Array.from({ length: 10 }, () => store.put(data)));
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect(results[0]).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  test("concurrent puts of different content all succeed", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      data: new TextEncoder().encode(`content-${i}`),
    }));

    const hashes = await Promise.all(items.map(({ data }) => store.put(data)));

    // All hashes should be unique
    const unique = new Set(hashes);
    expect(unique.size).toBe(10);

    // All content should be retrievable
    for (let i = 0; i < items.length; i++) {
      const h = hashes[i];
      if (h === undefined) throw new Error(`missing hash at index ${i}`);
      const retrieved = await store.get(h);
      expect(retrieved).toEqual(items[i]?.data);
    }
  });

  test("concurrent put and delete of same hash does not corrupt store", async () => {
    const data = new TextEncoder().encode("put-delete race");
    const hash = await store.put(data);

    // Race: 5 puts and 5 deletes concurrently
    const ops = [
      ...Array.from({ length: 5 }, () => store.put(data)),
      ...Array.from({ length: 5 }, () => store.delete(hash)),
    ];
    await Promise.all(ops);

    // After the race, the content should either exist or not — but not be corrupted
    const exists = await store.exists(hash);
    if (exists) {
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(data);
    }
  });

  test("concurrent puts with different mediaType follow last-writer-wins", async () => {
    const data = new TextEncoder().encode("media type race");
    const types = ["text/plain", "application/json", "text/html", "image/png"];

    // Put same content with different mediaTypes concurrently
    await Promise.all(types.map((mediaType) => store.put(data, { mediaType })));

    // The resulting mediaType should be one of the provided types
    const hash = await store.put(data);
    const artifact = await store.stat(hash);
    expect(artifact).toBeDefined();
    if (artifact?.mediaType !== undefined) {
      expect(types).toContain(artifact.mediaType);
    }
  });

  test("two separate FsCas instances on same root produce consistent hashes", async () => {
    const store2 = new FsCas(dir);
    const data = new TextEncoder().encode("cross-instance");

    const hash1 = await store.put(data);
    const hash2 = await store2.put(data);
    expect(hash1).toBe(hash2);

    // Both instances can read the content
    const retrieved1 = await store.get(hash1);
    const retrieved2 = await store2.get(hash1);
    expect(retrieved1).toEqual(data);
    expect(retrieved2).toEqual(data);

    store2.close();
  });
});
