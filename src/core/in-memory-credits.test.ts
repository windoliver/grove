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
});
