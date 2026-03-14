/**
 * Unit tests for Nexus store adapters.
 *
 * Tests NexusContributionStore, NexusClaimStore, and NexusCas using
 * MockNexusClient for isolated, in-memory testing of store logic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Contribution } from "../core/models.js";
import { type ClaimStatus, ContributionKind, RelationType } from "../core/models.js";
import { makeClaim, makeContribution } from "../core/test-helpers.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusCas } from "./nexus-cas.js";
import { NexusClaimStore } from "./nexus-claim-store.js";
import { NexusContributionStore } from "./nexus-contribution-store.js";

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
  });
});
