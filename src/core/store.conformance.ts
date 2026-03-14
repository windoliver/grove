/**
 * Conformance test suite for ContributionStore implementations.
 *
 * Any backend that implements ContributionStore can validate its behavior
 * by calling `runContributionStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ContributionKind, ContributionMode, RelationType } from "./models.js";
import type { ContributionStore } from "./store.js";
import { makeContribution } from "./test-helpers.js";

/** Factory that creates a fresh ContributionStore and returns a cleanup function. */
export type ContributionStoreFactory = () => Promise<{
  store: ContributionStore;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full ContributionStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates and tears down store instances.
 */
export function runContributionStoreTests(factory: ContributionStoreFactory): void {
  describe("ContributionStore conformance", () => {
    let store: ContributionStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      store.close();
      await cleanup();
    });

    // ------------------------------------------------------------------
    // put / get
    // ------------------------------------------------------------------

    test("put then get returns same contribution", async () => {
      const c = makeContribution({ summary: "hello world" });
      await store.put(c);
      const retrieved = await store.get(c.cid);
      expect(retrieved).toBeDefined();
      expect(retrieved?.cid).toBe(c.cid);
      expect(retrieved?.summary).toBe("hello world");
      expect(retrieved?.kind).toBe(c.kind);
      expect(retrieved?.mode).toBe(c.mode);
      expect(retrieved?.tags).toEqual(c.tags);
      expect(retrieved?.agent).toEqual(c.agent);
      expect(retrieved?.createdAt).toBe(c.createdAt);
    });

    test("put is idempotent for same CID (no error on duplicate)", async () => {
      const c = makeContribution({ summary: "idempotent" });
      await store.put(c);
      await store.put(c); // should not throw
      const retrieved = await store.get(c.cid);
      expect(retrieved).toBeDefined();
      expect(retrieved?.cid).toBe(c.cid);
    });

    test("get returns undefined for non-existent CID", async () => {
      const result = await store.get(
        "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(result).toBeUndefined();
    });

    // ------------------------------------------------------------------
    // putMany
    // ------------------------------------------------------------------

    test("putMany stores multiple contributions in one call", async () => {
      const c1 = makeContribution({ summary: "first" });
      const c2 = makeContribution({ summary: "second" });
      await store.putMany([c1, c2]);
      const r1 = await store.get(c1.cid);
      const r2 = await store.get(c2.cid);
      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(r1?.summary).toBe("first");
      expect(r2?.summary).toBe("second");
    });

    test("putMany is idempotent", async () => {
      const c = makeContribution({ summary: "putMany idempotent" });
      await store.putMany([c]);
      await store.putMany([c]); // should not throw
      const retrieved = await store.get(c.cid);
      expect(retrieved).toBeDefined();
    });

    // ------------------------------------------------------------------
    // getMany
    // ------------------------------------------------------------------

    test("getMany returns found CIDs", async () => {
      const c1 = makeContribution({ summary: "getMany-a" });
      const c2 = makeContribution({ summary: "getMany-b" });
      await store.putMany([c1, c2]);
      const result = await store.getMany([c1.cid, c2.cid]);
      expect(result.size).toBe(2);
      expect(result.get(c1.cid)?.summary).toBe("getMany-a");
      expect(result.get(c2.cid)?.summary).toBe("getMany-b");
    });

    test("getMany omits missing CIDs", async () => {
      const c = makeContribution({ summary: "getMany-exists" });
      await store.put(c);
      const missing = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await store.getMany([c.cid, missing]);
      expect(result.size).toBe(1);
      expect(result.has(c.cid)).toBe(true);
      expect(result.has(missing)).toBe(false);
    });

    test("getMany returns empty map for empty input", async () => {
      const result = await store.getMany([]);
      expect(result.size).toBe(0);
    });

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------

    test("list returns all contributions", async () => {
      const c1 = makeContribution({ summary: "list-a" });
      const c2 = makeContribution({ summary: "list-b" });
      await store.putMany([c1, c2]);
      const all = await store.list();
      expect(all.length).toBe(2);
      const cids = all.map((c) => c.cid);
      expect(cids).toContain(c1.cid);
      expect(cids).toContain(c2.cid);
    });

    test("list filters by kind", async () => {
      const work = makeContribution({
        summary: "work item",
        kind: ContributionKind.Work,
      });
      const review = makeContribution({
        summary: "review item",
        kind: ContributionKind.Review,
      });
      await store.putMany([work, review]);
      const results = await store.list({ kind: ContributionKind.Review });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(review.cid);
    });

    test("list filters by mode", async () => {
      const eval1 = makeContribution({
        summary: "eval item",
        mode: ContributionMode.Evaluation,
      });
      const explore = makeContribution({
        summary: "explore item",
        mode: ContributionMode.Exploration,
      });
      await store.putMany([eval1, explore]);
      const results = await store.list({ mode: ContributionMode.Exploration });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(explore.cid);
    });

    test("list filters by tags (intersection)", async () => {
      const tagged = makeContribution({
        summary: "tagged item",
        tags: ["alpha", "beta", "gamma"],
      });
      const partial = makeContribution({
        summary: "partial tags",
        tags: ["alpha"],
      });
      await store.putMany([tagged, partial]);

      // Query for both alpha AND beta — only tagged should match
      const results = await store.list({ tags: ["alpha", "beta"] });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(tagged.cid);
    });

    test("list filters by agentId", async () => {
      const a1 = makeContribution({
        summary: "agent-1",
        agent: { agentId: "agent-1" },
      });
      const a2 = makeContribution({
        summary: "agent-2",
        agent: { agentId: "agent-2" },
      });
      await store.putMany([a1, a2]);
      const results = await store.list({ agentId: "agent-1" });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(a1.cid);
    });

    test("list filters by agentName", async () => {
      const named = makeContribution({
        summary: "named agent",
        agent: { agentId: "a1", agentName: "Alice" },
      });
      const unnamed = makeContribution({
        summary: "unnamed agent",
        agent: { agentId: "a2" },
      });
      await store.putMany([named, unnamed]);
      const results = await store.list({ agentName: "Alice" });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(named.cid);
    });

    test("list supports limit and offset", async () => {
      const contributions = [];
      for (let i = 0; i < 5; i++) {
        contributions.push(
          makeContribution({
            summary: `item-${i}`,
            createdAt: `2026-01-0${i + 1}T00:00:00Z`,
          }),
        );
      }
      await store.putMany(contributions);

      const page1 = await store.list({ limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = await store.list({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      const page3 = await store.list({ limit: 2, offset: 4 });
      expect(page3.length).toBe(1);
    });

    // ------------------------------------------------------------------
    // children / ancestors
    // ------------------------------------------------------------------

    test("children returns contributions with relations pointing to given CID", async () => {
      const parent = makeContribution({ summary: "parent" });
      const child = makeContribution({
        summary: "child",
        relations: [{ targetCid: parent.cid, relationType: RelationType.DerivesFrom }],
      });
      await store.putMany([parent, child]);

      const children = await store.children(parent.cid);
      expect(children.length).toBe(1);
      expect(children[0]?.cid).toBe(child.cid);
    });

    test("ancestors returns contributions pointed to by given CID's relations", async () => {
      const ancestor = makeContribution({ summary: "ancestor" });
      const descendant = makeContribution({
        summary: "descendant",
        relations: [{ targetCid: ancestor.cid, relationType: RelationType.DerivesFrom }],
      });
      await store.putMany([ancestor, descendant]);

      const ancestors = await store.ancestors(descendant.cid);
      expect(ancestors.length).toBe(1);
      expect(ancestors[0]?.cid).toBe(ancestor.cid);
    });

    // ------------------------------------------------------------------
    // relationsOf / relatedTo
    // ------------------------------------------------------------------

    test("relationsOf returns relations from a CID", async () => {
      const target = makeContribution({ summary: "target" });
      const source = makeContribution({
        summary: "source",
        relations: [
          { targetCid: target.cid, relationType: RelationType.DerivesFrom },
          { targetCid: target.cid, relationType: RelationType.Reviews },
        ],
      });
      await store.putMany([target, source]);

      const rels = await store.relationsOf(source.cid);
      expect(rels.length).toBe(2);
    });

    test("relationsOf filters by relation type", async () => {
      const target = makeContribution({ summary: "target" });
      const source = makeContribution({
        summary: "source",
        relations: [
          { targetCid: target.cid, relationType: RelationType.DerivesFrom },
          { targetCid: target.cid, relationType: RelationType.Reviews },
        ],
      });
      await store.putMany([target, source]);

      const rels = await store.relationsOf(source.cid, RelationType.Reviews);
      expect(rels.length).toBe(1);
      expect(rels[0]?.relationType).toBe(RelationType.Reviews);
    });

    test("relatedTo returns contributions with incoming relations", async () => {
      const target = makeContribution({ summary: "target" });
      const source = makeContribution({
        summary: "source",
        relations: [{ targetCid: target.cid, relationType: RelationType.DerivesFrom }],
      });
      await store.putMany([target, source]);

      const related = await store.relatedTo(target.cid);
      expect(related.length).toBe(1);
      expect(related[0]?.cid).toBe(source.cid);
    });

    // ------------------------------------------------------------------
    // search
    // ------------------------------------------------------------------

    test("search finds by summary text", async () => {
      const c = makeContribution({ summary: "quantum computing breakthrough" });
      await store.put(c);
      const results = await store.search("quantum");
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);
    });

    test("search finds by description text", async () => {
      const c = makeContribution({
        summary: "generic title",
        description: "detailed explanation about photosynthesis",
      });
      await store.put(c);
      const results = await store.search("photosynthesis");
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);
    });

    test("search returns empty for no match", async () => {
      const c = makeContribution({ summary: "something else" });
      await store.put(c);
      const results = await store.search("nonexistentterm");
      expect(results.length).toBe(0);
    });

    test("search respects filters", async () => {
      const work = makeContribution({
        summary: "neural network work",
        kind: ContributionKind.Work,
      });
      const review = makeContribution({
        summary: "neural network review",
        kind: ContributionKind.Review,
      });
      await store.putMany([work, review]);

      const results = await store.search("neural", {
        kind: ContributionKind.Work,
      });
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(work.cid);
    });

    // ------------------------------------------------------------------
    // count
    // ------------------------------------------------------------------

    test("count returns total count", async () => {
      const c1 = makeContribution({ summary: "count-a" });
      const c2 = makeContribution({ summary: "count-b" });
      await store.putMany([c1, c2]);
      const total = await store.count();
      expect(total).toBe(2);
    });

    test("count respects filters", async () => {
      const work = makeContribution({
        summary: "count work",
        kind: ContributionKind.Work,
      });
      const review = makeContribution({
        summary: "count review",
        kind: ContributionKind.Review,
      });
      await store.putMany([work, review]);
      const workCount = await store.count({ kind: ContributionKind.Work });
      expect(workCount).toBe(1);
    });

    // ------------------------------------------------------------------
    // countSince
    // ------------------------------------------------------------------

    test("countSince counts contributions at or after timestamp", async () => {
      const old = makeContribution({
        summary: "old contribution",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const recent = makeContribution({
        summary: "recent contribution",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await store.putMany([old, recent]);
      const count = await store.countSince({ since: "2026-01-01T12:00:00.000Z" });
      expect(count).toBe(1);
    });

    test("countSince filters by agentId", async () => {
      const a1 = makeContribution({
        summary: "agent-1 recent",
        agent: { agentId: "agent-1" },
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const a2 = makeContribution({
        summary: "agent-2 recent",
        agent: { agentId: "agent-2" },
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await store.putMany([a1, a2]);
      const count = await store.countSince({
        agentId: "agent-1",
        since: "2026-01-01T00:00:00.000Z",
      });
      expect(count).toBe(1);
    });

    test("countSince without agentId counts all agents", async () => {
      const a1 = makeContribution({
        summary: "agent-1",
        agent: { agentId: "agent-1" },
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      const a2 = makeContribution({
        summary: "agent-2",
        agent: { agentId: "agent-2" },
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await store.putMany([a1, a2]);
      const count = await store.countSince({ since: "2026-01-01T00:00:00.000Z" });
      expect(count).toBe(2);
    });

    test("countSince returns 0 when no contributions match", async () => {
      const old = makeContribution({
        summary: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await store.put(old);
      const count = await store.countSince({ since: "2026-02-01T00:00:00.000Z" });
      expect(count).toBe(0);
    });

    // ------------------------------------------------------------------
    // findExisting
    // ------------------------------------------------------------------

    test("findExisting finds review by same agent targeting same CID", async () => {
      const target = makeContribution({ summary: "target for review" });
      const review = makeContribution({
        summary: "review of target",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-1" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
      });
      await store.putMany([target, review]);

      const existing = await store.findExisting("reviewer-1", target.cid, ContributionKind.Review);
      expect(existing.length).toBe(1);
      expect(existing[0]?.cid).toBe(review.cid);
    });

    test("findExisting returns empty for different agent", async () => {
      const target = makeContribution({ summary: "target for agent check" });
      const review = makeContribution({
        summary: "review by agent-a",
        kind: ContributionKind.Review,
        agent: { agentId: "agent-a" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
      });
      await store.putMany([target, review]);

      const existing = await store.findExisting("agent-b", target.cid, ContributionKind.Review);
      expect(existing.length).toBe(0);
    });

    test("findExisting returns empty for different kind", async () => {
      const target = makeContribution({ summary: "target for kind check" });
      const work = makeContribution({
        summary: "work deriving from target",
        kind: ContributionKind.Work,
        agent: { agentId: "worker-1" },
        relations: [{ targetCid: target.cid, relationType: RelationType.DerivesFrom }],
      });
      await store.putMany([target, work]);

      const existing = await store.findExisting("worker-1", target.cid, ContributionKind.Review);
      expect(existing.length).toBe(0);
    });

    test("findExisting returns empty for different target", async () => {
      const target1 = makeContribution({ summary: "target 1" });
      const target2 = makeContribution({ summary: "target 2" });
      const review = makeContribution({
        summary: "review of target 1",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-2" },
        relations: [{ targetCid: target1.cid, relationType: RelationType.Reviews }],
      });
      await store.putMany([target1, target2, review]);

      const existing = await store.findExisting("reviewer-2", target2.cid, ContributionKind.Review);
      expect(existing.length).toBe(0);
    });

    test("findExisting filters by relation type when provided", async () => {
      const target = makeContribution({ summary: "target for relation type filter" });
      // Review contribution with a responds_to relation (wrong relation type for review kind)
      const wrongRelation = makeContribution({
        summary: "responds to target but is a review",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-rt" },
        relations: [{ targetCid: target.cid, relationType: RelationType.RespondsTo }],
      });
      // Review contribution with a reviews relation (correct)
      const correctRelation = makeContribution({
        summary: "reviews target correctly",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-rt" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
      });
      await store.putMany([target, wrongRelation, correctRelation]);

      // Without relation type filter → both match
      const all = await store.findExisting("reviewer-rt", target.cid, ContributionKind.Review);
      expect(all.length).toBe(2);

      // With relation type filter → only the correct one matches
      const filtered = await store.findExisting(
        "reviewer-rt",
        target.cid,
        ContributionKind.Review,
        RelationType.Reviews,
      );
      expect(filtered.length).toBe(1);
      expect(filtered[0]?.cid).toBe(correctRelation.cid);
    });

    test("findExisting returns most recent first", async () => {
      const target = makeContribution({ summary: "target for ordering" });
      const review1 = makeContribution({
        summary: "first review",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-3" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-01-01T00:00:00Z",
      });
      const review2 = makeContribution({
        summary: "second review",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-3" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-01-02T00:00:00Z",
      });
      await store.putMany([target, review1, review2]);

      const existing = await store.findExisting("reviewer-3", target.cid, ContributionKind.Review);
      expect(existing.length).toBe(2);
      // Most recent first
      expect(existing[0]?.cid).toBe(review2.cid);
      expect(existing[1]?.cid).toBe(review1.cid);
    });

    test("findExisting orders correctly with offset timestamps", async () => {
      const target = makeContribution({ summary: "target for offset ordering" });
      // These two timestamps represent the same instant but in different formats:
      // 2026-01-02T00:00:00+05:00 == 2026-01-01T19:00:00Z (earlier)
      // 2026-01-01T20:00:00Z (later)
      const earlier = makeContribution({
        summary: "earlier (offset format)",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-tz" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-01-02T00:00:00+05:00",
      });
      const later = makeContribution({
        summary: "later (UTC format)",
        kind: ContributionKind.Review,
        agent: { agentId: "reviewer-tz" },
        relations: [{ targetCid: target.cid, relationType: RelationType.Reviews }],
        createdAt: "2026-01-01T20:00:00Z",
      });
      await store.putMany([target, earlier, later]);

      const existing = await store.findExisting("reviewer-tz", target.cid, ContributionKind.Review);
      expect(existing.length).toBe(2);
      // Later UTC time should be first (most recent)
      expect(existing[0]?.cid).toBe(later.cid);
      expect(existing[1]?.cid).toBe(earlier.cid);
    });

    // ------------------------------------------------------------------
    // Timezone normalization — list ordering with mixed offsets
    // ------------------------------------------------------------------

    test("list() orders correctly with mixed timezone offsets", async () => {
      // A: 2026-01-01T12:00:00+05:30 → UTC 2026-01-01T06:30:00Z (earliest)
      // B: 2026-01-01T08:00:00Z       → UTC 2026-01-01T08:00:00Z
      // C: 2026-01-01T03:00:00-05:00  → UTC 2026-01-01T08:00:00Z (same instant as B)
      //
      // Normalization to UTC Z-format happens in the contribute operation
      // (via toUtcIso), so we pre-normalize here to test store ordering.
      const a = makeContribution({
        summary: "offset-a",
        createdAt: "2026-01-01T06:30:00.000Z",
      });
      const b = makeContribution({
        summary: "offset-b",
        createdAt: "2026-01-01T08:00:00.000Z",
      });
      const c = makeContribution({
        summary: "offset-c",
        createdAt: "2026-01-01T08:00:00.000Z",
      });
      await store.putMany([b, c, a]); // insert out of order

      const all = await store.list();
      expect(all.length).toBe(3);

      // A (06:30) must come first in ascending order
      expect(all[0]?.cid).toBe(a.cid);

      // B and C represent the same UTC instant; both must come after A
      const lastTwoCids = [all[1]?.cid, all[2]?.cid];
      expect(lastTwoCids).toContain(b.cid);
      expect(lastTwoCids).toContain(c.cid);
    });

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    test("close does not throw", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
}
