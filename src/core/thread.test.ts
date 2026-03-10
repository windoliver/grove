/**
 * Conformance tests for thread() and replyCounts() store methods.
 *
 * Runs the full test suite against both InMemoryContributionStore and
 * SqliteContributionStore to verify identical behavior across backends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteStores } from "../local/sqlite-store.js";
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

function makeThreadContribution(overrides?: Partial<ContributionInput>) {
  const ts = uniqueTimestamp();
  return makeContribution({
    summary: `Thread contribution ${uniqueCounter}`,
    createdAt: ts,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Backend factory types
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
  const dbPath = join(tmpdir(), `grove-thread-test-${Date.now()}-${dbCounter}.db`);
  dbPaths.push(dbPath);
  const { contributionStore, close } = createSqliteStores(dbPath);
  return { store: contributionStore, cleanup: close };
}

afterEach(() => {
  for (const path of dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
  dbPaths.length = 0;
});

// ---------------------------------------------------------------------------
// Conformance test suite — runs against each backend
// ---------------------------------------------------------------------------

const backends: [string, () => TestBackend][] = [
  ["InMemory", createInMemoryBackend],
  ["SQLite", createSqliteBackend],
];

for (const [backendName, createBackend] of backends) {
  describe(`thread() [${backendName}]`, () => {
    // 1. Simple linear thread (A → B → C → D)
    test("linear thread returns ordered nodes with correct depths", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const reply1 = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply 1",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const reply2 = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply 2",
          relations: [{ targetCid: reply1.cid, relationType: RelationType.RespondsTo }],
        });
        const reply3 = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply 3",
          relations: [{ targetCid: reply2.cid, relationType: RelationType.RespondsTo }],
        });

        await store.putMany([root, reply1, reply2, reply3]);
        const nodes = await store.thread(root.cid);

        expect(nodes).toHaveLength(4);
        expect(nodes[0]?.contribution.cid).toBe(root.cid);
        expect(nodes[0]?.depth).toBe(0);
        expect(nodes[1]?.contribution.cid).toBe(reply1.cid);
        expect(nodes[1]?.depth).toBe(1);
        expect(nodes[2]?.contribution.cid).toBe(reply2.cid);
        expect(nodes[2]?.depth).toBe(2);
        expect(nodes[3]?.contribution.cid).toBe(reply3.cid);
        expect(nodes[3]?.depth).toBe(3);
      } finally {
        cleanup();
      }
    });

    // 2. Branching thread (A → B, A → C, B → D)
    test("branching thread returns all branches with correct depths", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const branchA = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Branch A",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const branchB = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Branch B",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const deepReply = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Deep reply",
          relations: [{ targetCid: branchA.cid, relationType: RelationType.RespondsTo }],
        });

        await store.putMany([root, branchA, branchB, deepReply]);
        const nodes = await store.thread(root.cid);

        expect(nodes).toHaveLength(4);
        expect(nodes[0]?.depth).toBe(0); // root
        // Depth-1 nodes (branchA and branchB), ordered chronologically
        const depth1 = nodes.filter((n) => n.depth === 1);
        expect(depth1).toHaveLength(2);
        expect(depth1[0]?.contribution.cid).toBe(branchA.cid);
        expect(depth1[1]?.contribution.cid).toBe(branchB.cid);
        // Depth-2 node
        const depth2 = nodes.filter((n) => n.depth === 2);
        expect(depth2).toHaveLength(1);
        expect(depth2[0]?.contribution.cid).toBe(deepReply.cid);
      } finally {
        cleanup();
      }
    });

    // 3. Single-node thread (root with no replies)
    test("single-node thread returns root at depth 0", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Lonely root" });
        await store.put(root);
        const nodes = await store.thread(root.cid);

        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.contribution.cid).toBe(root.cid);
        expect(nodes[0]?.depth).toBe(0);
      } finally {
        cleanup();
      }
    });

    // 4. Non-existent root CID
    test("non-existent root returns empty array", async () => {
      const { store, cleanup } = createBackend();
      try {
        const nodes = await store.thread("blake3:nonexistent");
        expect(nodes).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    // 5. Root exists but has no responds_to edges
    test("root with other relation types but no responds_to returns only root", async () => {
      const { store, cleanup } = createBackend();
      try {
        const work = makeThreadContribution({ summary: "Work" });
        const review = makeThreadContribution({
          kind: ContributionKind.Review,
          summary: "Review",
          relations: [{ targetCid: work.cid, relationType: RelationType.Reviews }],
        });
        await store.putMany([work, review]);
        const nodes = await store.thread(work.cid);

        // Only root — the review is via 'reviews' not 'responds_to'
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.contribution.cid).toBe(work.cid);
      } finally {
        cleanup();
      }
    });

    // 6. maxDepth: 0 — return only the root
    test("maxDepth 0 returns only root", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const reply = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        await store.putMany([root, reply]);
        const nodes = await store.thread(root.cid, { maxDepth: 0 });

        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.contribution.cid).toBe(root.cid);
        expect(nodes[0]?.depth).toBe(0);
      } finally {
        cleanup();
      }
    });

    // 7. maxDepth: 1 — return root + direct replies
    test("maxDepth 1 returns root and direct replies only", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const reply1 = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply 1",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const deepReply = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Deep reply",
          relations: [{ targetCid: reply1.cid, relationType: RelationType.RespondsTo }],
        });
        await store.putMany([root, reply1, deepReply]);
        const nodes = await store.thread(root.cid, { maxDepth: 1 });

        expect(nodes).toHaveLength(2);
        expect(nodes[0]?.depth).toBe(0);
        expect(nodes[1]?.depth).toBe(1);
        expect(nodes[1]?.contribution.cid).toBe(reply1.cid);
      } finally {
        cleanup();
      }
    });

    // 8. Limit pagination
    test("limit truncates results", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const replies = Array.from({ length: 5 }, (_, i) =>
          makeThreadContribution({
            kind: ContributionKind.Discussion,
            summary: `Reply ${i}`,
            relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
          }),
        );
        await store.put(root);
        await store.putMany(replies);

        const nodes = await store.thread(root.cid, { limit: 3 });
        expect(nodes).toHaveLength(3);
        // First node should be root
        expect(nodes[0]?.depth).toBe(0);
      } finally {
        cleanup();
      }
    });

    // 9. Deep thread (10+ levels)
    test("deep thread with 12 levels has correct depth counting", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        await store.put(root);

        let parentCid = root.cid;
        const allContribs = [root];
        for (let i = 0; i < 12; i++) {
          const reply = makeThreadContribution({
            kind: ContributionKind.Discussion,
            summary: `Depth ${i + 1}`,
            relations: [{ targetCid: parentCid, relationType: RelationType.RespondsTo }],
          });
          await store.put(reply);
          allContribs.push(reply);
          parentCid = reply.cid;
        }

        const nodes = await store.thread(root.cid);
        expect(nodes).toHaveLength(13); // root + 12 replies
        for (let i = 0; i < 13; i++) {
          expect(nodes[i]?.depth).toBe(i);
        }
      } finally {
        cleanup();
      }
    });

    // 10. Wide thread (root with many direct replies)
    test("wide thread with 20 direct replies returns all", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const replies = Array.from({ length: 20 }, (_, i) =>
          makeThreadContribution({
            kind: ContributionKind.Discussion,
            summary: `Reply ${i}`,
            relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
          }),
        );
        await store.put(root);
        await store.putMany(replies);

        const nodes = await store.thread(root.cid);
        expect(nodes).toHaveLength(21); // root + 20 replies
        expect(nodes[0]?.depth).toBe(0);
        for (let i = 1; i <= 20; i++) {
          expect(nodes[i]?.depth).toBe(1);
        }
      } finally {
        cleanup();
      }
    });

    // 11. Chronological ordering within same depth
    test("replies at same depth are ordered chronologically", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({
          summary: "Root",
          createdAt: "2026-01-01T00:00:00Z",
        });
        // Create replies with explicit timestamps to control ordering
        const replyLate = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Late reply",
          createdAt: "2026-01-01T00:02:00Z",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const replyEarly = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Early reply",
          createdAt: "2026-01-01T00:01:00Z",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        // Insert out of order
        await store.putMany([root, replyLate, replyEarly]);

        const nodes = await store.thread(root.cid);
        expect(nodes).toHaveLength(3);
        // Depth-1 nodes should be in chronological order
        expect(nodes[1]?.contribution.summary).toBe("Early reply");
        expect(nodes[2]?.contribution.summary).toBe("Late reply");
      } finally {
        cleanup();
      }
    });

    // 12. Multi-parent deduplication: contribution with multiple responds_to parents
    test("contribution with multiple responds_to parents appears only once at shallowest depth", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const childA = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Child A",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const childB = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Child B",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        // Shared node responds to BOTH childA and childB
        const shared = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Shared reply",
          relations: [
            { targetCid: childA.cid, relationType: RelationType.RespondsTo },
            { targetCid: childB.cid, relationType: RelationType.RespondsTo },
          ],
        });
        await store.putMany([root, childA, childB, shared]);

        const nodes = await store.thread(root.cid);
        // Should have exactly 4 nodes (root, childA, childB, shared) — no duplicates
        expect(nodes).toHaveLength(4);
        const sharedNodes = nodes.filter((n) => n.contribution.cid === shared.cid);
        expect(sharedNodes).toHaveLength(1);
        // Shared should be at depth 2 (shallowest path)
        expect(sharedNodes[0]?.depth).toBe(2);
      } finally {
        cleanup();
      }
    });

    // 13. Parent before children ordering
    test("parents always appear before their children", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const child = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Child",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const grandchild = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Grandchild",
          relations: [{ targetCid: child.cid, relationType: RelationType.RespondsTo }],
        });
        await store.putMany([root, child, grandchild]);

        const nodes = await store.thread(root.cid);
        const cidOrder = nodes.map((n) => n.contribution.cid);
        // Root before child, child before grandchild
        expect(cidOrder.indexOf(root.cid)).toBeLessThan(cidOrder.indexOf(child.cid));
        expect(cidOrder.indexOf(child.cid)).toBeLessThan(cidOrder.indexOf(grandchild.cid));
      } finally {
        cleanup();
      }
    });
  });

  describe(`replyCounts() [${backendName}]`, () => {
    // 13. Batch reply counts for multiple CIDs
    test("returns correct counts for multiple CIDs", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root1 = makeThreadContribution({ summary: "Root 1" });
        const root2 = makeThreadContribution({ summary: "Root 2" });
        // root1 gets 3 replies, root2 gets 1 reply
        const replies1 = Array.from({ length: 3 }, (_, i) =>
          makeThreadContribution({
            kind: ContributionKind.Discussion,
            summary: `Reply to root1 ${i}`,
            relations: [{ targetCid: root1.cid, relationType: RelationType.RespondsTo }],
          }),
        );
        const reply2 = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Reply to root2",
          relations: [{ targetCid: root2.cid, relationType: RelationType.RespondsTo }],
        });

        await store.putMany([root1, root2, ...replies1, reply2]);
        const counts = await store.replyCounts([root1.cid, root2.cid]);

        expect(counts.get(root1.cid)).toBe(3);
        expect(counts.get(root2.cid)).toBe(1);
      } finally {
        cleanup();
      }
    });

    // 14. CID with no replies returns 0
    test("CID with no replies returns 0", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "No replies" });
        await store.put(root);
        const counts = await store.replyCounts([root.cid]);
        expect(counts.get(root.cid)).toBe(0);
      } finally {
        cleanup();
      }
    });

    // 15. Non-existent CID returns 0
    test("non-existent CID returns 0", async () => {
      const { store, cleanup } = createBackend();
      try {
        const counts = await store.replyCounts(["blake3:nonexistent"]);
        expect(counts.get("blake3:nonexistent")).toBe(0);
      } finally {
        cleanup();
      }
    });

    // 16. Only counts direct replies (not nested)
    test("counts only direct replies, not transitive descendants", async () => {
      const { store, cleanup } = createBackend();
      try {
        const root = makeThreadContribution({ summary: "Root" });
        const directReply = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Direct",
          relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
        });
        const nestedReply = makeThreadContribution({
          kind: ContributionKind.Discussion,
          summary: "Nested",
          relations: [{ targetCid: directReply.cid, relationType: RelationType.RespondsTo }],
        });
        await store.putMany([root, directReply, nestedReply]);

        const counts = await store.replyCounts([root.cid]);
        expect(counts.get(root.cid)).toBe(1); // Only direct, not the nested one
      } finally {
        cleanup();
      }
    });

    // Empty input
    test("empty CID list returns empty map", async () => {
      const { store, cleanup } = createBackend();
      try {
        const counts = await store.replyCounts([]);
        expect(counts.size).toBe(0);
      } finally {
        cleanup();
      }
    });

    // Only counts responds_to relations, not other types
    test("ignores non-responds_to relations", async () => {
      const { store, cleanup } = createBackend();
      try {
        const work = makeThreadContribution({ summary: "Work" });
        const review = makeThreadContribution({
          kind: ContributionKind.Review,
          summary: "Review",
          relations: [{ targetCid: work.cid, relationType: RelationType.Reviews }],
        });
        const adoption = makeThreadContribution({
          kind: ContributionKind.Adoption,
          summary: "Adoption",
          relations: [{ targetCid: work.cid, relationType: RelationType.Adopts }],
        });
        await store.putMany([work, review, adoption]);

        const counts = await store.replyCounts([work.cid]);
        expect(counts.get(work.cid)).toBe(0); // reviews and adopts don't count
      } finally {
        cleanup();
      }
    });
  });
}
