/**
 * Coverage tests for nexus utilities.
 *
 * Exercises code paths in errors.ts, lru-cache.ts, and mock-client.ts
 * that aren't covered by the conformance and resilience test suites.
 */

import { describe, expect, test } from "bun:test";

import { GroveError } from "../../../src/core/errors.js";
import {
  mapJsonRpcError,
  NEXUS_ERROR_CODES,
  NexusAuthError,
  NexusConflictError,
  NexusNotFoundError,
} from "../../../src/nexus/errors.js";
import { LruCache } from "../../../src/nexus/lru-cache.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";

// ---------------------------------------------------------------------------
// LruCache — delete and size
// ---------------------------------------------------------------------------

describe("LruCache", () => {
  test("delete removes an entry and returns true", () => {
    const cache = new LruCache<number>(10);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
  });

  test("delete returns false for missing key", () => {
    const cache = new LruCache<number>(10);
    expect(cache.delete("missing")).toBe(false);
  });

  test("size reflects current entry count", () => {
    const cache = new LruCache<string>(10);
    expect(cache.size).toBe(0);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
    cache.delete("a");
    expect(cache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mapJsonRpcError — all code branches
// ---------------------------------------------------------------------------

describe("mapJsonRpcError", () => {
  test("FILE_EXISTS maps to NexusConflictError", () => {
    const err = mapJsonRpcError({ code: NEXUS_ERROR_CODES.FILE_EXISTS, message: "exists" });
    expect(err).toBeInstanceOf(NexusConflictError);
  });

  test("ACCESS_DENIED maps to NexusAuthError", () => {
    const err = mapJsonRpcError({ code: NEXUS_ERROR_CODES.ACCESS_DENIED, message: "denied" });
    expect(err).toBeInstanceOf(NexusAuthError);
  });

  test("PERMISSION_ERROR maps to NexusAuthError", () => {
    const err = mapJsonRpcError({ code: NEXUS_ERROR_CODES.PERMISSION_ERROR, message: "perm" });
    expect(err).toBeInstanceOf(NexusAuthError);
  });

  test("VALIDATION_ERROR maps to GroveError", () => {
    const err = mapJsonRpcError({ code: NEXUS_ERROR_CODES.VALIDATION_ERROR, message: "bad" });
    expect(err).toBeInstanceOf(GroveError);
    expect(err).not.toBeInstanceOf(NexusNotFoundError);
  });

  test("INVALID_PATH maps to GroveError", () => {
    const err = mapJsonRpcError({ code: NEXUS_ERROR_CODES.INVALID_PATH, message: "bad path" });
    expect(err).toBeInstanceOf(GroveError);
  });
});

// ---------------------------------------------------------------------------
// MockNexusClient — isClosed, mkdir with parents
// ---------------------------------------------------------------------------

describe("MockNexusClient extras", () => {
  test("isClosed is false initially and true after close", async () => {
    const client = new MockNexusClient();
    expect(client.isClosed).toBe(false);
    await client.close();
    expect(client.isClosed).toBe(true);
  });

  test("mkdir with parents creates intermediate directories", async () => {
    const client = new MockNexusClient();
    await client.mkdir("/a/b/c", { parents: true });
    expect(await client.exists("/a/b/c")).toBe(true);
    expect(await client.exists("/a/b")).toBe(true);
    expect(await client.exists("/a")).toBe(true);
  });

  test("search returns matching results with snippets", async () => {
    const client = new MockNexusClient();
    await client.write("/doc.txt", new TextEncoder().encode("Hello world, this is a test"));
    await client.write("/other.txt", new TextEncoder().encode("Nothing here"));

    const results = await client.search("world");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("/doc.txt");
    expect(results[0].snippet).toContain("world");
  });

  test("search respects path prefix filter", async () => {
    const client = new MockNexusClient();
    await client.write("/a/doc.txt", new TextEncoder().encode("needle"));
    await client.write("/b/doc.txt", new TextEncoder().encode("needle"));

    const results = await client.search("needle", { path: "/a" });
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("/a/doc.txt");
  });

  test("search respects limit", async () => {
    const client = new MockNexusClient();
    await client.write("/a.txt", new TextEncoder().encode("match"));
    await client.write("/b.txt", new TextEncoder().encode("match"));
    await client.write("/c.txt", new TextEncoder().encode("match"));

    const results = await client.search("match", { limit: 2 });
    expect(results.length).toBe(2);
  });
});
