/**
 * Nexus-specific error classes and error mapping.
 *
 * Maps Nexus/network errors and JSON-RPC error codes into the Grove
 * error hierarchy so callers handle the same error types regardless of backend.
 */

import { GroveError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// JSON-RPC error codes from nexi-lab/nexus
// ---------------------------------------------------------------------------

export const NEXUS_ERROR_CODES = {
  FILE_NOT_FOUND: -32000,
  FILE_EXISTS: -32001,
  INVALID_PATH: -32002,
  ACCESS_DENIED: -32003,
  PERMISSION_ERROR: -32004,
  VALIDATION_ERROR: -32005,
  CONFLICT: -32006,
  INTERNAL_ERROR: -32603,
} as const;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when the Nexus backend is unreachable. */
export class NexusConnectionError extends GroveError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NexusConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when a Nexus operation times out. */
export class NexusTimeoutError extends GroveError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NexusTimeoutError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when Nexus rejects the request due to authentication/authorization. */
export class NexusAuthError extends GroveError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NexusAuthError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when a file is not found. */
export class NexusNotFoundError extends GroveError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NexusNotFoundError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when a write conflicts (ETag mismatch or file-already-exists). */
export class NexusConflictError extends GroveError {
  readonly expectedEtag?: string | undefined;
  readonly actualEtag?: string | undefined;

  constructor(opts: {
    message: string;
    expectedEtag?: string;
    actualEtag?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "NexusConflictError";
    this.expectedEtag = opts.expectedEtag;
    this.actualEtag = opts.actualEtag;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * @deprecated Use NexusConflictError instead.
 * Kept for backward compatibility — will be removed in next major version.
 */
export const NexusRevisionConflictError: typeof NexusConflictError = NexusConflictError;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify whether an error is retryable (transient) or not.
 *
 * Retryable: connection errors, timeouts, server errors (5xx)
 * Non-retryable: auth errors, not-found, conflicts, validation
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NexusConnectionError) return true;
  if (error instanceof NexusTimeoutError) return true;
  if (error instanceof NexusAuthError) return false;
  if (error instanceof NexusNotFoundError) return false;
  if (error instanceof NexusConflictError) return false;

  // Generic Error — check message for known transient patterns
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("econnrefused") || msg.includes("econnreset")) return true;
    if (msg.includes("timeout")) return true;
    if (msg.includes("503") || msg.includes("429")) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Parsed JSON-RPC error body. */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Map a JSON-RPC error code to the appropriate Nexus error type.
 */
export function mapJsonRpcError(rpcError: JsonRpcError): GroveError {
  switch (rpcError.code) {
    case NEXUS_ERROR_CODES.FILE_NOT_FOUND:
      return new NexusNotFoundError(rpcError.message);
    case NEXUS_ERROR_CODES.CONFLICT:
    case NEXUS_ERROR_CODES.FILE_EXISTS:
      return new NexusConflictError({ message: rpcError.message });
    case NEXUS_ERROR_CODES.ACCESS_DENIED:
    case NEXUS_ERROR_CODES.PERMISSION_ERROR:
      return new NexusAuthError(rpcError.message);
    case NEXUS_ERROR_CODES.VALIDATION_ERROR:
    case NEXUS_ERROR_CODES.INVALID_PATH:
      return new GroveError(rpcError.message);
    default:
      return new NexusConnectionError(`JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
  }
}

/**
 * Map a raw error into the appropriate Grove/Nexus error type.
 * Wraps the original error as `.cause` for debugging.
 */
export function mapNexusError(error: unknown, context: string): GroveError {
  if (error instanceof GroveError) return error;

  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("ENETUNREACH")) {
    return new NexusConnectionError(`Nexus connection failed during ${context}: ${msg}`, error);
  }
  if (msg.toLowerCase().includes("timeout") || msg.includes("ETIMEDOUT")) {
    return new NexusTimeoutError(`Nexus timeout during ${context}: ${msg}`, error);
  }
  if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("unauthorized")) {
    return new NexusAuthError(`Nexus auth failed during ${context}: ${msg}`, error);
  }

  return new NexusConnectionError(`Nexus error during ${context}: ${msg}`, error);
}
