/**
 * Typed error hierarchy for Grove enforcement violations.
 *
 * Each error class carries specific context so callers (CLI, server, MCP)
 * can provide appropriate responses (e.g., HTTP 429 for rate limits,
 * 409 for concurrency conflicts).
 */

/** Base class for all Grove-specific errors. */
export class GroveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroveError";
  }
}

/** Thrown when a concurrency limit is exceeded (global, per-agent, or per-target). */
export class ConcurrencyLimitError extends GroveError {
  readonly limitType: "global" | "per_agent" | "per_target";
  readonly current: number;
  readonly limit: number;

  constructor(opts: {
    limitType: "global" | "per_agent" | "per_target";
    current: number;
    limit: number;
    message?: string;
  }) {
    const msg =
      opts.message ??
      `Concurrency limit exceeded (${opts.limitType}): ${opts.current} active, limit is ${opts.limit}`;
    super(msg);
    this.name = "ConcurrencyLimitError";
    this.limitType = opts.limitType;
    this.current = opts.current;
    this.limit = opts.limit;
  }
}

/** Thrown when a rate limit is exceeded (per-agent or per-grove). */
export class RateLimitError extends GroveError {
  readonly limitType: "per_agent" | "per_grove";
  readonly current: number;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly retryAfterMs: number;

  constructor(opts: {
    limitType: "per_agent" | "per_grove";
    current: number;
    limit: number;
    windowSeconds: number;
    retryAfterMs: number;
    message?: string;
  }) {
    const msg =
      opts.message ??
      `Rate limit exceeded (${opts.limitType}): ${opts.current} contributions in last ${opts.windowSeconds}s, limit is ${opts.limit}`;
    super(msg);
    this.name = "RateLimitError";
    this.limitType = opts.limitType;
    this.current = opts.current;
    this.limit = opts.limit;
    this.windowSeconds = opts.windowSeconds;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Thrown when artifact constraints are violated (size or count). */
export class ArtifactLimitError extends GroveError {
  readonly limitType: "size" | "count";
  readonly current: number;
  readonly limit: number;

  constructor(opts: {
    limitType: "size" | "count";
    current: number;
    limit: number;
    message?: string;
  }) {
    const unit = opts.limitType === "size" ? "bytes" : "artifacts";
    const msg =
      opts.message ??
      `Artifact limit exceeded (${opts.limitType}): ${opts.current} ${unit}, limit is ${opts.limit}`;
    super(msg);
    this.name = "ArtifactLimitError";
    this.limitType = opts.limitType;
    this.current = opts.current;
    this.limit = opts.limit;
  }
}

/** Thrown when max retry attempts are exhausted. */
export class RetryExhaustedError extends GroveError {
  readonly attempts: number;
  readonly maxAttempts: number;

  constructor(opts: { attempts: number; maxAttempts: number; message?: string }) {
    const msg =
      opts.message ?? `Retry exhausted: ${opts.attempts} attempts made, max is ${opts.maxAttempts}`;
    super(msg);
    this.name = "RetryExhaustedError";
    this.attempts = opts.attempts;
    this.maxAttempts = opts.maxAttempts;
  }
}

/** Thrown when a different agent already holds an active claim on the target. */
export class ClaimConflictError extends GroveError {
  readonly targetRef: string;
  readonly heldByAgentId: string;
  readonly heldByClaimId: string;

  constructor(opts: {
    targetRef: string;
    heldByAgentId: string;
    heldByClaimId: string;
    message?: string;
  }) {
    const msg =
      opts.message ??
      `Target '${opts.targetRef}' already has an active claim '${opts.heldByClaimId}' by agent '${opts.heldByAgentId}'`;
    super(msg);
    this.name = "ClaimConflictError";
    this.targetRef = opts.targetRef;
    this.heldByAgentId = opts.heldByAgentId;
    this.heldByClaimId = opts.heldByClaimId;
  }
}

/** Thrown when a requested resource cannot be found. */
export class NotFoundError extends GroveError {
  readonly resource: string;
  readonly identifier: string;

  constructor(opts: { resource: string; identifier: string; message?: string }) {
    const msg = opts.message ?? `${opts.resource} '${opts.identifier}' not found`;
    super(msg);
    this.name = "NotFoundError";
    this.resource = opts.resource;
    this.identifier = opts.identifier;
  }
}

/** Thrown when an operation conflicts with the current resource state. */
export class StateConflictError extends GroveError {
  readonly resource: string;
  readonly reason: string;

  constructor(opts: { resource: string; reason: string; message?: string }) {
    const msg = opts.message ?? `${opts.resource} conflict: ${opts.reason}`;
    super(msg);
    this.name = "StateConflictError";
    this.resource = opts.resource;
    this.reason = opts.reason;
  }
}

/** Thrown when a contribution violates contract policy (semantic enforcement). */
export class PolicyViolationError extends GroveError {
  readonly violationType:
    | "missing_score"
    | "gate_failed"
    | "role_kind"
    | "missing_relation"
    | "missing_artifact"
    | "missing_context";
  readonly details: Record<string, unknown>;

  constructor(opts: {
    violationType:
      | "missing_score"
      | "gate_failed"
      | "role_kind"
      | "missing_relation"
      | "missing_artifact"
      | "missing_context";
    details: Record<string, unknown>;
    message: string;
  }) {
    super(opts.message);
    this.name = "PolicyViolationError";
    this.violationType = opts.violationType;
    this.details = opts.details;
  }
}

/** Thrown when a lease duration violates policy (exceeds max). */
export class LeaseViolationError extends GroveError {
  readonly requestedSeconds: number;
  readonly maxSeconds: number;

  constructor(opts: { requestedSeconds: number; maxSeconds: number; message?: string }) {
    const msg =
      opts.message ??
      `Lease violation: requested ${opts.requestedSeconds}s exceeds max ${opts.maxSeconds}s`;
    super(msg);
    this.name = "LeaseViolationError";
    this.requestedSeconds = opts.requestedSeconds;
    this.maxSeconds = opts.maxSeconds;
  }
}
