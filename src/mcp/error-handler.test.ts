import { describe, expect, test } from "bun:test";

import {
  ArtifactLimitError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  RateLimitError,
  RetryExhaustedError,
} from "../core/errors.js";
import { handleToolError, McpErrorCode, notFoundError, validationError } from "./error-handler.js";

describe("handleToolError", () => {
  test("maps ConcurrencyLimitError", () => {
    const error = new ConcurrencyLimitError({
      limitType: "per_agent",
      current: 3,
      limit: 3,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.ConcurrencyLimit);
    expect(text).toContain("per_agent");
    expect(text).toContain("3");
  });

  test("maps RateLimitError with retry hint", () => {
    const error = new RateLimitError({
      limitType: "per_agent",
      current: 10,
      limit: 5,
      windowSeconds: 60,
      retryAfterMs: 30_000,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.RateLimit);
    expect(text).toContain("Retry after 30s");
  });

  test("maps ArtifactLimitError (size)", () => {
    const error = new ArtifactLimitError({
      limitType: "size",
      current: 2_000_000,
      limit: 1_000_000,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.ArtifactLimit);
    expect(text).toContain("bytes");
  });

  test("maps ArtifactLimitError (count)", () => {
    const error = new ArtifactLimitError({
      limitType: "count",
      current: 20,
      limit: 10,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("artifacts");
  });

  test("maps RetryExhaustedError", () => {
    const error = new RetryExhaustedError({
      attempts: 5,
      maxAttempts: 3,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.RetryExhausted);
    expect(text).toContain("5");
    expect(text).toContain("3");
  });

  test("maps LeaseViolationError", () => {
    const error = new LeaseViolationError({
      requestedSeconds: 7200,
      maxSeconds: 3600,
    });
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.LeaseViolation);
    expect(text).toContain("7200");
    expect(text).toContain("3600");
  });

  test("maps generic GroveError as VALIDATION_ERROR", () => {
    const error = new GroveError("Something went wrong");
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.ValidationError);
    expect(text).toContain("Something went wrong");
  });

  test("maps generic Error as INTERNAL_ERROR", () => {
    const error = new Error("Unexpected failure");
    const result = handleToolError(error);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.InternalError);
    expect(text).toContain("Unexpected failure");
  });

  test("maps non-Error thrown value", () => {
    const result = handleToolError("raw string error");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.InternalError);
    expect(text).toContain("raw string error");
  });
});

describe("notFoundError", () => {
  test("returns structured not-found result", () => {
    const result = notFoundError("Contribution", "blake3:abc123");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.NotFound);
    expect(text).toContain("Contribution");
    expect(text).toContain("blake3:abc123");
  });
});

describe("validationError", () => {
  test("returns structured validation error result", () => {
    const result = validationError("Missing required field: summary");
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(McpErrorCode.ValidationError);
    expect(text).toContain("Missing required field: summary");
  });
});
