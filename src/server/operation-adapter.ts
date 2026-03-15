/**
 * Adapter utilities for bridging HTTP routes to the shared operations layer.
 *
 * toOperationDeps — Convert ServerDeps to OperationDeps
 * toHttpStatus    — Map OperationErrorCode to HTTP status code
 * toHttpResult    — Convert OperationResult to HTTP response payload + status
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OperationDeps } from "../core/operations/deps.js";
import type { OperationErrorCode, OperationResult } from "../core/operations/result.js";
import type { ServerDeps } from "./deps.js";

/**
 * Convert ServerDeps to OperationDeps.
 *
 * ServerDeps is a structural subset of OperationDeps — this function
 * selects the fields that operations require, dropping transport-specific
 * dependencies (gossip, topology).
 */
export function toOperationDeps(deps: ServerDeps): OperationDeps {
  return {
    contributionStore: deps.contributionStore,
    claimStore: deps.claimStore,
    cas: deps.cas,
    frontier: deps.frontier,
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
  };
}

/** Map an OperationErrorCode to an HTTP status code. */
export function toHttpStatus(code: OperationErrorCode): ContentfulStatusCode {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 400;
    case "CLAIM_CONFLICT":
    case "STATE_CONFLICT":
      return 409;
    case "CONCURRENCY_LIMIT":
      return 429;
    case "RATE_LIMIT":
      return 429;
    case "ARTIFACT_LIMIT":
      return 413;
    case "LEASE_VIOLATION":
      return 400;
    case "RETRY_EXHAUSTED":
      return 503;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 500;
  }
}

/** HTTP response payload and status. */
export interface HttpResult<T> {
  readonly data: T | { readonly error: { readonly code: string; readonly message: string } };
  readonly status: ContentfulStatusCode;
}

/**
 * Convert an OperationResult to an HTTP JSON response payload and status code.
 *
 * On success: returns { data: value, status: 200 } (or custom status).
 * On error: returns { data: { error: { code, message } }, status: mappedHttpCode }.
 */
export function toHttpResult<T>(
  result: OperationResult<T>,
  successStatus?: ContentfulStatusCode,
): HttpResult<T> {
  if (result.ok) {
    return { data: result.value, status: successStatus ?? 200 };
  }
  return {
    data: { error: { code: result.error.code, message: result.error.message } },
    status: toHttpStatus(result.error.code),
  };
}
