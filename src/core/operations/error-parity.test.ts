/**
 * Error parity tests.
 *
 * Verifies that fromGroveError() maps every GroveError subtype to the
 * correct OperationErrorCode, and that the MCP adapter preserves the
 * error code in the output format.
 */

import { describe, expect, test } from "bun:test";

import {
  ArtifactLimitError,
  ClaimConflictError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  PolicyViolationError,
  RateLimitError,
  RetryExhaustedError,
} from "../errors.js";
import { fromGroveError, OperationErrorCode } from "./result.js";

/** All GroveError subtypes with expected operation error codes. */
const ERROR_MAPPING: ReadonlyArray<{
  name: string;
  error: unknown;
  expectedCode: OperationErrorCode;
}> = [
  {
    name: "ClaimConflictError",
    error: new ClaimConflictError({
      targetRef: "t1",
      heldByAgentId: "a1",
      heldByClaimId: "c1",
    }),
    expectedCode: OperationErrorCode.ClaimConflict,
  },
  {
    name: "ConcurrencyLimitError",
    error: new ConcurrencyLimitError({
      limitType: "global",
      current: 5,
      limit: 3,
    }),
    expectedCode: OperationErrorCode.ConcurrencyLimit,
  },
  {
    name: "RateLimitError",
    error: new RateLimitError({
      limitType: "per_agent",
      current: 100,
      limit: 50,
      windowSeconds: 3600,
      retryAfterMs: 5000,
    }),
    expectedCode: OperationErrorCode.RateLimit,
  },
  {
    name: "ArtifactLimitError (size)",
    error: new ArtifactLimitError({
      limitType: "size",
      current: 1024,
      limit: 512,
    }),
    expectedCode: OperationErrorCode.ArtifactLimit,
  },
  {
    name: "ArtifactLimitError (count)",
    error: new ArtifactLimitError({
      limitType: "count",
      current: 1001,
      limit: 1000,
    }),
    expectedCode: OperationErrorCode.ArtifactLimit,
  },
  {
    name: "RetryExhaustedError",
    error: new RetryExhaustedError({ attempts: 5, maxAttempts: 3 }),
    expectedCode: OperationErrorCode.RetryExhausted,
  },
  {
    name: "LeaseViolationError",
    error: new LeaseViolationError({ requestedSeconds: 3600, maxSeconds: 1800 }),
    expectedCode: OperationErrorCode.LeaseViolation,
  },
  {
    name: "PolicyViolationError",
    error: new PolicyViolationError({
      violationType: "missing_score",
      details: { metric: "val_bpb" },
      message: "Metric 'val_bpb' is required by contract",
    }),
    expectedCode: OperationErrorCode.PolicyViolation,
  },
  {
    name: "Generic GroveError",
    error: new GroveError("generic"),
    expectedCode: OperationErrorCode.ValidationError,
  },
  {
    name: "Generic Error",
    error: new Error("unexpected"),
    expectedCode: OperationErrorCode.InternalError,
  },
  {
    name: "String error",
    error: "raw string",
    expectedCode: OperationErrorCode.InternalError,
  },
];

describe("fromGroveError error parity", () => {
  for (const { name, error, expectedCode } of ERROR_MAPPING) {
    test(`${name} maps to ${expectedCode}`, () => {
      const result = fromGroveError(error);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(expectedCode);
        expect(result.error.message).toBeTruthy();
      }
    });
  }
});

describe("MCP adapter error format parity", () => {
  // Import the MCP adapter to verify it preserves the error code format
  test("error format includes [CODE] prefix", async () => {
    // Dynamic import to avoid circular deps
    const { toMcpResult } = await import("../../mcp/operation-adapter.js");

    for (const { error, expectedCode } of ERROR_MAPPING) {
      const opResult = fromGroveError(error);
      const mcpResult = toMcpResult(opResult);

      expect(mcpResult.isError).toBe(true);
      const text = mcpResult.content[0];
      expect(text).toBeDefined();
      if (text && "text" in text) {
        expect(text.text).toContain(`[${expectedCode}]`);
      }
    }
  });
});

describe("error codes are exhaustive", () => {
  test("all OperationErrorCode values are defined", () => {
    const codes = Object.values(OperationErrorCode);
    expect(codes).toContain("CLAIM_CONFLICT");
    expect(codes).toContain("CONCURRENCY_LIMIT");
    expect(codes).toContain("RATE_LIMIT");
    expect(codes).toContain("ARTIFACT_LIMIT");
    expect(codes).toContain("RETRY_EXHAUSTED");
    expect(codes).toContain("LEASE_VIOLATION");
    expect(codes).toContain("NOT_FOUND");
    expect(codes).toContain("STATE_CONFLICT");
    expect(codes).toContain("POLICY_VIOLATION");
    expect(codes).toContain("VALIDATION_ERROR");
    expect(codes).toContain("INTERNAL_ERROR");
    expect(codes.length).toBe(11);
  });

  test("OperationErrorCode matches MCP McpErrorCode", async () => {
    const { McpErrorCode } = await import("../../mcp/error-handler.js");
    const opCodes = Object.values(OperationErrorCode).sort();
    const mcpCodes = Object.values(McpErrorCode).sort();
    expect(opCodes).toEqual(mcpCodes);
  });
});
