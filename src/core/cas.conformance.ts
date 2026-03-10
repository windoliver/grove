/**
 * Conformance test suite for ContentStore implementations.
 *
 * Any backend that implements ContentStore can validate its behavior
 * by calling `runContentStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentStore } from "./cas.js";

/** Factory that creates a fresh ContentStore and returns a cleanup function. */
export type ContentStoreFactory = () => Promise<{
  store: ContentStore;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full ContentStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates and tears down store instances.
 */
export function runContentStoreTests(factory: ContentStoreFactory): void {
  describe("ContentStore conformance", () => {
    let store: ContentStore;
    let cleanup: () => Promise<void>;
    let tempDir: string;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
      tempDir = await mkdtemp(join(tmpdir(), "cas-conformance-"));
    });

    afterEach(async () => {
      store.close();
      await cleanup();
      await rm(tempDir, { recursive: true, force: true });
    });

    // ------------------------------------------------------------------
    // put
    // ------------------------------------------------------------------

    test("put returns a blake3: content hash", async () => {
      const data = new TextEncoder().encode("hello world");
      const hash = await store.put(data);
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);
    });

    test("put is idempotent (same data = same hash)", async () => {
      const data = new TextEncoder().encode("idempotent check");
      const hash1 = await store.put(data);
      const hash2 = await store.put(data);
      expect(hash1).toBe(hash2);
    });

    // ------------------------------------------------------------------
    // get
    // ------------------------------------------------------------------

    test("get returns the stored data", async () => {
      const data = new TextEncoder().encode("round trip data");
      const hash = await store.put(data);
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(data);
    });

    test("get returns undefined for non-existent hash", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await store.get(fakeHash);
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // exists
    // ------------------------------------------------------------------

    test("exists returns true for stored content", async () => {
      const data = new TextEncoder().encode("exists check");
      const hash = await store.put(data);
      expect(await store.exists(hash)).toBe(true);
    });

    test("exists returns false for non-existent content", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      expect(await store.exists(fakeHash)).toBe(false);
    });

    // ------------------------------------------------------------------
    // delete
    // ------------------------------------------------------------------

    test("delete removes content and returns true", async () => {
      const data = new TextEncoder().encode("delete me");
      const hash = await store.put(data);
      expect(await store.delete(hash)).toBe(true);
      expect(await store.exists(hash)).toBe(false);
    });

    test("delete returns false for non-existent content", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      expect(await store.delete(fakeHash)).toBe(false);
    });

    // ------------------------------------------------------------------
    // putFile
    // ------------------------------------------------------------------

    test("putFile stores a file and returns hash", async () => {
      const filePath = join(tempDir, "input.txt");
      const content = "file content for putFile";
      await writeFile(filePath, content, "utf-8");

      const hash = await store.putFile(filePath);
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

      // The stored content should match the file bytes
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(new TextEncoder().encode(content));
    });

    // ------------------------------------------------------------------
    // getToFile
    // ------------------------------------------------------------------

    test("getToFile writes content to a file", async () => {
      const data = new TextEncoder().encode("content for getToFile");
      const hash = await store.put(data);

      const outPath = join(tempDir, "output.bin");
      const found = await store.getToFile(hash, outPath);
      expect(found).toBe(true);

      const file = Bun.file(outPath);
      const written = new Uint8Array(await file.arrayBuffer());
      expect(written).toEqual(data);
    });

    test("getToFile returns false for non-existent content", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const outPath = join(tempDir, "missing.bin");
      const found = await store.getToFile(fakeHash, outPath);
      expect(found).toBe(false);
    });

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------

    test("put then delete then get returns undefined", async () => {
      const data = new TextEncoder().encode("lifecycle test");
      const hash = await store.put(data);
      await store.delete(hash);
      const result = await store.get(hash);
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // edge cases
    // ------------------------------------------------------------------

    test("large content (1MB) round-trip", async () => {
      const size = 1024 * 1024;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }
      const hash = await store.put(data);
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(data);
    });

    test("empty content (0 bytes) round-trip", async () => {
      const data = new Uint8Array(0);
      const hash = await store.put(data);
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(data);
    });

    test("rejects malformed content hashes (path traversal)", async () => {
      const malicious = "blake3:aa/../../../etc/passwd";
      await expect(store.get(malicious)).rejects.toThrow();
      await expect(store.exists(malicious)).rejects.toThrow();
      await expect(store.delete(malicious)).rejects.toThrow();
    });

    test("binary content round-trip (non-UTF8 bytes)", async () => {
      // Bytes that are invalid UTF-8 sequences
      const data = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xc1, 0xf5, 0xf8]);
      const hash = await store.put(data);
      const retrieved = await store.get(hash);
      expect(retrieved).toEqual(data);
    });

    // ------------------------------------------------------------------
    // stat
    // ------------------------------------------------------------------

    test("stat returns artifact metadata for stored content", async () => {
      const data = new TextEncoder().encode("stat test data");
      const hash = await store.put(data);
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.contentHash).toBe(hash);
      expect(artifact?.sizeBytes).toBe(data.byteLength);
    });

    test("stat returns undefined for non-existent content", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await store.stat(fakeHash);
      expect(result).toBeUndefined();
    });

    test("stat returns correct size for empty content", async () => {
      const data = new Uint8Array(0);
      const hash = await store.put(data);
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.sizeBytes).toBe(0);
    });

    // ------------------------------------------------------------------
    // PutOptions — mediaType
    // ------------------------------------------------------------------

    test("put with mediaType persists it in stat", async () => {
      const data = new TextEncoder().encode('{"key": "value"}');
      const hash = await store.put(data, { mediaType: "application/json" });
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBe("application/json");
    });

    test("put without mediaType returns no mediaType in stat", async () => {
      const data = new TextEncoder().encode("no type");
      const hash = await store.put(data);
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBeUndefined();
    });

    test("putFile with mediaType persists it in stat", async () => {
      const filePath = join(tempDir, "data.json");
      await writeFile(filePath, '{"x": 1}', "utf-8");
      const hash = await store.putFile(filePath, { mediaType: "application/json" });
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBe("application/json");
    });

    test("mediaType can be set on re-put of existing content", async () => {
      const data = new TextEncoder().encode("typed later");
      const hash = await store.put(data);
      // Initially no mediaType
      let artifact = await store.stat(hash);
      expect(artifact?.mediaType).toBeUndefined();
      // Re-put with mediaType
      await store.put(data, { mediaType: "text/plain" });
      artifact = await store.stat(hash);
      expect(artifact?.mediaType).toBe("text/plain");
    });

    test("rejects mediaType with parameters (e.g., charset)", async () => {
      const data = new TextEncoder().encode("bad media type");
      await expect(store.put(data, { mediaType: "text/html; charset=utf-8" })).rejects.toThrow();
    });

    test("rejects mediaType exceeding 256 characters", async () => {
      const data = new TextEncoder().encode("long type");
      const longType = `text/${"a".repeat(256)}`;
      await expect(store.put(data, { mediaType: longType })).rejects.toThrow();
    });

    test("empty mediaType string is treated as no mediaType", async () => {
      const data = new TextEncoder().encode("empty type");
      const hash = await store.put(data, { mediaType: "" });
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // delete cleans up sidecar metadata
    // ------------------------------------------------------------------

    test("delete removes sidecar metadata so re-put does not resurrect it", async () => {
      const data = new TextEncoder().encode("delete meta test");
      const hash = await store.put(data, { mediaType: "text/plain" });
      // Verify metadata exists
      let artifact = await store.stat(hash);
      expect(artifact?.mediaType).toBe("text/plain");
      // Delete (should remove blob + sidecar)
      await store.delete(hash);
      // Re-put same bytes WITHOUT mediaType
      await store.put(data);
      artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // hash determinism (#12A)
    // ------------------------------------------------------------------

    test("known BLAKE3 test vector for 'hello world'", async () => {
      const data = new TextEncoder().encode("hello world");
      const hash = await store.put(data);
      expect(hash).toBe("blake3:d74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24");
    });

    test("different content produces different hashes", async () => {
      const data1 = new TextEncoder().encode("content A");
      const data2 = new TextEncoder().encode("content B");
      const hash1 = await store.put(data1);
      const hash2 = await store.put(data2);
      expect(hash1).not.toBe(hash2);
    });

    test("putFile produces same hash as put for identical content", async () => {
      const content = "cross-method hash check";
      const data = new TextEncoder().encode(content);
      const hashFromPut = await store.put(data);

      const filePath = join(tempDir, "hash-check.txt");
      await writeFile(filePath, content, "utf-8");
      const hashFromFile = await store.putFile(filePath);

      expect(hashFromFile).toBe(hashFromPut);
    });

    // ------------------------------------------------------------------
    // re-storage after deletion (#11A)
    // ------------------------------------------------------------------

    test("put after delete re-stores content successfully", async () => {
      const data = new TextEncoder().encode("re-storage test");
      const hash = await store.put(data);

      await store.delete(hash);
      expect(await store.exists(hash)).toBe(false);
      expect(await store.get(hash)).toBeUndefined();

      // Re-store the same content
      const rehash = await store.put(data);
      expect(rehash).toBe(hash);
      expect(await store.exists(hash)).toBe(true);
      expect(await store.get(hash)).toEqual(data);
    });

    test("put with mediaType after delete of content with different mediaType", async () => {
      const data = new TextEncoder().encode("media type lifecycle");
      const hash = await store.put(data, { mediaType: "text/plain" });

      await store.delete(hash);

      // Re-store with a different mediaType
      await store.put(data, { mediaType: "application/octet-stream" });
      const artifact = await store.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.mediaType).toBe("application/octet-stream");
    });

    // ------------------------------------------------------------------
    // error paths (#9A)
    // ------------------------------------------------------------------

    test("putFile rejects non-existent source file", async () => {
      const missingFile = join(tempDir, "does-not-exist.txt");
      await expect(store.putFile(missingFile)).rejects.toThrow();
    });

    test("putFile rejects directory path as source", async () => {
      await expect(store.putFile(tempDir)).rejects.toThrow();
    });

    test("getToFile rejects when output parent directory does not exist", async () => {
      const data = new TextEncoder().encode("output dir test");
      const hash = await store.put(data);
      const badPath = join(tempDir, "nonexistent", "subdir", "output.bin");
      await expect(store.getToFile(hash, badPath)).rejects.toThrow();
    });
  });
}
