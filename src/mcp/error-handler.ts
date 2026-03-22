/**
 * Centralized error handler for MCP tool results.
 *
 * Maps GroveError subtypes to structured MCP error responses that give
 * agents actionable information (error codes, retry hints, limits).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ArtifactLimitError,
  ClaimConflictError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  NotFoundError,
  PolicyViolationError,
  RateLimitError,
  RetryExhaustedError,
  StateConflictError,
} from "../core/errors.js";

/** Error codes returned to MCP clients for programmatic handling. */
export const McpErrorCode = {
  ClaimConflict: "CLAIM_CONFLICT",
  ConcurrencyLimit: "CONCURRENCY_LIMIT",
  RateLimit: "RATE_LIMIT",
  ArtifactLimit: "ARTIFACT_LIMIT",
  RetryExhausted: "RETRY_EXHAUSTED",
  LeaseViolation: "LEASE_VIOLATION",
  NotFound: "NOT_FOUND",
  StateConflict: "STATE_CONFLICT",
  PolicyViolation: "POLICY_VIOLATION",
  ValidationError: "VALIDATION_ERROR",
  InternalError: "INTERNAL_ERROR",
} as const;

/**
 * Convert an error into a structured MCP tool error result.
 *
 * Returns a CallToolResult with `isError: true` and a text content block
 * containing a machine-parseable error code and human-readable message.
 */
export function handleToolError(error: unknown): CallToolResult {
  if (error instanceof ClaimConflictError) {
    return toolError(
      McpErrorCode.ClaimConflict,
      `Target '${error.targetRef}' already claimed by agent '${error.heldByAgentId}' (claim '${error.heldByClaimId}'). Pick a different target.`,
    );
  }

  if (error instanceof ConcurrencyLimitError) {
    return toolError(
      McpErrorCode.ConcurrencyLimit,
      `${error.limitType} concurrency limit: ${error.current} active, limit is ${error.limit}`,
    );
  }

  if (error instanceof RateLimitError) {
    return toolError(
      McpErrorCode.RateLimit,
      `${error.limitType} rate limit: ${error.current} in last ${error.windowSeconds}s, limit is ${error.limit}. Retry after ${Math.ceil(error.retryAfterMs / 1000)}s.`,
    );
  }

  if (error instanceof ArtifactLimitError) {
    const unit = error.limitType === "size" ? "bytes" : "artifacts";
    return toolError(
      McpErrorCode.ArtifactLimit,
      `Artifact ${error.limitType} limit: ${error.current} ${unit}, limit is ${error.limit}`,
    );
  }

  if (error instanceof RetryExhaustedError) {
    return toolError(
      McpErrorCode.RetryExhausted,
      `Retry exhausted: ${error.attempts} attempts, max is ${error.maxAttempts}`,
    );
  }

  if (error instanceof LeaseViolationError) {
    return toolError(
      McpErrorCode.LeaseViolation,
      `Lease violation: requested ${error.requestedSeconds}s exceeds max ${error.maxSeconds}s`,
    );
  }

  if (error instanceof PolicyViolationError) {
    return toolError(
      McpErrorCode.PolicyViolation,
      `Policy violation (${error.violationType}): ${error.message}`,
    );
  }

  if (error instanceof NotFoundError) {
    return toolError(McpErrorCode.NotFound, error.message);
  }

  if (error instanceof StateConflictError) {
    return toolError(McpErrorCode.StateConflict, error.message);
  }

  if (error instanceof GroveError) {
    return toolError(McpErrorCode.ValidationError, error.message);
  }

  if (error instanceof Error) {
    return toolError(McpErrorCode.InternalError, error.message);
  }

  return toolError(McpErrorCode.InternalError, String(error));
}

/** Create a not-found error result. */
export function notFoundError(entity: string, id: string): CallToolResult {
  return toolError(McpErrorCode.NotFound, `${entity} not found: ${id}`);
}

/** Create a validation error result. */
export function validationError(message: string): CallToolResult {
  return toolError(McpErrorCode.ValidationError, message);
}

/** Build a CallToolResult with isError: true. */
function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
  };
}
