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
  });
}
