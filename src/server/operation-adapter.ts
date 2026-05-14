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
 *
 * The `onEntityWrite` hook is wired here to forward Entity-write events
 * (#287/#292) into the WatchHub on `deps.watchHub`. The per-request
 * `namespace` field is NOT set here — route handlers must inject it from
 * the auth context (`c.get("namespace")`) before invoking an operation,
 * since the watch protocol scopes events per-namespace.
 */
export function toOperationDeps(deps: ServerDeps): OperationDeps {
  return {
    contributionStore: deps.contributionStore,
    claimStore: deps.claimStore,
    ...(deps.timelineStore !== undefined ? { timelineStore: deps.timelineStore } : {}),
    cas: deps.cas,
    frontier: deps.frontier,
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
    ...(deps.bountyStore !== undefined ? { bountyStore: deps.bountyStore } : {}),
    ...(deps.creditsService !== undefined ? { creditsService: deps.creditsService } : {}),
    ...(deps.frontierRewardService !== undefined
      ? { frontierRewardService: deps.frontierRewardService }
      : {}),
    ...(deps.contract !== undefined ? { contract: deps.contract } : {}),
    ...(deps.idempotencyStore !== undefined ? { idempotencyStore: deps.idempotencyStore } : {}),
    onEntityWrite: (event) => {
      deps.watchHub.recordWrite(event);
      // Cross-process dedupe (#292): record this write so the matching
      // `entity.changed` envelope (published by the Nexus store at write
      // time) is suppressed when it lands on the subscriber. Without
      // this, the same write would record twice — once via the in-process
      // fast path, once via the bus — and the WatchHub RV would advance
      // by 2 instead of 1 per logical write.
      deps.watchSubscriber?.markSeen({
        kind: event.kind,
        entityId: event.entity.id,
        generation: event.entity.metadata.generation,
      });
    },
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
