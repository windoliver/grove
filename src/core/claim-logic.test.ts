/**
 * Unit tests for claim validation and state-transition logic.
 *
 * These functions are pure and critical — they enforce the claim
 * state machine used by both the local SQLite adapter and the
 * Nexus adapter.
 */

import { describe, expect, test } from "bun:test";

import {
  computeLeaseDuration,
  DEFAULT_LEASE_DURATION_MS,
  isClaimActiveAndValid,
  resolveClaimOrRenew,
  validateClaimContext,
  validateHeartbeat,
  validateTransition,
} from "./claim-logic.js";
import { ClaimConflictError } from "./errors.js";
import type { Claim, ClaimStatus } from "./models.js";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: "claim-1",
    targetRef: "target-1",
    agent: { agentId: "agent-1" },
    status: "active",
    intentSummary: "test",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateClaimContext
// ---------------------------------------------------------------------------

describe("validateClaimContext", () => {
  test("accepts claim with no context field", () => {
    const claim = makeClaim();
    expect(() => validateClaimContext(claim)).not.toThrow();
  });

  test("accepts claim with undefined context", () => {
    const claim = makeClaim({ context: undefined });
    expect(() => validateClaimContext(claim)).not.toThrow();
  });

  test("accepts claim with valid JSON-safe context", () => {
    const claim = makeClaim({
      context: {
        key: "value",
        nested: { a: 1, b: true, c: null, d: [1, "two", false] },
      },
    });
    expect(() => validateClaimContext(claim)).not.toThrow();
  });

  test("accepts claim with empty context object", () => {
    const claim = makeClaim({ context: {} });
    expect(() => validateClaimContext(claim)).not.toThrow();
  });

  test("rejects claim with non-JSON context value (Infinity)", () => {
    // Infinity is not JSON-serialisable — the schema rejects non-finite numbers
    const claim = makeClaim({
      context: { bad: Infinity } as unknown as Record<string, string>,
    });
    expect(() => validateClaimContext(claim)).toThrow(/Invalid claim context/);
  });

  test("rejects claim with NaN context value", () => {
    const claim = makeClaim({
      context: { bad: NaN } as unknown as Record<string, string>,
    });
    expect(() => validateClaimContext(claim)).toThrow(/Invalid claim context/);
  });

  test("rejects claim with function context value", () => {
    const claim = makeClaim({
      context: { fn: (() => undefined) as unknown } as unknown as Record<string, string>,
    });
    expect(() => validateClaimContext(claim)).toThrow(/Invalid claim context/);
  });
});

// ---------------------------------------------------------------------------
// isClaimActiveAndValid
// ---------------------------------------------------------------------------

describe("isClaimActiveAndValid", () => {
  test("returns true for active claim with future lease", () => {
    const claim = makeClaim();
    expect(isClaimActiveAndValid(claim)).toBe(true);
  });

  test("returns false for active claim with expired lease", () => {
    const claim = makeClaim({
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isClaimActiveAndValid(claim)).toBe(false);
  });

  test("returns true at exact lease boundary (expiry === now)", () => {
    const now = new Date();
    const claim = makeClaim({
      leaseExpiresAt: now.toISOString(),
    });
    // At the exact boundary getTime() >= getTime() is true
    expect(isClaimActiveAndValid(claim, now)).toBe(true);
  });

  test("returns false for released claim with future lease", () => {
    const claim = makeClaim({ status: "released" });
    expect(isClaimActiveAndValid(claim)).toBe(false);
  });

  test("returns false for completed claim with future lease", () => {
    const claim = makeClaim({ status: "completed" });
    expect(isClaimActiveAndValid(claim)).toBe(false);
  });

  test("returns false for expired claim with future lease", () => {
    const claim = makeClaim({ status: "expired" });
    expect(isClaimActiveAndValid(claim)).toBe(false);
  });

  test("uses provided 'now' parameter instead of wall clock", () => {
    const claim = makeClaim({
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    const futureNow = new Date("2031-01-01T00:00:00.000Z");
    expect(isClaimActiveAndValid(claim, futureNow)).toBe(false);

    const pastNow = new Date("2029-01-01T00:00:00.000Z");
    expect(isClaimActiveAndValid(claim, pastNow)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateHeartbeat
// ---------------------------------------------------------------------------

describe("validateHeartbeat", () => {
  test("succeeds for active claim with valid lease", () => {
    const claim = makeClaim();
    expect(() => validateHeartbeat(claim, "claim-1")).not.toThrow();
  });

  test("throws when claim is undefined (not found)", () => {
    expect(() => validateHeartbeat(undefined, "claim-99")).toThrow("Claim 'claim-99' not found");
  });

  test("throws for released claim", () => {
    const claim = makeClaim({ status: "released" });
    expect(() => validateHeartbeat(claim, "claim-1")).toThrow(
      "Cannot heartbeat claim 'claim-1' with status 'released' (must be active)",
    );
  });

  test("throws for completed claim", () => {
    const claim = makeClaim({ status: "completed" });
    expect(() => validateHeartbeat(claim, "claim-1")).toThrow(
      "Cannot heartbeat claim 'claim-1' with status 'completed' (must be active)",
    );
  });

  test("throws for expired claim", () => {
    const claim = makeClaim({ status: "expired" });
    expect(() => validateHeartbeat(claim, "claim-1")).toThrow(
      "Cannot heartbeat claim 'claim-1' with status 'expired' (must be active)",
    );
  });

  test("throws for active claim with expired lease", () => {
    const expiredLease = new Date(Date.now() - 1000).toISOString();
    const claim = makeClaim({ leaseExpiresAt: expiredLease });
    expect(() => validateHeartbeat(claim, "claim-1")).toThrow(
      /Cannot heartbeat claim 'claim-1': lease expired at/,
    );
  });

  test("error message includes the claim ID", () => {
    try {
      validateHeartbeat(undefined, "my-unique-claim-id");
      throw new Error("Expected to throw");
    } catch (e) {
      expect((e as Error).message).toContain("my-unique-claim-id");
    }
  });

  test("error message for expired lease includes the expiry timestamp", () => {
    const expiredLease = "2020-01-01T00:00:00.000Z";
    const claim = makeClaim({ leaseExpiresAt: expiredLease });
    try {
      validateHeartbeat(claim, "claim-1");
      throw new Error("Expected to throw");
    } catch (e) {
      expect((e as Error).message).toContain(expiredLease);
    }
  });
});

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

describe("validateTransition", () => {
  test("succeeds for active → released", () => {
    const claim = makeClaim();
    expect(() => validateTransition(claim, "claim-1", "released")).not.toThrow();
  });

  test("succeeds for active → completed", () => {
    const claim = makeClaim();
    expect(() => validateTransition(claim, "claim-1", "completed")).not.toThrow();
  });

  test("succeeds for active → expired", () => {
    const claim = makeClaim();
    expect(() => validateTransition(claim, "claim-1", "expired")).not.toThrow();
  });

  test("throws when claim is undefined (not found)", () => {
    expect(() => validateTransition(undefined, "claim-42", "released")).toThrow(
      "Claim 'claim-42' not found",
    );
  });

  test("throws for released → completed", () => {
    const claim = makeClaim({ status: "released" });
    expect(() => validateTransition(claim, "claim-1", "completed")).toThrow(
      "Cannot transition claim 'claim-1' from 'released' to 'completed' (must be active)",
    );
  });

  test("throws for completed → released", () => {
    const claim = makeClaim({ status: "completed" });
    expect(() => validateTransition(claim, "claim-1", "released")).toThrow(
      "Cannot transition claim 'claim-1' from 'completed' to 'released' (must be active)",
    );
  });

  test("throws for expired → active", () => {
    const claim = makeClaim({ status: "expired" });
    expect(() => validateTransition(claim, "claim-1", "active")).toThrow(
      "Cannot transition claim 'claim-1' from 'expired' to 'active' (must be active)",
    );
  });

  test("throws for released → active", () => {
    const claim = makeClaim({ status: "released" });
    expect(() => validateTransition(claim, "claim-1", "active")).toThrow(
      "Cannot transition claim 'claim-1' from 'released' to 'active' (must be active)",
    );
  });

  test("throws for completed → active", () => {
    const claim = makeClaim({ status: "completed" });
    expect(() => validateTransition(claim, "claim-1", "active")).toThrow(
      "Cannot transition claim 'claim-1' from 'completed' to 'active' (must be active)",
    );
  });

  test("throws for expired → released", () => {
    const claim = makeClaim({ status: "expired" });
    expect(() => validateTransition(claim, "claim-1", "released")).toThrow(
      "Cannot transition claim 'claim-1' from 'expired' to 'released' (must be active)",
    );
  });

  test("error message includes both current and target status", () => {
    const claim = makeClaim({ status: "released" });
    try {
      validateTransition(claim, "claim-1", "completed");
      throw new Error("Expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("released");
      expect(msg).toContain("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveClaimOrRenew
// ---------------------------------------------------------------------------

describe("resolveClaimOrRenew", () => {
  test("returns create when no existing claim", () => {
    const result = resolveClaimOrRenew(undefined, "agent-1", "target-1");
    expect(result).toEqual({ action: "create" });
  });

  test("returns renew when same agent holds existing claim", () => {
    const existing = { claimId: "claim-1", agentId: "agent-1" };
    const result = resolveClaimOrRenew(existing, "agent-1", "target-1");
    expect(result).toEqual({ action: "renew", existingClaimId: "claim-1" });
  });

  test("throws ClaimConflictError when different agent holds existing claim", () => {
    const existing = { claimId: "claim-1", agentId: "agent-1" };
    expect(() => resolveClaimOrRenew(existing, "agent-2", "target-1")).toThrow(ClaimConflictError);
  });

  test("ClaimConflictError includes targetRef, heldByAgentId, and heldByClaimId", () => {
    const existing = { claimId: "claim-ABC", agentId: "agent-owner" };
    try {
      resolveClaimOrRenew(existing, "agent-intruder", "target-XYZ");
      throw new Error("Expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaimConflictError);
      const err = e as ClaimConflictError;
      expect(err.targetRef).toBe("target-XYZ");
      expect(err.heldByAgentId).toBe("agent-owner");
      expect(err.heldByClaimId).toBe("claim-ABC");
    }
  });

  test("ClaimConflictError message mentions target and holder", () => {
    const existing = { claimId: "claim-ABC", agentId: "agent-owner" };
    try {
      resolveClaimOrRenew(existing, "agent-intruder", "target-XYZ");
      throw new Error("Expected to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("target-XYZ");
      expect(msg).toContain("agent-owner");
      expect(msg).toContain("claim-ABC");
    }
  });

  test("ClaimConflictError is a GroveError", () => {
    const existing = { claimId: "c-1", agentId: "a-1" };
    try {
      resolveClaimOrRenew(existing, "a-2", "t-1");
      throw new Error("Expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("ClaimConflictError");
    }
  });
});

// ---------------------------------------------------------------------------
// computeLeaseDuration
// ---------------------------------------------------------------------------

describe("computeLeaseDuration", () => {
  test("computes duration from heartbeatAt and leaseExpiresAt", () => {
    const heartbeat = new Date("2025-01-01T00:00:00.000Z");
    const expires = new Date("2025-01-01T00:10:00.000Z"); // 10 minutes later
    const claim = makeClaim({
      heartbeatAt: heartbeat.toISOString(),
      leaseExpiresAt: expires.toISOString(),
    });
    expect(computeLeaseDuration(claim)).toBe(600_000); // 10 minutes in ms
  });

  test("returns default lease duration when computed is zero", () => {
    const ts = new Date("2025-01-01T00:00:00.000Z");
    const claim = makeClaim({
      heartbeatAt: ts.toISOString(),
      leaseExpiresAt: ts.toISOString(), // same timestamp → 0 duration
    });
    expect(computeLeaseDuration(claim)).toBe(DEFAULT_LEASE_DURATION_MS);
  });

  test("returns default lease duration when computed is negative", () => {
    const claim = makeClaim({
      heartbeatAt: new Date("2025-01-01T01:00:00.000Z").toISOString(),
      leaseExpiresAt: new Date("2025-01-01T00:00:00.000Z").toISOString(), // before heartbeat
    });
    expect(computeLeaseDuration(claim)).toBe(DEFAULT_LEASE_DURATION_MS);
  });

  test("returns exact positive duration (not default) for normal claim", () => {
    const claim = makeClaim({
      heartbeatAt: new Date("2025-06-01T12:00:00.000Z").toISOString(),
      leaseExpiresAt: new Date("2025-06-01T12:05:00.000Z").toISOString(),
    });
    const duration = computeLeaseDuration(claim);
    expect(duration).toBe(300_000); // 5 minutes
    expect(duration).toBe(DEFAULT_LEASE_DURATION_MS); // 5 min IS the default
  });

  test("uses heartbeatAt (not createdAt) as anchor", () => {
    // createdAt is 1 hour ago, heartbeatAt is 1 minute ago, lease expires in 4 minutes
    const claim = makeClaim({
      createdAt: new Date("2025-01-01T00:00:00.000Z").toISOString(),
      heartbeatAt: new Date("2025-01-01T00:59:00.000Z").toISOString(),
      leaseExpiresAt: new Date("2025-01-01T01:03:00.000Z").toISOString(),
    });
    // Duration should be 4 minutes (from heartbeatAt), not 63 minutes (from createdAt)
    expect(computeLeaseDuration(claim)).toBe(240_000); // 4 minutes
  });

  test("DEFAULT_LEASE_DURATION_MS is 300000 (5 minutes)", () => {
    expect(DEFAULT_LEASE_DURATION_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all non-active statuses are terminal
// ---------------------------------------------------------------------------

describe("terminal status combinations", () => {
  const terminalStatuses: ClaimStatus[] = ["released", "expired", "completed"];

  for (const status of terminalStatuses) {
    test(`isClaimActiveAndValid returns false for '${status}' even with valid lease`, () => {
      const claim = makeClaim({
        status,
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      expect(isClaimActiveAndValid(claim)).toBe(false);
    });

    test(`validateHeartbeat rejects '${status}' claim`, () => {
      const claim = makeClaim({ status });
      expect(() => validateHeartbeat(claim, "claim-1")).toThrow(/must be active/);
    });

    for (const target of terminalStatuses) {
      test(`validateTransition rejects '${status}' → '${target}'`, () => {
        const claim = makeClaim({ status });
        expect(() => validateTransition(claim, "claim-1", target)).toThrow(/must be active/);
      });
    }
  }
});
