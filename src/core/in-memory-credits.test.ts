/**
 * Tests for InMemoryCreditsService.
 *
 * Runs the conformance suite + failure injection tests.
 */

import { describe, expect, test } from "bun:test";

import { InsufficientCreditsError, PaymentError } from "./bounty-errors.js";
import { runCreditsServiceTests } from "./credits.conformance.js";
import { InMemoryCreditsService } from "./in-memory-credits.js";

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

runCreditsServiceTests(async () => {
  const service = new InMemoryCreditsService();
  return {
    service,
    seedBalance: async (agentId: string, amount: number) => {
      service.seed(agentId, amount);
    },
    cleanup: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Failure injection tests
// ---------------------------------------------------------------------------

describe("InMemoryCreditsService failure injection", () => {
  test("reserve failure: throws configured error", async () => {
    const service = new InMemoryCreditsService({
      reserve: new PaymentError({ operation: "reserve", message: "Service unavailable" }),
    });
    service.seed("agent-1", 500);

    await expect(
      service.reserve({
        reservationId: "res-fail",
        agentId: "agent-1",
        amount: 100,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("Service unavailable");
  });

  test("capture failure: reserve succeeds but capture fails", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    // Reserve succeeds
    await service.reserve({
      reservationId: "res-1",
      agentId: "agent-1",
      amount: 200,
      timeoutMs: 60_000,
    });

    // Inject capture failure
    service.setFailures({
      capture: new PaymentError({ operation: "capture", message: "Ledger write failed" }),
    });

    // Capture fails
    await expect(service.capture("res-1")).rejects.toThrow("Ledger write failed");

    // Credits still reserved (not captured, not voided)
    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(300);
    expect(bal.reserved).toBe(200);
  });

  test("void failure: throws configured error", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.reserve({
      reservationId: "res-1",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });

    service.setFailures({
      void: new PaymentError({ operation: "void", message: "Void failed" }),
    });

    await expect(service.void("res-1")).rejects.toThrow("Void failed");
  });

  test("transfer failure: throws configured error", async () => {
    const service = new InMemoryCreditsService({
      transfer: new PaymentError({ operation: "transfer", message: "Transfer unavailable" }),
    });
    service.seed("sender", 500);

    await expect(
      service.transfer({
        transferId: "xfer-1",
        fromAgentId: "sender",
        toAgentId: "receiver",
        amount: 100,
      }),
    ).rejects.toThrow("Transfer unavailable");
  });

  test("mid-test failure injection: succeeds then fails then succeeds", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    // First reserve succeeds
    await service.reserve({
      reservationId: "res-1",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });

    // Inject failure
    service.setFailures({
      reserve: new PaymentError({ operation: "reserve", message: "Down" }),
    });

    // Second reserve fails
    await expect(
      service.reserve({
        reservationId: "res-2",
        agentId: "agent-1",
        amount: 100,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("Down");

    // Clear failure
    service.setFailures({});

    // Third reserve succeeds
    const res3 = await service.reserve({
      reservationId: "res-3",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });
    expect(res3.reservationId).toBe("res-3");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("InMemoryCreditsService edge cases", () => {
  test("multiple reservations reduce available balance cumulatively", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.reserve({
      reservationId: "r-1",
      agentId: "agent-1",
      amount: 200,
      timeoutMs: 60_000,
    });
    await service.reserve({
      reservationId: "r-2",
      agentId: "agent-1",
      amount: 200,
      timeoutMs: 60_000,
    });

    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(100);
    expect(bal.reserved).toBe(400);

    // Third reservation exceeding available should fail
    await expect(
      service.reserve({
        reservationId: "r-3",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(InsufficientCreditsError);
  });

  test("capture then void is a no-op (void doesn't restore)", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.reserve({
      reservationId: "r-cv",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });
    await service.capture("r-cv");
    await service.void("r-cv"); // should be no-op

    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(400);
    expect(bal.reserved).toBe(0);
    expect(bal.total).toBe(400);
  });

  test("transfer to self reduces balance (no special handling)", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.transfer({
      transferId: "self-xfer",
      fromAgentId: "agent-1",
      toAgentId: "agent-1",
      amount: 100,
    });

    // Self-transfer: deducted and added back
    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(500);
  });

  test("reserve rejects negative amount", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await expect(
      service.reserve({
        reservationId: "r-neg",
        agentId: "agent-1",
        amount: -50,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("reserve rejects zero amount", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await expect(
      service.reserve({
        reservationId: "r-zero",
        agentId: "agent-1",
        amount: 0,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("reserve rejects non-integer amount", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await expect(
      service.reserve({
        reservationId: "r-float",
        agentId: "agent-1",
        amount: 1.5,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("transfer rejects negative amount", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await expect(
      service.transfer({
        transferId: "xfer-neg",
        fromAgentId: "agent-1",
        toAgentId: "agent-2",
        amount: -10,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("transfer rejects zero amount", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await expect(
      service.transfer({
        transferId: "xfer-zero",
        fromAgentId: "agent-1",
        toAgentId: "agent-2",
        amount: 0,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("reserve idempotency rejects mismatched parameters", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.reserve({
      reservationId: "r-dup",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });

    // Same ID but different amount
    await expect(
      service.reserve({
        reservationId: "r-dup",
        agentId: "agent-1",
        amount: 200,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(PaymentError);

    // Same ID but different agent
    await expect(
      service.reserve({
        reservationId: "r-dup",
        agentId: "agent-2",
        amount: 100,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("transfer idempotency rejects mismatched parameters", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.transfer({
      transferId: "xfer-dup",
      fromAgentId: "agent-1",
      toAgentId: "agent-2",
      amount: 100,
    });

    // Same ID but different destination
    await expect(
      service.transfer({
        transferId: "xfer-dup",
        fromAgentId: "agent-1",
        toAgentId: "agent-3",
        amount: 100,
      }),
    ).rejects.toThrow(PaymentError);

    // Same ID but different amount
    await expect(
      service.transfer({
        transferId: "xfer-dup",
        fromAgentId: "agent-1",
        toAgentId: "agent-2",
        amount: 999,
      }),
    ).rejects.toThrow(PaymentError);
  });

  test("expired reservation releases hold on available balance", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    // Reserve with already-expired timeout
    await service.reserve({
      reservationId: "r-expired",
      agentId: "agent-1",
      amount: 300,
      timeoutMs: -1, // immediately expired
    });

    // The expired reservation should not hold funds
    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(500);
    expect(bal.reserved).toBe(0);
  });

  test("capture with toAgentId atomically credits recipient", async () => {
    const service = new InMemoryCreditsService();
    service.seed("creator", 500);

    await service.reserve({
      reservationId: "r-settle",
      agentId: "creator",
      amount: 200,
      timeoutMs: 60_000,
    });

    // Capture and send to worker
    await service.capture("r-settle", { toAgentId: "worker" });

    const creatorBal = await service.balance("creator");
    expect(creatorBal.total).toBe(300); // 500 - 200
    expect(creatorBal.available).toBe(300);

    const workerBal = await service.balance("worker");
    expect(workerBal.total).toBe(200);
    expect(workerBal.available).toBe(200);
  });

  test("capture rejects expired reservation", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    // Reserve with already-expired timeout
    await service.reserve({
      reservationId: "r-expired-cap",
      agentId: "agent-1",
      amount: 200,
      timeoutMs: -1, // immediately expired
    });

    // Capture should reject — the reservation has expired
    await expect(service.capture("r-expired-cap")).rejects.toThrow("expired");

    // Balance should be unchanged (expired reservation doesn't hold funds)
    const bal = await service.balance("agent-1");
    expect(bal.available).toBe(500);
    expect(bal.total).toBe(500);
  });

  test("idempotent capture rejects mismatched toAgentId", async () => {
    const service = new InMemoryCreditsService();
    service.seed("creator", 500);

    await service.reserve({
      reservationId: "r-idem-cap",
      agentId: "creator",
      amount: 200,
      timeoutMs: 60_000,
    });

    // First capture to worker-a
    await service.capture("r-idem-cap", { toAgentId: "worker-a" });

    // Second capture with different toAgentId should fail
    await expect(
      service.capture("r-idem-cap", { toAgentId: "worker-b" }),
    ).rejects.toThrow(PaymentError);

    // Original capture should remain — worker-a gets the funds
    const workerA = await service.balance("worker-a");
    expect(workerA.total).toBe(200);
    const workerB = await service.balance("worker-b");
    expect(workerB.total).toBe(0);
  });

  test("idempotent capture succeeds when toAgentId matches", async () => {
    const service = new InMemoryCreditsService();
    service.seed("creator", 500);

    await service.reserve({
      reservationId: "r-idem-ok",
      agentId: "creator",
      amount: 100,
      timeoutMs: 60_000,
    });

    await service.capture("r-idem-ok", { toAgentId: "worker" });
    // Same toAgentId — should succeed (no-op)
    await service.capture("r-idem-ok", { toAgentId: "worker" });

    // Balance deducted only once
    const bal = await service.balance("creator");
    expect(bal.total).toBe(400);
  });

  test("idempotent capture rejects adding toAgentId to a no-destination capture", async () => {
    const service = new InMemoryCreditsService();
    service.seed("agent-1", 500);

    await service.reserve({
      reservationId: "r-no-dest",
      agentId: "agent-1",
      amount: 100,
      timeoutMs: 60_000,
    });

    // First capture without toAgentId
    await service.capture("r-no-dest");

    // Retry with toAgentId — should fail
    await expect(
      service.capture("r-no-dest", { toAgentId: "worker" }),
    ).rejects.toThrow(PaymentError);
  });
});
