/**
 * Shared constants for server validation.
 */

/** CID regex pattern for path/query parameter validation. */
export const CID_REGEX: RegExp = /^blake3:[0-9a-f]{64}$/;

/** Maximum request body size for multipart uploads (50 MB). */
export const MAX_REQUEST_SIZE: number = 50 * 1024 * 1024;

/** Default lease duration in milliseconds (5 minutes). */
export const DEFAULT_LEASE_MS: number = 300_000;
