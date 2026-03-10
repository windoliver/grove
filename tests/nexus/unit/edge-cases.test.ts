/**
 * Edge case tests for distributed operation scenarios.
 *
 * Tests failure modes specific to network-backed stores that
 * don't exist in local SQLite implementations.
 */

import { describe, expect, test } from "bun:test";

import { ClaimStatus, RelationType } from "../../../src/core/models.js";
import { makeClaim, makeContribution } from "../../../src/core/test-helpers.js";
import { MockNexusClient } from "../../../src/nexus/mock-client.js";
import { NexusCas } from "../../../src/nexus/nexus-cas.js";
import { NexusClaimStore } from "../../../src/nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../../../src/nexus/nexus-contribution-store.js";

describe("Claim revision tracking", () => {
  test("revision increments on each state transition", async () => {
    const client = new MockNexusClient();
    const store = new NexusClaimStore({
      client,
      zoneId: "revision-test",
      retryMaxAttempts: 1,
    });

    const claim = makeClaim({ claimId: "rev-1", targetRef: "target-1" });
    const created = await store.createClaim(claim);
    expect(created.revision).toBe(1);

    const heartbeated = await store.heartbeat("rev-1");
    expect(heartbeated.revision).toBe(2);

    const heartbeated2 = await store.heartbeat("rev-1");
    expect(heartbeated2.revision).toBe(3);

    const completed = await store.complete("rev-1");
    expect(completed.revision).toBe(4);

    store.close();
    await client.close();
  });

  test("claimOrRenew increments revision on renewal", async () => {
    const client = new MockNexusClient();
    const store = new NexusClaimStore({
      client,
      zoneId: "revision-test",
      retryMaxAttempts: 1,
    });

    const original = makeClaim({
      claimId: "renew-rev",
      targetRef: "renew-target",
      agent: { agentId: "agent-1" },
    });
    const created = await store.createClaim(original);
    expect(created.revision).toBe(1);

    const renewal = makeClaim({
      claimId: "renew-rev-2",
      targetRef: "renew-target",
      agent: { agentId: "agent-1" },
      intentSummary: "renewed",
    });
    const renewed = await store.claimOrRenew(renewal);
    expect(renewed.revision).toBe(2);
    expect(renewed.intentSummary).toBe("renewed");

    store.close();
    await client.close();
  });
});

describe("Zone isolation", () => {
  test("contributions in zone A are invisible in zone B", async () => {
    const client = new MockNexusClient();
    const storeA = new NexusContributionStore({ client, zoneId: "zone-a", retryMaxAttempts: 1 });
    const storeB = new NexusContributionStore({ client, zoneId: "zone-b", retryMaxAttempts: 1 });

    const c = makeContribution({ summary: "zone-a only" });
    await storeA.put(c);

    expect(await storeA.get(c.cid)).toBeDefined();
    expect(await storeB.get(c.cid)).toBeUndefined();

    expect(await storeA.count()).toBe(1);
    expect(await storeB.count()).toBe(0);

    storeA.close();
    storeB.close();
    await client.close();
  });

  test("claims in zone A are invisible in zone B", async () => {
    const client = new MockNexusClient();
    const storeA = new NexusClaimStore({ client, zoneId: "zone-a", retryMaxAttempts: 1 });
    const storeB = new NexusClaimStore({ client, zoneId: "zone-b", retryMaxAttempts: 1 });

    const claim = makeClaim({ claimId: "zone-claim", targetRef: "zone-target" });
    await storeA.createClaim(claim);

    expect(await storeA.getClaim("zone-claim")).toBeDefined();
    expect(await storeB.getClaim("zone-claim")).toBeUndefined();

    expect(await storeA.countActiveClaims()).toBe(1);
    expect(await storeB.countActiveClaims()).toBe(0);

    storeA.close();
    storeB.close();
    await client.close();
  });

  test("CAS blobs in zone A are invisible in zone B", async () => {
    const client = new MockNexusClient();
    const casA = new NexusCas({ client, zoneId: "zone-a", retryMaxAttempts: 1 });
    const casB = new NexusCas({ client, zoneId: "zone-b", retryMaxAttempts: 1 });

    const data = new TextEncoder().encode("zone-scoped blob");
    const hash = await casA.put(data);

    expect(await casA.exists(hash)).toBe(true);
    expect(await casB.exists(hash)).toBe(false);

    expect(await casA.get(hash)).toEqual(data);
    expect(await casB.get(hash)).toBeUndefined();

    casA.close();
    casB.close();
    await client.close();
  });
});

describe("Partial failure in putMany", () => {
  test("putMany stores contributions that succeed before a failure", async () => {
    const client = new MockNexusClient();
    const store = new NexusContributionStore({
      client,
      zoneId: "partial-fail",
      retryMaxAttempts: 1,
    });

    const c1 = makeContribution({ summary: "success-1" });
    const c2 = makeContribution({ summary: "success-2" });
    const c3 = makeContribution({ summary: "will-fail" });

    // Store c1 and c2 first
    await store.put(c1);
    await store.put(c2);

    // Now make the client fail for c3
    client.setFailureMode({ failNext: 10, failWith: "connection" });

    await expect(store.putMany([c3])).rejects.toThrow();

    // c1 and c2 should still be retrievable
    client.setFailureMode(undefined);
    expect(await store.get(c1.cid)).toBeDefined();
    expect(await store.get(c2.cid)).toBeDefined();
    expect(await store.get(c3.cid)).toBeUndefined();

    store.close();
    await client.close();
  });
});

describe("Claim expiry edge cases", () => {
  test("expireStale handles mix of lease-expired and stalled claims", async () => {
    const client = new MockNexusClient();
    const store = new NexusClaimStore({
      client,
      zoneId: "expiry-test",
      retryMaxAttempts: 1,
    });

    // Lease-expired claim
    const leaseExpired = makeClaim({
      claimId: "lease-gone",
      targetRef: "t1",
      leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    await store.createClaim(leaseExpired);

    // Stalled claim (valid lease, old heartbeat)
    const stalled = makeClaim({
      claimId: "stalled",
      targetRef: "t2",
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await store.createClaim(stalled);

    // Fresh claim
    const fresh = makeClaim({
      claimId: "fresh",
      targetRef: "t3",
      leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await store.createClaim(fresh);

    const expired = await store.expireStale({ stallThresholdMs: 60_000 });
    expect(expired.length).toBe(2);

    const expiredIds = expired.map((e) => e.claim.claimId);
    expect(expiredIds).toContain("lease-gone");
    expect(expiredIds).toContain("stalled");

    // Fresh should still be active
    const freshClaim = await store.getClaim("fresh");
    expect(freshClaim?.status).toBe(ClaimStatus.Active);

    store.close();
    await client.close();
  });
});

describe("Thread walking edge cases", () => {
  test("thread returns empty for non-existent root", async () => {
    const client = new MockNexusClient();
    const store = new NexusContributionStore({
      client,
      zoneId: "thread-test",
      retryMaxAttempts: 1,
    });

    const result = await store.thread(
      "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(result.length).toBe(0);

    store.close();
    await client.close();
  });

  test("thread walks responds_to chains", async () => {
    const client = new MockNexusClient();
    const store = new NexusContributionStore({
      client,
      zoneId: "thread-test",
      retryMaxAttempts: 1,
    });

    const root = makeContribution({ summary: "root post" });
    const reply1 = makeContribution({
      summary: "reply 1",
      relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
    });
    const reply2 = makeContribution({
      summary: "reply 2",
      relations: [{ targetCid: root.cid, relationType: RelationType.RespondsTo }],
    });
    const nestedReply = makeContribution({
      summary: "nested reply",
      relations: [{ targetCid: reply1.cid, relationType: RelationType.RespondsTo }],
    });

    await store.putMany([root, reply1, reply2, nestedReply]);

    const thread = await store.thread(root.cid);
    expect(thread.length).toBe(4);
    expect(thread[0]?.depth).toBe(0);
    expect(thread[0]?.contribution.cid).toBe(root.cid);

    // Depth 1 replies
    const depth1 = thread.filter((n) => n.depth === 1);
    expect(depth1.length).toBe(2);

    // Depth 2 nested reply
    const depth2 = thread.filter((n) => n.depth === 2);
    expect(depth2.length).toBe(1);
    expect(depth2[0]?.contribution.cid).toBe(nestedReply.cid);

    store.close();
    await client.close();
  });
});
