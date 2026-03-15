/**
 * Centralized error handler middleware.
 *
 * Maps grove-core's typed error hierarchy to HTTP status codes.
 * Route handlers throw freely; this middleware catches and formats.
 */

import type { Context } from "hono";
import { ZodError } from "zod";
import { GroveError, RateLimitError } from "../../core/errors.js";

// NotFoundError and StateConflictError are resolved via ERROR_MAP by name.

interface ErrorMapping {
  readonly status: number;
  readonly code: string;
}

const ERROR_MAP = new Map<string, ErrorMapping>([
  ["ClaimConflictError", { status: 409, code: "CLAIM_CONFLICT" }],
  ["ConcurrencyLimitError", { status: 409, code: "CONCURRENCY_LIMIT" }],
  ["RateLimitError", { status: 429, code: "RATE_LIMIT" }],
  ["LeaseViolationError", { status: 422, code: "LEASE_VIOLATION" }],
  ["ArtifactLimitError", { status: 422, code: "ARTIFACT_LIMIT" }],
  ["RetryExhaustedError", { status: 503, code: "RETRY_EXHAUSTED" }],
  ["PeerUnreachableError", { status: 502, code: "PEER_UNREACHABLE" }],
  ["GossipTimeoutError", { status: 504, code: "GOSSIP_TIMEOUT" }],
  ["NotFoundError", { status: 404, code: "NOT_FOUND" }],
  ["StateConflictError", { status: 409, code: "STATE_CONFLICT" }],
]);

/** Format error response body. */
function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/**
 * Hono onError handler. Attach via `app.onError(handleError)`.
 *
 * Returns JSON error responses with appropriate HTTP status codes.
 */
export function handleError(err: Error, c: Context): Response {
  // Zod validation errors → 400
  if (err instanceof ZodError) {
    const messages = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return c.json(errorBody("VALIDATION_ERROR", messages.join("; ")), 400);
  }

  // Grove typed errors → mapped status code
  if (err instanceof GroveError) {
    const mapping = ERROR_MAP.get(err.name);
    if (mapping) {
      const response = c.json(errorBody(mapping.code, err.message), mapping.status as 400);

      // Add Retry-After header for rate limit errors
      if (err instanceof RateLimitError) {
        response.headers.set("Retry-After", String(Math.ceil(err.retryAfterMs / 1000)));
      }

      return response;
    }

    // Unknown GroveError subclass → 500
    return c.json(errorBody("GROVE_ERROR", err.message), 500);
  }

  // Fallback: 500 Internal Server Error (no stack trace in response)
  return c.json(errorBody("INTERNAL_ERROR", "Internal server error"), 500);
}
