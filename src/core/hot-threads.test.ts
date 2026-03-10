/**
 * Conformance tests for hotThreads() store method.
 *
 * Runs against both InMemoryContributionStore and SqliteContributionStore
 * to verify identical behavior across backends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteStores } from "../local/sqlite-store.js";
import { MockNexusClient } from "../nexus/mock-client.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import type { ContributionInput } from "./models.js";
import { ContributionKind, RelationType } from "./models.js";
import type { ContributionStore } from "./store.js";
import { makeContribution } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let uniqueCounter = 0;

function uniqueTimestamp(): string {
  uniqueCounter += 1;
  const hours = Math.floor(uniqueCounter / 3600) % 24;
  const minutes = Math.floor((uniqueCounter % 3600) / 60);
  const seconds = uniqueCounter % 60;
  return `2026-01-01T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}Z`;
}

function makeTimedContribution(overrides?: Partial<ContributionInput>) {
  const ts = uniqueTimestamp();
  return makeContribution({
    summary: `Contribution ${uniqueCounter}`,
    createdAt: ts,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Backend factories
// ---------------------------------------------------------------------------

interface TestBackend {
  store: ContributionStore;
  cleanup: () => void;
}

function createInMemoryBackend(): TestBackend {
  const store = new InMemoryContributionStore();
  return { store, cleanup: () => store.close() };
}

let dbCounter = 0;
const dbPaths: string[] = [];

function createSqliteBackend(): TestBackend {
  dbCounter += 1;
  const dbPath = join(tmpdir(), `grove-hot-threads-test-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(dbPath);
  const { contributionStore, close } = createSqliteStores(dbPath);
  return { store: contributionStore, cleanup: close };
}

afterEach(() => {
  for (const p of dbPaths) {
    try {
      unlinkSync(p);
    } catch {}
    try {
      unlinkSync(`${p}-wal`);
    } catch {}
    try {
      unlinkSync(`${p}-shm`);
    } catch {}
  }
  dbPaths.length = 0;
});

// ---------------------------------------------------------------------------
// Shared test suite
// ---------------------------------------------------------------------------

function hotThreadsTests(createBackend: () => TestBackend): void {
  test("returns empty for store with no replies", async () => {
    const { store, cleanup } = createBackend();
    try {
      const root = makeTimedContribution({ kind: ContributionKind.Discussion });
      await store.put(root);
      const results = await store.hotThreads();
      expect(results).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("returns thread roots with reply counts", async () => {
    const { store, cleanup } = createBackend();
    try {
      const root = makeTimedContribution({ kind: ContributionKind.Discussion });
      await store.put(root);

      const reply1 = makeTimedContribution({
        kind: ContributionKind.Discussion,
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });
      await store.put(reply1);

      const reply2 = makeTimedContribution({
        kind: ContributionKind.Discussion,
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });
      await store.put(reply2);

      const results = await store.hotThreads();
      expect(results).toHaveLength(1);
      expect(results[0]!.contribution.cid).toBe(root.cid);
      expect(results[0]!.replyCount).toBe(2);
      expect(results[0]!.lastReplyAt).toBe(reply2.createdAt);
    } finally {
      cleanup();
    }
  });

  test("sorts by reply count DESC then last reply DESC", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Thread A: 3 replies
      const rootA = makeTimedContribution({ summary: "Thread A" });
      await store.put(rootA);
      for (let i = 0; i < 3; i++) {
        await store.put(
          makeTimedContribution({
            relations: [{ targetCid: rootA.cid, relationType: RelationType.RespondsTo }],
          }),
        );
      }

      // Thread B: 1 reply (but more recent)
      const rootB = makeTimedContribution({ summary: "Thread B" });
      await store.put(rootB);
      await store.put(
        makeTimedContribution({
          relations: [{ targetCid: rootB.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      const results = await store.hotThreads();
      expect(results).toHaveLength(2);
      // A has more replies, so it comes first
      expect(results[0]!.contribution.cid).toBe(rootA.cid);
      expect(results[0]!.replyCount).toBe(3);
      expect(results[1]!.contribution.cid).toBe(rootB.cid);
      expect(results[1]!.replyCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("respects limit", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Create 3 threads
      for (let i = 0; i < 3; i++) {
        const root = makeTimedContribution({ summary: `Thread ${i}` });
        await store.put(root);
        await store.put(
          makeTimedContribution({
            relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
          }),
        );
      }

      const results = await store.hotThreads({ limit: 2 });
      expect(results).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("handles duplicate tags in filter", async () => {
    const { store, cleanup } = createBackend();
    try {
      const tagged = makeTimedContribution({ summary: "Tagged", tags: ["architecture"] });
      await store.put(tagged);
      await store.put(
        makeTimedContribution({
          relations: [{ targetCid: tagged.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      // Duplicate tags should be deduplicated, not cause zero results
      const results = await store.hotThreads({ tags: ["architecture", "architecture"] });
      expect(results).toHaveLength(1);
      expect(results[0]!.contribution.cid).toBe(tagged.cid);
    } finally {
      cleanup();
    }
  });

  test("applies default limit of 20", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Create 25 threads
      for (let i = 0; i < 25; i++) {
        const root = makeTimedContribution({ summary: `Thread ${i}` });
        await store.put(root);
        await store.put(
          makeTimedContribution({
            relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
          }),
        );
      }

      // No explicit limit — should default to 20
      const results = await store.hotThreads();
      expect(results).toHaveLength(20);
    } finally {
      cleanup();
    }
  });

  test("filters by tags", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Tagged thread
      const tagged = makeTimedContribution({ summary: "Architecture", tags: ["architecture"] });
      await store.put(tagged);
      await store.put(
        makeTimedContribution({
          relations: [{ targetCid: tagged.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      // Untagged thread
      const untagged = makeTimedContribution({ summary: "Random" });
      await store.put(untagged);
      await store.put(
        makeTimedContribution({
          relations: [{ targetCid: untagged.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      const results = await store.hotThreads({ tags: ["architecture"] });
      expect(results).toHaveLength(1);
      expect(results[0]!.contribution.cid).toBe(tagged.cid);
    } finally {
      cleanup();
    }
  });

  test("any contribution kind can be a thread root", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Work contribution with discussion replies
      const work = makeTimedContribution({ kind: ContributionKind.Work, summary: "Work item" });
      await store.put(work);
      await store.put(
        makeTimedContribution({
          kind: ContributionKind.Discussion,
          relations: [{ targetCid: work.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      const results = await store.hotThreads();
      expect(results).toHaveLength(1);
      expect(results[0]!.contribution.kind).toBe("work");
    } finally {
      cleanup();
    }
  });

  test("contributions with zero replies are excluded", async () => {
    const { store, cleanup } = createBackend();
    try {
      // Contribution with no replies
      const lonely = makeTimedContribution({ summary: "No replies" });
      await store.put(lonely);

      // Contribution with a reply
      const popular = makeTimedContribution({ summary: "Has reply" });
      await store.put(popular);
      await store.put(
        makeTimedContribution({
          relations: [{ targetCid: popular.cid, relationType: RelationType.RespondsTo }],
        }),
      );

      const results = await store.hotThreads();
      expect(results).toHaveLength(1);
      expect(results[0]!.contribution.cid).toBe(popular.cid);
    } finally {
      cleanup();
    }
  });

  test("empty store returns empty", async () => {
    const { store, cleanup } = createBackend();
    try {
      const results = await store.hotThreads();
      expect(results).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("correctly orders timestamps with timezone offsets", async () => {
    const { store, cleanup } = createBackend();
    try {
      const root = makeTimedContribution({ summary: "Root" });
      await store.put(root);

      // Reply A: 2026-01-01T10:00:00+05:00 = 2026-01-01T05:00:00Z (earlier in UTC)
      const replyA = makeContribution({
        summary: "Reply A (offset)",
        createdAt: "2026-01-01T10:00:00+05:00",
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });
      await store.put(replyA);

      // Reply B: 2026-01-01T06:00:00Z (later in UTC)
      const replyB = makeContribution({
        summary: "Reply B (UTC)",
        createdAt: "2026-01-01T06:00:00Z",
        relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
      });
      await store.put(replyB);

      const results = await store.hotThreads();
      expect(results).toHaveLength(1);
      // lastReplyAt should reflect the truly latest reply (Reply B at 06:00Z),
      // not Reply A which only looks later as a raw string (10:00:00+05:00)
      const lastReplyUtc = new Date(results[0]!.lastReplyAt).getTime();
      const replyBUtc = new Date("2026-01-01T06:00:00Z").getTime();
      expect(lastReplyUtc).toBe(replyBUtc);
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Run against both backends
// ---------------------------------------------------------------------------

describe("hotThreads() — InMemory", () => {
  hotThreadsTests(createInMemoryBackend);
});

describe("hotThreads() — SQLite", () => {
  hotThreadsTests(createSqliteBackend);
});

function createNexusBackend(): TestBackend {
  const client = new MockNexusClient();
  const store = new NexusContributionStore({
    client,
    zoneId: "test-zone",
    retryMaxAttempts: 1,
  });
  return { store, cleanup: () => store.close() };
}

describe("hotThreads() — Nexus", () => {
  hotThreadsTests(createNexusBackend);
});
