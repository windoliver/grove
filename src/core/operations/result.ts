/**
 * Shared operation result model.
 *
 * All operations return OperationResult<T> instead of throwing.
 * Surfaces (CLI, MCP, HTTP) map OperationError codes to their
 * transport-specific error format.
 */

import {
  ArtifactLimitError,
  ClaimConflictError,
  ConcurrencyLimitError,
  GroveError,
  LeaseViolationError,
  NotFoundError,
  RateLimitError,
  RetryExhaustedError,
  StateConflictError,
} from "../errors.js";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Error codes shared across all surfaces. */
export const OperationErrorCode = {
  ClaimConflict: "CLAIM_CONFLICT",
  ConcurrencyLimit: "CONCURRENCY_LIMIT",
  RateLimit: "RATE_LIMIT",
  ArtifactLimit: "ARTIFACT_LIMIT",
  RetryExhausted: "RETRY_EXHAUSTED",
  LeaseViolation: "LEASE_VIOLATION",
  NotFound: "NOT_FOUND",
  StateConflict: "STATE_CONFLICT",
  ValidationError: "VALIDATION_ERROR",
  InternalError: "INTERNAL_ERROR",
} as const;

export type OperationErrorCode = (typeof OperationErrorCode)[keyof typeof OperationErrorCode];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Structured error from an operation. */
export interface OperationError {
  readonly code: OperationErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

/** Successful operation result. */
export interface OperationOk<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed operation result. */
export interface OperationErr {
  readonly ok: false;
  readonly error: OperationError;
}

/** Discriminated union: every operation returns one of these. */
export type OperationResult<T> = OperationOk<T> | OperationErr;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Create a successful result. */
export function ok<T>(value: T): OperationOk<T> {
  return { ok: true, value };
}

/** Create a failed result. */
export function err(error: OperationError): OperationErr {
  return { ok: false, error };
}

/** Create a not-found error result. */
export function notFound(entity: string, id: string): OperationErr {
  return err({
    code: OperationErrorCode.NotFound,
    message: `${entity} not found: ${id}`,
  });
}

/** Create a validation error result. */
export function validationErr(message: string): OperationErr {
  return err({
    code: OperationErrorCode.ValidationError,
    message,
  });
}

// ---------------------------------------------------------------------------
// GroveError mapping
// ---------------------------------------------------------------------------

/** Map a GroveError (or any error) to an OperationErr. */
export function fromGroveError(error: unknown): OperationErr {
  if (error instanceof ClaimConflictError) {
    return err({
      code: OperationErrorCode.ClaimConflict,
      message: `Target '${error.targetRef}' already claimed by agent '${error.heldByAgentId}' (claim '${error.heldByClaimId}')`,
      details: {
        targetRef: error.targetRef,
        heldByAgentId: error.heldByAgentId,
        heldByClaimId: error.heldByClaimId,
      },
    });
  }

  if (error instanceof ConcurrencyLimitError) {
    return err({
      code: OperationErrorCode.ConcurrencyLimit,
      message: `${error.limitType} concurrency limit: ${error.current} active, limit is ${error.limit}`,
      details: {
        limitType: error.limitType,
        current: error.current,
        limit: error.limit,
      },
    });
  }

  if (error instanceof RateLimitError) {
    return err({
      code: OperationErrorCode.RateLimit,
      message: `${error.limitType} rate limit: ${error.current} in last ${error.windowSeconds}s, limit is ${error.limit}`,
      details: {
        limitType: error.limitType,
        current: error.current,
        limit: error.limit,
        windowSeconds: error.windowSeconds,
        retryAfterMs: error.retryAfterMs,
      },
    });
  }

  if (error instanceof ArtifactLimitError) {
    const unit = error.limitType === "size" ? "bytes" : "artifacts";
    return err({
      code: OperationErrorCode.ArtifactLimit,
      message: `Artifact ${error.limitType} limit: ${error.current} ${unit}, limit is ${error.limit}`,
      details: {
        limitType: error.limitType,
        current: error.current,
        limit: error.limit,
      },
    });
  }

  if (error instanceof RetryExhaustedError) {
    return err({
      code: OperationErrorCode.RetryExhausted,
      message: `Retry exhausted: ${error.attempts} attempts, max is ${error.maxAttempts}`,
      details: {
        attempts: error.attempts,
        maxAttempts: error.maxAttempts,
      },
    });
  }

  if (error instanceof LeaseViolationError) {
    return err({
      code: OperationErrorCode.LeaseViolation,
      message: `Lease violation: requested ${error.requestedSeconds}s exceeds max ${error.maxSeconds}s`,
      details: {
        requestedSeconds: error.requestedSeconds,
        maxSeconds: error.maxSeconds,
      },
    });
  }

  if (error instanceof NotFoundError) {
    return err({
      code: OperationErrorCode.NotFound,
      message: error.message,
      details: { resource: error.resource, identifier: error.identifier },
    });
  }

  if (error instanceof StateConflictError) {
    return err({
      code: OperationErrorCode.StateConflict,
      message: error.message,
      details: { resource: error.resource, reason: error.reason },
    });
  }

  if (error instanceof GroveError) {
    return err({
      code: OperationErrorCode.ValidationError,
      message: error.message,
    });
  }

  if (error instanceof Error) {
    return err({
      code: OperationErrorCode.InternalError,
      message: error.message,
    });
  }

  return err({
    code: OperationErrorCode.InternalError,
    message: String(error),
  });
}
