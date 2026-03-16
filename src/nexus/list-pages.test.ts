/**
 * Unit tests for the shared listAllPages helper.
 *
 * Verifies pagination, not-found handling (returns []), and error
 * propagation for auth/network failures (CRIT-3 fix).
 */

import { describe, expect, test } from "bun:test";
import type { ListOptions, ListResult, NexusClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { NexusAuthError, NexusConnectionError, NexusNotFoundError } from "./errors.js";
import { listAllPages } from "./list-pages.js";
import { Semaphore } from "./semaphore.js";

/** Minimal config with no retries and fast tests. */
function makeConfig(client: NexusClient) {
  return resolveConfig({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
  });
}

/** Build a stub NexusClient where only `list` is wired up. */
function stubClient(
  listFn: (path: string, opts?: ListOptions) => Promise<ListResult>,
): NexusClient {
  return {
    list: listFn,
    // The remaining methods are unused by listAllPages — stub them out.
    read: async () => undefined,
    readWithMeta: async () => undefined,
    write: async () => ({ bytesWritten: 0, etag: "e" }),
    exists: async () => false,
    stat: async () => undefined,
    delete: async () => false,
    mkdir: async () => {
      /* no-op */
    },
    search: async () => [],
    close: async () => {
      /* no-op */
    },
  };
}

describe("listAllPages", () => {
  test("returns all entries across multiple pages", async () => {
    let callCount = 0;
    const client = stubClient(async (_path, opts) => {
      callCount++;
      if (callCount === 1 && opts?.cursor === undefined) {
        return {
          files: [
            { name: "a.json", path: "/dir/a.json" },
            { name: "b.json", path: "/dir/b.json" },
          ],
          hasMore: true,
          nextCursor: "cursor-1",
        };
      }
      if (callCount === 2 && opts?.cursor === "cursor-1") {
        return {
          files: [{ name: "c.json", path: "/dir/c.json" }],
          hasMore: false,
          nextCursor: undefined,
        };
      }
      throw new Error(`Unexpected call #${callCount}`);
    });

    const config = makeConfig(client);
    const semaphore = new Semaphore(5);
    const entries = await listAllPages(client, semaphore, config, "/dir");

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.name)).toEqual(["a.json", "b.json", "c.json"]);
    expect(callCount).toBe(2);
  });

  test("returns empty array for non-existent directory", async () => {
    const client = stubClient(async () => {
      throw new NexusNotFoundError("Directory not found: /missing");
    });

    const config = makeConfig(client);
    const semaphore = new Semaphore(5);
    const entries = await listAllPages(client, semaphore, config, "/missing");

    expect(entries).toEqual([]);
  });

  test("propagates auth errors after retry exhaustion", async () => {
    const client = stubClient(async () => {
      throw new NexusAuthError("401 Unauthorized");
    });

    const config = makeConfig(client);
    const semaphore = new Semaphore(5);

    await expect(listAllPages(client, semaphore, config, "/dir")).rejects.toThrow(NexusAuthError);
  });

  test("propagates network errors after retry exhaustion", async () => {
    const client = stubClient(async () => {
      throw new NexusConnectionError("ECONNREFUSED");
    });

    // Allow retries so we verify it exhausts them then throws
    const config = resolveConfig({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    const semaphore = new Semaphore(5);

    await expect(listAllPages(client, semaphore, config, "/dir")).rejects.toThrow(
      NexusConnectionError,
    );
  });

  test("propagates error if page 2 fails", async () => {
    let callCount = 0;
    const client = stubClient(async (_path, opts) => {
      callCount++;
      if (callCount === 1 && opts?.cursor === undefined) {
        return {
          files: [
            { name: "a.json", path: "/dir/a.json" },
            { name: "b.json", path: "/dir/b.json" },
          ],
          hasMore: true,
          nextCursor: "cursor-1",
        };
      }
      // Page 2 throws a connection error
      throw new NexusConnectionError("ECONNRESET on page 2");
    });

    const config = makeConfig(client);
    const semaphore = new Semaphore(5);

    // Must NOT return partial page-1 results — must propagate the error
    await expect(listAllPages(client, semaphore, config, "/dir")).rejects.toThrow(
      NexusConnectionError,
    );
  });
});
