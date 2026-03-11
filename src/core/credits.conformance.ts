/**
 * Conformance test suite for CreditsService implementations.
 *
 * Any backend that implements CreditsService can validate its behavior
 * by calling `runCreditsServiceTests()` with a factory that creates
 * fresh service instances.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CreditsService } from "./credits.js";

/** Factory that creates a fresh CreditsService and returns a cleanup function. */
export type CreditsServiceFactory = () => Promise<{
  service: CreditsService;
  /** Seed initial balance for an agent. */
  seedBalance: (agentId: string, amount: number) => Promise<void>;
  cleanup: () => Promise<void>;
}>;

/**
 * Run the full CreditsService conformance test suite.
 */
export function runCreditsServiceTests(factory: CreditsServiceFactory): void {
  describe("CreditsService conformance", () => {
    let service: CreditsService;
    let seedBalance: (agentId: string, amount: number) => Promise<void>;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      service = result.service;
      seedBalance = result.seedBalance;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      service.close();
      await cleanup();
    });

    // ------------------------------------------------------------------
    // balance
    // ------------------------------------------------------------------

    test("balance returns zero for unknown agent", async () => {
      const bal = await service.balance("nonexistent");
      expect(bal.available).toBe(0);
      expect(bal.reserved).toBe(0);
      expect(bal.total).toBe(0);
    });

    test("balance returns seeded amount", async () => {
      await seedBalance("agent-1", 500);
      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(500);
      expect(bal.reserved).toBe(0);
      expect(bal.total).toBe(500);
    });

    // ------------------------------------------------------------------
    // reserve
    // ------------------------------------------------------------------

    test("reserve locks credits from available balance", async () => {
      await seedBalance("agent-1", 500);
      const reservation = await service.reserve({
        reservationId: "res-1",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      });
      expect(reservation.reservationId).toBe("res-1");
      expect(reservation.amount).toBe(200);

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(300);
      expect(bal.reserved).toBe(200);
      expect(bal.total).toBe(500);
    });

    test("reserve throws on insufficient balance", async () => {
      await seedBalance("agent-1", 100);
      await expect(
        service.reserve({
          reservationId: "res-fail",
          agentId: "agent-1",
          amount: 200,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(/insufficient/i);
    });

    test("reserve is idempotent (same reservationId)", async () => {
      await seedBalance("agent-1", 500);
      const res1 = await service.reserve({
        reservationId: "res-idem",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      });
      const res2 = await service.reserve({
        reservationId: "res-idem",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      });
      expect(res2.reservationId).toBe(res1.reservationId);

      // Balance should only be reserved once
      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(300);
      expect(bal.reserved).toBe(200);
    });

    // ------------------------------------------------------------------
    // capture
    // ------------------------------------------------------------------

    test("capture finalizes a reservation", async () => {
      await seedBalance("agent-1", 500);
      await service.reserve({
        reservationId: "res-cap",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      });

      await service.capture("res-cap");

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(300);
      expect(bal.reserved).toBe(0);
      expect(bal.total).toBe(300);
    });

    test("capture is idempotent", async () => {
      await seedBalance("agent-1", 500);
      await service.reserve({
        reservationId: "res-cap-idem",
        agentId: "agent-1",
        amount: 100,
        timeoutMs: 60_000,
      });

      await service.capture("res-cap-idem");
      await service.capture("res-cap-idem"); // should not throw or double-deduct

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(400);
      expect(bal.total).toBe(400);
    });

    // ------------------------------------------------------------------
    // void
    // ------------------------------------------------------------------

    test("void releases reserved credits", async () => {
      await seedBalance("agent-1", 500);
      await service.reserve({
        reservationId: "res-void",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      });

      await service.void("res-void");

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(500);
      expect(bal.reserved).toBe(0);
      expect(bal.total).toBe(500);
    });

    test("void is idempotent", async () => {
      await seedBalance("agent-1", 500);
      await service.reserve({
        reservationId: "res-void-idem",
        agentId: "agent-1",
        amount: 100,
        timeoutMs: 60_000,
      });

      await service.void("res-void-idem");
      await service.void("res-void-idem"); // should not throw

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(500);
    });

    test("void after capture is a no-op", async () => {
      await seedBalance("agent-1", 500);
      await service.reserve({
        reservationId: "res-cv",
        agentId: "agent-1",
        amount: 100,
        timeoutMs: 60_000,
      });
      await service.capture("res-cv");
      await service.void("res-cv"); // should not restore credits

      const bal = await service.balance("agent-1");
      expect(bal.available).toBe(400);
      expect(bal.total).toBe(400);
    });

    // ------------------------------------------------------------------
    // transfer
    // ------------------------------------------------------------------

    test("transfer moves credits between agents", async () => {
      await seedBalance("sender", 500);
      await seedBalance("receiver", 100);

      const result = await service.transfer({
        transferId: "xfer-1",
        fromAgentId: "sender",
        toAgentId: "receiver",
        amount: 200,
      });

      expect(result.transferId).toBe("xfer-1");
      expect(result.amount).toBe(200);

      const senderBal = await service.balance("sender");
      expect(senderBal.available).toBe(300);

      const receiverBal = await service.balance("receiver");
      expect(receiverBal.available).toBe(300);
    });

    test("transfer throws on insufficient balance", async () => {
      await seedBalance("sender", 50);
      await expect(
        service.transfer({
          transferId: "xfer-fail",
          fromAgentId: "sender",
          toAgentId: "receiver",
          amount: 200,
        }),
      ).rejects.toThrow(/insufficient/i);
    });

    test("transfer is idempotent (same transferId)", async () => {
      await seedBalance("sender", 500);
      await seedBalance("receiver", 0);

      await service.transfer({
        transferId: "xfer-idem",
        fromAgentId: "sender",
        toAgentId: "receiver",
        amount: 100,
      });
      await service.transfer({
        transferId: "xfer-idem",
        fromAgentId: "sender",
        toAgentId: "receiver",
        amount: 100,
      });

      // Should only transfer once
      const senderBal = await service.balance("sender");
      expect(senderBal.available).toBe(400);
    });

    // ------------------------------------------------------------------
    // close
    // ------------------------------------------------------------------

    test("close does not throw", () => {
      expect(() => service.close()).not.toThrow();
    });
  });
}
