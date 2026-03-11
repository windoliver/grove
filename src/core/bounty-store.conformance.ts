/**
 * Conformance test suite for BountyStore implementations.
 *
 * Any backend that implements BountyStore can validate its behavior
 * by calling `runBountyStoreTests()` with a factory that creates
 * fresh store instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BountyStatus } from "./bounty.js";
import type { BountyStore } from "./bounty-store.js";
import { makeBounty, makeAgent, makeReward } from "./test-helpers.js";

/** Factory that creates a fresh BountyStore and returns a cleanup function. */
export type BountyStoreFactory = () => Promise<{
  store: BountyStore;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full BountyStore conformance test suite.
 *
 * Call this from your backend-specific test file with a factory
 * that creates and tears down store instances.
 */
export function runBountyStoreTests(factory: BountyStoreFactory): void {
  describe("BountyStore conformance", () => {
    let store: BountyStore;
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
    // createBounty / getBounty
    // ------------------------------------------------------------------

    test("createBounty stores and returns a bounty", async () => {
      const bounty = makeBounty();
      const result = await store.createBounty(bounty);
      expect(result.bountyId).toBe(bounty.bountyId);
      expect(result.title).toBe(bounty.title);
      expect(result.status).toBe(BountyStatus.Open);
      expect(result.amount).toBe(100);
    });

    test("createBounty throws on duplicate bountyId", async () => {
      const bounty = makeBounty();
      await store.createBounty(bounty);
      await expect(store.createBounty(bounty)).rejects.toThrow();
    });

    test("getBounty returns stored bounty", async () => {
      const bounty = makeBounty();
      await store.createBounty(bounty);
      const retrieved = await store.getBounty(bounty.bountyId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.bountyId).toBe(bounty.bountyId);
      expect(retrieved?.title).toBe(bounty.title);
      expect(retrieved?.creator).toEqual(bounty.creator);
      expect(retrieved?.criteria).toEqual(bounty.criteria);
    });

    test("getBounty returns undefined for non-existent bounty", async () => {
      const result = await store.getBounty("nonexistent");
      expect(result).toBeUndefined();
    });

    test("context round-trip preserves nested values", async () => {
      const bounty = makeBounty({
        bountyId: "ctx-bounty",
        context: {
          hardware: "H100",
          budget: 1000,
          tags: ["ml", "nlp"],
          nested: { a: 1, b: true },
          nullable: null,
        },
      });
      await store.createBounty(bounty);
      const retrieved = await store.getBounty("ctx-bounty");
      expect(retrieved?.context).toEqual(bounty.context);
    });

    // ------------------------------------------------------------------
    // listBounties
    // ------------------------------------------------------------------

    test("listBounties returns all bounties when no query provided", async () => {
      await store.createBounty(makeBounty({ bountyId: "b-1" }));
      await store.createBounty(makeBounty({ bountyId: "b-2" }));
      const all = await store.listBounties();
      expect(all.length).toBe(2);
    });

    test("listBounties filters by single status", async () => {
      await store.createBounty(makeBounty({ bountyId: "b-open", status: BountyStatus.Open }));
      await store.createBounty(makeBounty({ bountyId: "b-draft", status: BountyStatus.Draft }));
      const open = await store.listBounties({ status: BountyStatus.Open });
      expect(open.length).toBe(1);
      expect(open[0]?.bountyId).toBe("b-open");
    });

    test("listBounties filters by multiple statuses", async () => {
      await store.createBounty(makeBounty({ bountyId: "b-open", status: BountyStatus.Open }));
      await store.createBounty(makeBounty({ bountyId: "b-draft", status: BountyStatus.Draft }));
      await store.createBounty(makeBounty({ bountyId: "b-settled", status: BountyStatus.Settled }));
      const active = await store.listBounties({ status: [BountyStatus.Open, BountyStatus.Draft] });
      expect(active.length).toBe(2);
    });

    test("listBounties filters by creatorAgentId", async () => {
      await store.createBounty(makeBounty({
        bountyId: "b-a",
        creator: makeAgent({ agentId: "agent-a" }),
      }));
      await store.createBounty(makeBounty({
        bountyId: "b-b",
        creator: makeAgent({ agentId: "agent-b" }),
      }));
      const results = await store.listBounties({ creatorAgentId: "agent-a" });
      expect(results.length).toBe(1);
      expect(results[0]?.bountyId).toBe("b-a");
    });

    test("listBounties orders by created_at descending", async () => {
      await store.createBounty(makeBounty({
        bountyId: "b-old",
        createdAt: "2026-01-01T00:00:00Z",
      }));
      await store.createBounty(makeBounty({
        bountyId: "b-new",
        createdAt: "2026-01-02T00:00:00Z",
      }));
      const result = await store.listBounties();
      expect(result[0]?.bountyId).toBe("b-new");
      expect(result[1]?.bountyId).toBe("b-old");
    });

    test("listBounties respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await store.createBounty(makeBounty({
          bountyId: `b-${i}`,
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
        }));
      }
      const page = await store.listBounties({ limit: 2, offset: 1 });
      expect(page.length).toBe(2);
    });

    // ------------------------------------------------------------------
    // countBounties
    // ------------------------------------------------------------------

    test("countBounties returns 0 when no bounties exist", async () => {
      const count = await store.countBounties();
      expect(count).toBe(0);
    });

    test("countBounties counts with filters", async () => {
      await store.createBounty(makeBounty({ bountyId: "c-1", status: BountyStatus.Open }));
      await store.createBounty(makeBounty({ bountyId: "c-2", status: BountyStatus.Draft }));
      const count = await store.countBounties({ status: BountyStatus.Open });
      expect(count).toBe(1);
    });

    // ------------------------------------------------------------------
    // State transitions
    // ------------------------------------------------------------------

    test("fundBounty transitions draft to open", async () => {
      const bounty = makeBounty({ bountyId: "fund-1", status: BountyStatus.Draft });
      await store.createBounty(bounty);
      const funded = await store.fundBounty("fund-1", "reservation-123");
      expect(funded.status).toBe(BountyStatus.Open);
      expect(funded.reservationId).toBe("reservation-123");
    });

    test("fundBounty throws for non-draft bounty", async () => {
      const bounty = makeBounty({ bountyId: "fund-2", status: BountyStatus.Open });
      await store.createBounty(bounty);
      await expect(store.fundBounty("fund-2", "res-123")).rejects.toThrow();
    });

    test("claimBounty transitions open to claimed", async () => {
      const bounty = makeBounty({ bountyId: "claim-1", status: BountyStatus.Open });
      await store.createBounty(bounty);
      const claimer = makeAgent({ agentId: "claimer-1" });
      const claimed = await store.claimBounty("claim-1", claimer, "claim-id-1");
      expect(claimed.status).toBe(BountyStatus.Claimed);
      expect(claimed.claimedBy?.agentId).toBe("claimer-1");
      expect(claimed.claimId).toBe("claim-id-1");
    });

    test("claimBounty throws for non-open bounty", async () => {
      const bounty = makeBounty({ bountyId: "claim-2", status: BountyStatus.Draft });
      await store.createBounty(bounty);
      await expect(
        store.claimBounty("claim-2", makeAgent(), "claim-id-2"),
      ).rejects.toThrow();
    });

    test("completeBounty transitions claimed to completed", async () => {
      const bounty = makeBounty({ bountyId: "complete-1", status: BountyStatus.Claimed });
      await store.createBounty(bounty);
      const completed = await store.completeBounty("complete-1", "cid-fulfilled");
      expect(completed.status).toBe(BountyStatus.Completed);
      expect(completed.fulfilledByCid).toBe("cid-fulfilled");
    });

    test("completeBounty throws for non-claimed bounty", async () => {
      const bounty = makeBounty({ bountyId: "complete-2", status: BountyStatus.Open });
      await store.createBounty(bounty);
      await expect(store.completeBounty("complete-2", "cid")).rejects.toThrow();
    });

    test("settleBounty transitions completed to settled", async () => {
      const bounty = makeBounty({ bountyId: "settle-1", status: BountyStatus.Completed });
      await store.createBounty(bounty);
      const settled = await store.settleBounty("settle-1");
      expect(settled.status).toBe(BountyStatus.Settled);
    });

    test("settleBounty throws for non-completed bounty", async () => {
      const bounty = makeBounty({ bountyId: "settle-2", status: BountyStatus.Claimed });
      await store.createBounty(bounty);
      await expect(store.settleBounty("settle-2")).rejects.toThrow();
    });

    test("expireBounty transitions open to expired", async () => {
      const bounty = makeBounty({ bountyId: "expire-1", status: BountyStatus.Open });
      await store.createBounty(bounty);
      const expired = await store.expireBounty("expire-1");
      expect(expired.status).toBe(BountyStatus.Expired);
    });

    test("expireBounty throws for terminal bounty", async () => {
      const bounty = makeBounty({ bountyId: "expire-2", status: BountyStatus.Settled });
      await store.createBounty(bounty);
      await expect(store.expireBounty("expire-2")).rejects.toThrow();
    });

    test("cancelBounty transitions open to cancelled", async () => {
      const bounty = makeBounty({ bountyId: "cancel-1", status: BountyStatus.Open });
      await store.createBounty(bounty);
      const cancelled = await store.cancelBounty("cancel-1");
      expect(cancelled.status).toBe(BountyStatus.Cancelled);
    });

    test("cancelBounty throws for terminal bounty", async () => {
      const bounty = makeBounty({ bountyId: "cancel-2", status: BountyStatus.Settled });
      await store.createBounty(bounty);
      await expect(store.cancelBounty("cancel-2")).rejects.toThrow();
    });

    // ------------------------------------------------------------------
    // Full lifecycle
    // ------------------------------------------------------------------

    test("full lifecycle: draft → open → claimed → completed → settled", async () => {
      const bounty = makeBounty({ bountyId: "lifecycle-1", status: BountyStatus.Draft });
      await store.createBounty(bounty);

      const funded = await store.fundBounty("lifecycle-1", "res-lc");
      expect(funded.status).toBe(BountyStatus.Open);

      const claimed = await store.claimBounty("lifecycle-1", makeAgent({ agentId: "worker" }), "claim-lc");
      expect(claimed.status).toBe(BountyStatus.Claimed);

      const completed = await store.completeBounty("lifecycle-1", "cid-result");
      expect(completed.status).toBe(BountyStatus.Completed);

      const settled = await store.settleBounty("lifecycle-1");
      expect(settled.status).toBe(BountyStatus.Settled);
    });

    // ------------------------------------------------------------------
    // findExpiredBounties
    // ------------------------------------------------------------------

    test("findExpiredBounties returns bounties past deadline", async () => {
      const pastDeadline = new Date(Date.now() - 10_000).toISOString();
      await store.createBounty(makeBounty({
        bountyId: "expired-1",
        status: BountyStatus.Open,
        deadline: pastDeadline,
      }));
      await store.createBounty(makeBounty({
        bountyId: "fresh-1",
        status: BountyStatus.Open,
        deadline: new Date(Date.now() + 60_000).toISOString(),
      }));

      const expired = await store.findExpiredBounties();
      expect(expired.length).toBe(1);
      expect(expired[0]?.bountyId).toBe("expired-1");
    });

    test("findExpiredBounties excludes terminal bounties", async () => {
      const pastDeadline = new Date(Date.now() - 10_000).toISOString();
      await store.createBounty(makeBounty({
        bountyId: "already-settled",
        status: BountyStatus.Settled,
        deadline: pastDeadline,
      }));
      const expired = await store.findExpiredBounties();
      expect(expired.length).toBe(0);
    });

    // ------------------------------------------------------------------
    // Reward records
    // ------------------------------------------------------------------

    test("recordReward stores a reward", async () => {
      const reward = makeReward({ rewardId: "r-1" });
      await store.recordReward(reward);
      const has = await store.hasReward("r-1");
      expect(has).toBe(true);
    });

    test("recordReward is idempotent (same rewardId is no-op)", async () => {
      const reward = makeReward({ rewardId: "r-idem" });
      await store.recordReward(reward);
      await store.recordReward(reward); // should not throw
      const rewards = await store.listRewards();
      const matching = rewards.filter((r) => r.rewardId === "r-idem");
      expect(matching.length).toBe(1);
    });

    test("hasReward returns false for non-existent reward", async () => {
      const has = await store.hasReward("nonexistent");
      expect(has).toBe(false);
    });

    test("listRewards filters by rewardType", async () => {
      await store.recordReward(makeReward({ rewardId: "r-fa", rewardType: "frontier_advance" }));
      await store.recordReward(makeReward({ rewardId: "r-ab", rewardType: "adoption_bonus" }));
      const results = await store.listRewards({ rewardType: "frontier_advance" });
      expect(results.length).toBe(1);
      expect(results[0]?.rewardId).toBe("r-fa");
    });

    test("listRewards filters by recipientAgentId", async () => {
      await store.recordReward(makeReward({
        rewardId: "r-agent-a",
        recipient: makeAgent({ agentId: "agent-a" }),
      }));
      await store.recordReward(makeReward({
        rewardId: "r-agent-b",
        recipient: makeAgent({ agentId: "agent-b" }),
      }));
      const results = await store.listRewards({ recipientAgentId: "agent-a" });
      expect(results.length).toBe(1);
      expect(results[0]?.rewardId).toBe("r-agent-a");
    });

    // ------------------------------------------------------------------
    // updatedAt
    // ------------------------------------------------------------------

    test("state transitions update updatedAt", async () => {
      const bounty = makeBounty({
        bountyId: "update-ts",
        status: BountyStatus.Open,
        updatedAt: "2026-01-01T00:00:00Z",
      });
      await store.createBounty(bounty);

      const claimed = await store.claimBounty("update-ts", makeAgent({ agentId: "w" }), "c-1");
      expect(new Date(claimed.updatedAt).getTime()).toBeGreaterThan(
        new Date("2026-01-01T00:00:00Z").getTime(),
      );
    });

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    test("close does not throw", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
}
