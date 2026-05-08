/**
 * Unit tests for Nexus store adapters.
 *
 * Tests NexusContributionStore, NexusClaimStore, and NexusCas using
 * MockNexusClient for isolated, in-memory testing of store logic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bounty } from "../core/bounty.js";
import { withBountyContentHash } from "../core/content-dedup.js";
import type { Contribution } from "../core/models.js";
import { type ClaimStatus, ContributionKind, RelationType } from "../core/models.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import type { WriteOptions, WriteResult } from "./client.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusBountyStore } from "./nexus-bounty-store.js";
import { NexusCas } from "./nexus-cas.js";
import { NexusClaimStore } from "./nexus-claim-store.js";
import { NexusContributionStore } from "./nexus-contribution-store.js";
import { NexusOutcomeStore } from "./nexus-outcome-store.js";
import { relationIndexDir, relationIndexPath } from "./vfs-paths.js";

// ---------------------------------------------------------------------------
// NexusContributionStore tests
// ---------------------------------------------------------------------------

describe("NexusContributionStore", () => {
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

  describe("put and get", () => {
    test("put stores a contribution and get retrieves it", async () => {
      const c = makeContribution({ summary: "hello world" });
      await store.put(c);
      const retrieved = await store.get(c.cid);
      expect(retrieved).toBeDefined();
      expect(retrieved?.cid).toBe(c.cid);
      expect(retrieved?.summary).toBe("hello world");
    });

    test("get returns undefined for non-existent CID", async () => {
      const result = await store.get(
        "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(result).toBeUndefined();
    });

    test("duplicate put is idempotent", async () => {
      const c = makeContribution({ summary: "idempotent put" });
      await store.put(c);
      await store.put(c); // should not throw
      const retrieved = await store.get(c.cid);
      expect(retrieved).toBeDefined();
      expect(retrieved?.summary).toBe("idempotent put");
    });

    test("same logical payload with different timestamps dedups by content hash", async () => {
      const first = makeContribution({
        summary: "content dedup",
        agent: { agentId: "agent-1" },
        createdAt: "2026-01-01T00:00:00Z",
      });
      const second = makeContribution({
        summary: "content dedup",
        agent: { agentId: "agent-1" },
        createdAt: "2026-01-01T00:00:01Z",
      });

      const firstResult = await store.put(first);
      const secondResult = await store.put(second);

      expect(firstResult.isNew).toBe(true);
      expect(secondResult.isNew).toBe(false);
      expect(secondResult.cid).toBe(first.cid);
      expect(await store.count()).toBe(1);
    });

    test("put with invalid CID throws", async () => {
      const c = makeContribution({ summary: "bad cid" });
      // Tamper with the CID to make it invalid
      const tampered = {
        ...c,
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      };
      await expect(store.put(tampered as Contribution)).rejects.toThrow(
        "CID integrity check failed",
      );
    });
  });

  describe("list", () => {
    test("list returns empty array when no contributions exist", async () => {
      const result = await store.list();
      expect(result).toEqual([]);
    });

    test("list returns all stored contributions", async () => {
      const c1 = makeContribution({ summary: "first", createdAt: "2026-01-01T00:00:00Z" });
      const c2 = makeContribution({ summary: "second", createdAt: "2026-01-02T00:00:00Z" });
      await store.put(c1);
      await store.put(c2);

      const result = await store.list();
      expect(result.length).toBe(2);
    });

    test("list with kind filter narrows results", async () => {
      const work = makeContribution({
        summary: "work item",
        kind: ContributionKind.Work,
        createdAt: "2026-01-01T00:00:00Z",
      });
      const review = makeContribution({
        summary: "review item",
        kind: ContributionKind.Review,
        createdAt: "2026-01-02T00:00:00Z",
      });
      await store.put(work);
      await store.put(review);

      const result = await store.list({ kind: ContributionKind.Review });
      expect(result.length).toBe(1);
      expect(result[0]?.kind).toBe("review");
    });

    test("list with limit returns at most limit items", async () => {
      const c1 = makeContribution({ summary: "a", createdAt: "2026-01-01T00:00:00Z" });
      const c2 = makeContribution({ summary: "b", createdAt: "2026-01-02T00:00:00Z" });
      const c3 = makeContribution({ summary: "c", createdAt: "2026-01-03T00:00:00Z" });
      await store.put(c1);
      await store.put(c2);
      await store.put(c3);

      const result = await store.list({ limit: 2 });
      expect(result.length).toBe(2);
    });

    test("list resolves and does not cache stale results when invalidated mid-scan", async () => {
      class DelayedFtsReadClient extends MockNexusClient {
        private blocked = false;
        private releaseRead: (() => void) | undefined;
        private resolveBlocked: () => void = () => undefined;
        readonly readBlocked = new Promise<void>((resolve) => {
          this.resolveBlocked = resolve;
        });

        releaseBlockedRead(): void {
          this.releaseRead?.();
        }

        override async read(path: string): Promise<Uint8Array | undefined> {
          if (!this.blocked && path.includes("/indexes/fts/")) {
            this.blocked = true;
            this.resolveBlocked();
            await new Promise<void>((resolve) => {
              this.releaseRead = resolve;
            });
          }
          return super.read(path);
        }
      }

      const delayedClient = new DelayedFtsReadClient();
      const delayedStore = new NexusContributionStore({
        client: delayedClient,
        zoneId: "test-zone",
        retryMaxAttempts: 1,
      });
      try {
        const first = makeContribution({
          summary: "first",
          createdAt: "2026-01-01T00:00:00Z",
        });
        const second = makeContribution({
          summary: "second",
          createdAt: "2026-01-02T00:00:00Z",
        });
        await delayedStore.put(first);

        const inFlightList = delayedStore.list();
        await delayedClient.readBlocked;
        await delayedStore.put(second);
        delayedClient.releaseBlockedRead();

        const staleResult = await inFlightList;
        expect(staleResult.map((c) => c.cid)).toEqual([first.cid]);

        const freshResult = await delayedStore.list();
        expect(freshResult.map((c) => c.cid)).toEqual([first.cid, second.cid]);
      } finally {
        delayedStore.close();
        await delayedClient.close();
      }
    });
  });

  describe("children and ancestors", () => {
    test("children returns contributions that reference the given CID", async () => {
      const parent = makeContribution({ summary: "parent", createdAt: "2026-01-01T00:00:00Z" });
      await store.put(parent);

      const child = makeContribution({
        summary: "child",
        relations: [{ targetCid: parent.cid, relationType: RelationType.DerivesFrom }],
        createdAt: "2026-01-02T00:00:00Z",
      });
      await store.put(child);

      const children = await store.children(parent.cid);
      expect(children.length).toBe(1);
      expect(children[0]?.cid).toBe(child.cid);
    });

    test("children returns empty array for CID with no children", async () => {
      const c = makeContribution({ summary: "lonely" });
      await store.put(c);
      const children = await store.children(c.cid);
      expect(children).toEqual([]);
    });

    test("ancestors returns contributions that the given CID references", async () => {
      const ancestor = makeContribution({ summary: "ancestor", createdAt: "2026-01-01T00:00:00Z" });
      await store.put(ancestor);

      const descendant = makeContribution({
        summary: "descendant",
        relations: [{ targetCid: ancestor.cid, relationType: RelationType.DerivesFrom }],
        createdAt: "2026-01-02T00:00:00Z",
      });
      await store.put(descendant);

      const ancestors = await store.ancestors(descendant.cid);
      expect(ancestors.length).toBe(1);
      expect(ancestors[0]?.cid).toBe(ancestor.cid);
    });

    test("ancestors returns empty array for non-existent CID", async () => {
      const result = await store.ancestors(
        "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      );
      expect(result).toEqual([]);
    });

    test("session-scoped replyCounts ignores replies from other sessions", async () => {
      const sessionAStore = new NexusContributionStore({
        client,
        zoneId: "test-zone",
        sessionId: "session-a",
        retryMaxAttempts: 1,
      });
      const sessionBStore = new NexusContributionStore({
        client,
        zoneId: "test-zone",
        sessionId: "session-b",
        retryMaxAttempts: 1,
      });
      try {
        const parent = makeContribution({ summary: "shared parent" });
        await sessionAStore.put(parent);
        await sessionBStore.put(parent);

        const sessionBReply = makeContribution({
          summary: "session b reply",
          relations: [{ targetCid: parent.cid, relationType: RelationType.RespondsTo }],
        });
        await sessionBStore.put(sessionBReply);

        const counts = await sessionAStore.replyCounts([parent.cid]);
        expect(counts.get(parent.cid)).toBe(0);
      } finally {
        sessionAStore.close();
        sessionBStore.close();
      }
    });

    test("session-scoped relations are indexed under the session tree", async () => {
      const sessionStore = new NexusContributionStore({
        client,
        zoneId: "test-zone",
        sessionId: "session-a",
        retryMaxAttempts: 1,
      });
      try {
        const parent = makeContribution({ summary: "session parent" });
        const child = makeContribution({
          summary: "session child",
          relations: [{ targetCid: parent.cid, relationType: RelationType.RespondsTo }],
        });
        await sessionStore.put(parent);
        await sessionStore.put(child);

        const rootRelationEntries = await client.list(relationIndexDir("test-zone", parent.cid));
        const sessionRelationEntries = await client.list(
          relationIndexDir("test-zone", parent.cid, "session-a"),
        );

        expect(rootRelationEntries.files).toEqual([]);
        expect(sessionRelationEntries.files.map((entry) => entry.name)).toEqual([
          `${child.cid}.json`,
        ]);
        expect((await sessionStore.children(parent.cid)).map((c) => c.cid)).toEqual([child.cid]);
      } finally {
        sessionStore.close();
      }
    });

    test("session-scoped readers preserve legacy root relation indexes", async () => {
      const sessionStore = new NexusContributionStore({
        client,
        zoneId: "test-zone",
        sessionId: "session-a",
        retryMaxAttempts: 1,
      });
      try {
        const parent = makeContribution({ summary: "legacy session parent" });
        const child = makeContribution({
          summary: "legacy session child",
          relations: [{ targetCid: parent.cid, relationType: RelationType.RespondsTo }],
        });
        await sessionStore.put(parent);
        await sessionStore.put(child);

        await client.delete(relationIndexPath("test-zone", parent.cid, child.cid, "session-a"));
        await client.write(
          relationIndexPath("test-zone", parent.cid, child.cid),
          new TextEncoder().encode(JSON.stringify({ relationType: RelationType.RespondsTo })),
        );

        expect((await sessionStore.children(parent.cid)).map((c) => c.cid)).toEqual([child.cid]);
        expect((await sessionStore.relatedTo(parent.cid)).map((c) => c.cid)).toEqual([child.cid]);
        expect(
          (await sessionStore.thread(parent.cid)).map((node) => node.contribution.cid),
        ).toEqual([parent.cid, child.cid]);
        expect((await sessionStore.replyCounts([parent.cid])).get(parent.cid)).toBe(1);
      } finally {
        sessionStore.close();
      }
    });

    test("session-scoped readers deduplicate dual relation indexes", async () => {
      const sessionStore = new NexusContributionStore({
        client,
        zoneId: "test-zone",
        sessionId: "session-a",
        retryMaxAttempts: 1,
      });
      try {
        const parent = makeContribution({ summary: "dual-index parent" });
        const child = makeContribution({
          summary: "dual-index child",
          relations: [{ targetCid: parent.cid, relationType: RelationType.RespondsTo }],
        });
        await sessionStore.put(parent);
        await sessionStore.put(child);
        await client.write(
          relationIndexPath("test-zone", parent.cid, child.cid),
          new TextEncoder().encode(JSON.stringify({ relationType: RelationType.RespondsTo })),
        );

        expect((await sessionStore.children(parent.cid)).map((c) => c.cid)).toEqual([child.cid]);
        expect(
          (await sessionStore.findExisting(child.agent.agentId, parent.cid, child.kind)).map(
            (c) => c.cid,
          ),
        ).toEqual([child.cid]);
        expect((await sessionStore.replyCounts([parent.cid])).get(parent.cid)).toBe(1);
      } finally {
        sessionStore.close();
      }
    });
  });

  describe("search", () => {
    test("search finds contribution by summary text", async () => {
      const c = makeContribution({
        summary: "unique search term xyzzy",
        createdAt: "2026-01-01T00:00:00Z",
      });
      await store.put(c);

      const results = await store.search("xyzzy");
      expect(results.length).toBe(1);
      expect(results[0]?.cid).toBe(c.cid);
    });

    test("search returns empty array when no match", async () => {
      const c = makeContribution({ summary: "no match here" });
      await store.put(c);

      const results = await store.search("nonexistent_query_12345");
      expect(results).toEqual([]);
    });
  });

  describe("count", () => {
    test("count returns 0 for empty store", async () => {
      expect(await store.count()).toBe(0);
    });

    test("count returns correct number after multiple puts", async () => {
      const c1 = makeContribution({ summary: "cnt-1", createdAt: "2026-01-01T00:00:00Z" });
      const c2 = makeContribution({ summary: "cnt-2", createdAt: "2026-01-02T00:00:00Z" });
      await store.put(c1);
      await store.put(c2);
      expect(await store.count()).toBe(2);
    });
  });
});

describe("NexusBountyStore", () => {
  let client: MockNexusClient;
  let store: NexusBountyStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusBountyStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  function bounty(overrides?: Partial<Bounty>): Bounty {
    return {
      bountyId: overrides?.bountyId ?? crypto.randomUUID(),
      title: overrides?.title ?? "Retry-safe bounty",
      description: overrides?.description ?? "Retry-safe bounty",
      status: overrides?.status ?? "open",
      creator: overrides?.creator ?? { agentId: "agent-1" },
      amount: overrides?.amount ?? 10,
      criteria: overrides?.criteria ?? { description: "Do one thing" },
      deadline: overrides?.deadline ?? "2026-02-01T00:00:00Z",
      createdAt: overrides?.createdAt ?? "2026-01-01T00:00:00Z",
      updatedAt: overrides?.updatedAt ?? "2026-01-01T00:00:00Z",
      ...(overrides?.zoneId !== undefined ? { zoneId: overrides.zoneId } : {}),
      ...(overrides?.context !== undefined ? { context: overrides.context } : {}),
    };
  }

  test("same logical create payload dedups by content hash", async () => {
    const first = bounty({ bountyId: "bounty-1", createdAt: "2026-01-01T00:00:00Z" });
    const second = bounty({ bountyId: "bounty-2", createdAt: "2026-01-01T00:00:01Z" });

    const firstResult = (await store.createBounty(withBountyContentHash(first))) as Bounty & {
      readonly isNew?: boolean;
    };
    const secondResult = (await store.createBounty(withBountyContentHash(second))) as Bounty & {
      readonly isNew?: boolean;
    };

    expect(firstResult.isNew).toBe(true);
    expect(secondResult.isNew).toBe(false);
    expect(secondResult.bountyId).toBe(first.bountyId);
    expect(await store.countBounties()).toBe(1);
  });
});

describe("NexusOutcomeStore", () => {
  let client: MockNexusClient;
  let store: NexusOutcomeStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusOutcomeStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  test("same logical outcome set reports duplicate", async () => {
    const first = await store.set("cid-1", {
      status: "accepted",
      reason: "Looks good",
      evaluatedBy: "agent-1",
    });
    const second = (await store.set("cid-1", {
      status: "accepted",
      reason: "Looks good",
      evaluatedBy: "agent-1",
    })) as typeof first & { readonly isNew?: boolean };

    expect((first as typeof first & { readonly isNew?: boolean }).isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(await store.getStats()).toMatchObject({ total: 1, accepted: 1 });
  });
});

// ---------------------------------------------------------------------------
// NexusClaimStore tests
// ---------------------------------------------------------------------------

describe("NexusClaimStore", () => {
  let client: MockNexusClient;
  let store: NexusClaimStore;

  beforeEach(() => {
    client = new MockNexusClient();
    store = new NexusClaimStore({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    store.close();
    await client.close();
  });

  describe("createClaim", () => {
    test("creates a new claim and returns it with revision 1", async () => {
      const claim = makeClaim({ claimId: "c1", targetRef: "t1" });
      const created = await store.createClaim(claim);
      expect(created.claimId).toBe("c1");
      expect(created.status).toBe("active");
      expect(created.revision).toBe(1);
    });

    test("duplicate claimId throws", async () => {
      const claim = makeClaim({ claimId: "dup", targetRef: "t1" });
      await store.createClaim(claim);

      const claim2 = makeClaim({ claimId: "dup", targetRef: "t2" });
      await expect(store.createClaim(claim2)).rejects.toThrow("already exists");
    });

    test("same targetRef with different claim throws", async () => {
      const claim1 = makeClaim({ claimId: "c1", targetRef: "shared-target" });
      await store.createClaim(claim1);

      const claim2 = makeClaim({
        claimId: "c2",
        targetRef: "shared-target",
        agent: { agentId: "other-agent" },
      });
      await expect(store.createClaim(claim2)).rejects.toThrow("already has an active claim");
    });

    test("getClaim retrieves created claim", async () => {
      const claim = makeClaim({ claimId: "get-test", targetRef: "t1" });
      await store.createClaim(claim);
      const retrieved = await store.getClaim("get-test");
      expect(retrieved).toBeDefined();
      expect(retrieved?.claimId).toBe("get-test");
    });

    test("getClaim returns undefined for non-existent claim", async () => {
      const result = await store.getClaim("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("claimOrRenew", () => {
    test("creates new claim when no active claim on target", async () => {
      const claim = makeClaim({ claimId: "cor-1", targetRef: "cor-target" });
      const result = await store.claimOrRenew(claim);
      expect(result.claimId).toBe("cor-1");
      expect(result.revision).toBe(1);
    });

    test("renews existing claim when same agent has active claim", async () => {
      const original = makeClaim({
        claimId: "cor-orig",
        targetRef: "cor-shared",
        agent: { agentId: "agent-A" },
        intentSummary: "original intent",
      });
      await store.createClaim(original);

      const renewal = makeClaim({
        claimId: "cor-renewal",
        targetRef: "cor-shared",
        agent: { agentId: "agent-A" },
        intentSummary: "updated intent",
      });
      const renewed = await store.claimOrRenew(renewal);
      // Should renew the existing claim, not create a new one
      expect(renewed.claimId).toBe("cor-orig");
      expect(renewed.intentSummary).toBe("updated intent");
      expect(renewed.revision).toBe(2);
    });

    test("throws when different agent has active claim on target", async () => {
      const existing = makeClaim({
        claimId: "cor-existing",
        targetRef: "contested-target",
        agent: { agentId: "agent-A" },
      });
      await store.createClaim(existing);

      const competing = makeClaim({
        claimId: "cor-competing",
        targetRef: "contested-target",
        agent: { agentId: "agent-B" },
      });
      await expect(store.claimOrRenew(competing)).rejects.toThrow();
    });
  });

  describe("heartbeat", () => {
    test("heartbeat updates heartbeatAt and extends lease", async () => {
      const claim = makeClaim({ claimId: "hb-1", targetRef: "hb-target" });
      const created = await store.createClaim(claim);
      const originalHeartbeat = created.heartbeatAt;

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 5));
      const heartbeated = await store.heartbeat("hb-1");
      expect(heartbeated.revision).toBe(2);
      expect(new Date(heartbeated.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalHeartbeat).getTime(),
      );
    });

    test("heartbeat on non-existent claim throws", async () => {
      await expect(store.heartbeat("nonexistent")).rejects.toThrow("not found");
    });

    test("heartbeat on released claim throws", async () => {
      const claim = makeClaim({ claimId: "hb-released", targetRef: "hb-target-2" });
      await store.createClaim(claim);
      await store.release("hb-released");
      await expect(store.heartbeat("hb-released")).rejects.toThrow("must be active");
    });
  });

  describe("release", () => {
    test("release transitions claim to released status", async () => {
      const claim = makeClaim({ claimId: "rel-1", targetRef: "rel-target" });
      await store.createClaim(claim);

      const released = await store.release("rel-1");
      expect(released.status).toBe("released");
      expect(released.revision).toBe(2);
    });

    test("release on non-existent claim throws", async () => {
      await expect(store.release("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("complete", () => {
    test("complete transitions claim to completed status", async () => {
      const claim = makeClaim({ claimId: "comp-1", targetRef: "comp-target" });
      await store.createClaim(claim);

      const completed = await store.complete("comp-1");
      expect(completed.status).toBe("completed");
      expect(completed.revision).toBe(2);
    });

    test("complete on already-completed claim throws", async () => {
      const claim = makeClaim({ claimId: "comp-dup", targetRef: "comp-target-2" });
      await store.createClaim(claim);
      await store.complete("comp-dup");
      await expect(store.complete("comp-dup")).rejects.toThrow("must be active");
    });
  });

  describe("activeClaims", () => {
    test("returns all active claims", async () => {
      const c1 = makeClaim({ claimId: "ac-1", targetRef: "ac-target-1" });
      const c2 = makeClaim({ claimId: "ac-2", targetRef: "ac-target-2" });
      await store.createClaim(c1);
      await store.createClaim(c2);

      const active = await store.activeClaims();
      expect(active.length).toBe(2);
    });

    test("does not include released claims", async () => {
      const c1 = makeClaim({ claimId: "ac-3", targetRef: "ac-target-3" });
      const c2 = makeClaim({ claimId: "ac-4", targetRef: "ac-target-4" });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.release("ac-3");

      const active = await store.activeClaims();
      expect(active.length).toBe(1);
      expect(active[0]?.claimId).toBe("ac-4");
    });

    test("filters by targetRef when provided", async () => {
      const c1 = makeClaim({ claimId: "ac-5", targetRef: "target-A" });
      const c2 = makeClaim({ claimId: "ac-6", targetRef: "target-B" });
      await store.createClaim(c1);
      await store.createClaim(c2);

      const active = await store.activeClaims("target-A");
      expect(active.length).toBe(1);
      expect(active[0]?.claimId).toBe("ac-5");
    });

    test("returns empty array when no claims exist", async () => {
      const active = await store.activeClaims();
      expect(active).toEqual([]);
    });
  });

  describe("expireStale", () => {
    test("expires claims with past leaseExpiresAt", async () => {
      const expiredClaim = makeClaim({
        claimId: "stale-1",
        targetRef: "stale-target",
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 10_000).toISOString(),
      });
      await store.createClaim(expiredClaim);

      const expired = await store.expireStale();
      expect(expired.length).toBe(1);
      expect(expired[0]?.claim.claimId).toBe("stale-1");
      expect(expired[0]?.claim.status).toBe("expired");
      expect(expired[0]?.reason).toBe("lease_expired");
    });

    test("does not expire claims with future lease", async () => {
      const freshClaim = makeClaim({
        claimId: "fresh-1",
        targetRef: "fresh-target",
      });
      await store.createClaim(freshClaim);

      const expired = await store.expireStale();
      expect(expired.length).toBe(0);
    });

    test("returns empty array when no claims exist", async () => {
      const expired = await store.expireStale();
      expect(expired).toEqual([]);
    });
  });

  describe("listClaims", () => {
    test("lists claims filtered by status", async () => {
      const c1 = makeClaim({ claimId: "lc-1", targetRef: "lc-t1" });
      const c2 = makeClaim({ claimId: "lc-2", targetRef: "lc-t2" });
      await store.createClaim(c1);
      await store.createClaim(c2);
      await store.release("lc-1");

      const released = await store.listClaims({ status: "released" as ClaimStatus });
      expect(released.length).toBe(1);
      expect(released[0]?.claimId).toBe("lc-1");
    });
  });
});

// ---------------------------------------------------------------------------
// NexusCas tests
// ---------------------------------------------------------------------------

describe("NexusCas", () => {
  let client: MockNexusClient;
  let cas: NexusCas;

  beforeEach(() => {
    client = new MockNexusClient();
    cas = new NexusCas({
      client,
      zoneId: "test-zone",
      retryMaxAttempts: 1,
    });
  });

  afterEach(async () => {
    cas.close();
    await client.close();
  });

  describe("put and get", () => {
    test("put stores data and returns content hash", async () => {
      const data = new TextEncoder().encode("hello cas");
      const hash = await cas.put(data);
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);
    });

    test("get retrieves stored data by hash", async () => {
      const original = new TextEncoder().encode("retrieve me");
      const hash = await cas.put(original);

      const retrieved = await cas.get(hash);
      expect(retrieved).toBeDefined();
      expect(new TextDecoder().decode(retrieved as Uint8Array)).toBe("retrieve me");
    });

    test("get returns undefined for non-existent hash", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await cas.get(fakeHash);
      expect(result).toBeUndefined();
    });

    test("put same content twice returns same hash", async () => {
      const data = new TextEncoder().encode("dedup test");
      const hash1 = await cas.put(data);
      const hash2 = await cas.put(data);
      expect(hash1).toBe(hash2);
    });

    test("put with mediaType stores metadata", async () => {
      const data = new TextEncoder().encode('{"key": "value"}');
      const hash = await cas.put(data, { mediaType: "application/json" });

      const stat = await cas.stat(hash);
      expect(stat).toBeDefined();
      expect(stat?.mediaType).toBe("application/json");
    });
  });

  describe("stat", () => {
    test("stat returns artifact metadata for stored content", async () => {
      const data = new TextEncoder().encode("stat me");
      const hash = await cas.put(data);

      const artifact = await cas.stat(hash);
      expect(artifact).toBeDefined();
      expect(artifact?.contentHash).toBe(hash);
      expect(artifact?.sizeBytes).toBe(7); // "stat me" is 7 bytes
    });

    test("stat returns undefined for non-existent hash", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await cas.stat(fakeHash);
      expect(result).toBeUndefined();
    });

    test("stat throws for invalid hash format", async () => {
      await expect(cas.stat("invalid-hash")).rejects.toThrow("Invalid content hash prefix");
    });
  });

  describe("delete", () => {
    test("delete removes stored content", async () => {
      const data = new TextEncoder().encode("delete me");
      const hash = await cas.put(data);

      expect(await cas.exists(hash)).toBe(true);
      const deleted = await cas.delete(hash);
      expect(deleted).toBe(true);
      expect(await cas.exists(hash)).toBe(false);
    });

    test("delete returns false for non-existent hash", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      const result = await cas.delete(fakeHash);
      expect(result).toBe(false);
    });

    test("get returns undefined after delete", async () => {
      const data = new TextEncoder().encode("transient");
      const hash = await cas.put(data);
      await cas.delete(hash);
      const result = await cas.get(hash);
      expect(result).toBeUndefined();
    });
  });

  describe("exists", () => {
    test("exists returns true for stored content", async () => {
      const data = new TextEncoder().encode("exists check");
      const hash = await cas.put(data);
      expect(await cas.exists(hash)).toBe(true);
    });

    test("exists returns false for non-existent content", async () => {
      const fakeHash = "blake3:0000000000000000000000000000000000000000000000000000000000000000";
      expect(await cas.exists(fakeHash)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("put empty data", async () => {
      const data = new Uint8Array(0);
      const hash = await cas.put(data);
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

      const retrieved = await cas.get(hash);
      expect(retrieved).toBeDefined();
      expect(retrieved?.byteLength).toBe(0);
    });

    test("put binary data preserves content", async () => {
      const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const hash = await cas.put(data);
      const retrieved = await cas.get(hash);
      expect(retrieved).toEqual(data);
    });

    test("putFile serializes memory-heavy blob writes", async () => {
      class TrackingClient extends MockNexusClient {
        activeBlobWrites = 0;
        maxActiveBlobWrites = 0;

        override async write(
          path: string,
          content: Uint8Array,
          opts?: WriteOptions,
        ): Promise<WriteResult> {
          const isBlob = path.includes("/cas/") && !path.endsWith(".meta");
          if (!isBlob) return super.write(path, content, opts);

          this.activeBlobWrites += 1;
          this.maxActiveBlobWrites = Math.max(this.maxActiveBlobWrites, this.activeBlobWrites);
          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return await super.write(path, content, opts);
          } finally {
            this.activeBlobWrites -= 1;
          }
        }
      }

      const trackingClient = new TrackingClient();
      const trackingCas = new NexusCas({
        client: trackingClient,
        zoneId: "test-zone",
        retryMaxAttempts: 1,
        maxConcurrency: 20,
      });
      const dir = await mkdtemp(join(tmpdir(), "grove-nexus-cas-test-"));
      try {
        const first = join(dir, "first.bin");
        const second = join(dir, "second.bin");
        await writeFile(first, new Uint8Array([1, 2, 3]));
        await writeFile(second, new Uint8Array([4, 5, 6]));

        await Promise.all([trackingCas.putFile(first), trackingCas.putFile(second)]);

        expect(trackingClient.maxActiveBlobWrites).toBe(1);
      } finally {
        trackingCas.close();
        await trackingClient.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
