/**
 * Tests for the shared operation result model.
 */

import { describe, expect, test } from "bun:test";

import {
  ArtifactLimitError,
  ClaimConflictError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  RateLimitError,
  RetryExhaustedError,
} from "../errors.js";
import { err, fromGroveError, notFound, OperationErrorCode, ok, validationErr } from "./result.js";

describe("ok()", () => {
  test("wraps value with ok: true", () => {
    const result = ok({ cid: "test-cid" });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ cid: "test-cid" });
  });

  test("works with primitive values", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });
});

describe("err()", () => {
  test("wraps error with ok: false", () => {
    const result = err({
      code: OperationErrorCode.NotFound,
      message: "not found",
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toBe("not found");
  });
});

describe("notFound()", () => {
  test("creates NOT_FOUND error", () => {
    const result = notFound("Contribution", "blake3:abc");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toBe("Contribution not found: blake3:abc");
  });
});

describe("validationErr()", () => {
  test("creates VALIDATION_ERROR", () => {
    const result = validationErr("invalid input");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toBe("invalid input");
  });
});

describe("fromGroveError()", () => {
  test("maps ClaimConflictError", () => {
    const error = new ClaimConflictError({
      targetRef: "target-1",
      heldByAgentId: "agent-2",
      heldByClaimId: "claim-2",
    });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CLAIM_CONFLICT");
    expect(result.error.details).toEqual({
      targetRef: "target-1",
      heldByAgentId: "agent-2",
      heldByClaimId: "claim-2",
    });
  });

  test("maps ConcurrencyLimitError", () => {
    const error = new ConcurrencyLimitError({
      limitType: "global",
      current: 5,
      limit: 3,
    });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CONCURRENCY_LIMIT");
    expect(result.error.details).toEqual({ limitType: "global", current: 5, limit: 3 });
  });

  test("maps RateLimitError", () => {
    const error = new RateLimitError({
      limitType: "per_agent",
      current: 100,
      limit: 50,
      windowSeconds: 3600,
      retryAfterMs: 5000,
    });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("RATE_LIMIT");
    expect(result.error.details?.retryAfterMs).toBe(5000);
  });

  test("maps ArtifactLimitError", () => {
    const error = new ArtifactLimitError({
      limitType: "size",
      current: 1024,
      limit: 512,
    });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("ARTIFACT_LIMIT");
    expect(result.error.message).toContain("bytes");
  });

  test("maps ArtifactLimitError (count)", () => {
    const error = new ArtifactLimitError({
      limitType: "count",
      current: 1001,
      limit: 1000,
    });
    const result = fromGroveError(error);
    expect(result.error.message).toContain("artifacts");
  });

  test("maps RetryExhaustedError", () => {
    const error = new RetryExhaustedError({ attempts: 5, maxAttempts: 3 });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("RETRY_EXHAUSTED");
  });

  test("maps LeaseViolationError", () => {
    const error = new LeaseViolationError({ requestedSeconds: 3600, maxSeconds: 1800 });
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("LEASE_VIOLATION");
  });

  test("maps generic GroveError to VALIDATION_ERROR", () => {
    const error = new GroveError("something went wrong");
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toBe("something went wrong");
  });

  test("maps generic Error to INTERNAL_ERROR", () => {
    const error = new Error("unexpected");
    const result = fromGroveError(error);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).toBe("unexpected");
  });

  test("maps non-Error to INTERNAL_ERROR with string message", () => {
    const result = fromGroveError("raw string error");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).toBe("raw string error");
  });
});
