/**
 * Shared protocol-level constants.
 *
 * Single source of truth for default values used across server, gossip,
 * and CLI modules. Avoids DRY violations when the same default appears
 * in multiple modules.
 */

/** CID regex pattern for path/query parameter validation. */
export const CID_REGEX: RegExp = /^blake3:[0-9a-f]{64}$/;

/** Maximum request body size for multipart uploads (50 MB). */
export const MAX_REQUEST_SIZE: number = 50 * 1024 * 1024;

/** Default lease duration in milliseconds (5 minutes). */
export const DEFAULT_LEASE_MS: number = 300_000;

// ---------------------------------------------------------------------------
// Gossip defaults
// ---------------------------------------------------------------------------

/** Default gossip interval in milliseconds (30 seconds). */
export const DEFAULT_GOSSIP_INTERVAL_MS: number = 30_000;

/** Default gossip fan-out: peers contacted per round. */
export const DEFAULT_GOSSIP_FAN_OUT: number = 3;

/** Default jitter factor for gossip interval (±20%). */
export const DEFAULT_GOSSIP_JITTER: number = 0.2;

/** Default maximum partial view size for CYCLON peer sampling. */
export const DEFAULT_PARTIAL_VIEW_SIZE: number = 10;

/** Default shuffle length: entries exchanged per CYCLON shuffle. */
export const DEFAULT_SHUFFLE_LENGTH: number = 5;

/** Default top-K entries per frontier dimension in gossip digest. */
export const DEFAULT_FRONTIER_DIGEST_LIMIT: number = 5;

/** Default suspicion timeout: 3x gossip interval (90 seconds). */
export const DEFAULT_SUSPICION_TIMEOUT_MS: number = 90_000;

/** Default failure timeout: 5x gossip interval (150 seconds). */
export const DEFAULT_FAILURE_TIMEOUT_MS: number = 150_000;

/** Default cached frontier TTL in milliseconds (30 seconds). */
export const DEFAULT_FRONTIER_CACHE_TTL_MS: number = 30_000;

/** Maximum frontier digest entries accepted per gossip message. */
export const MAX_GOSSIP_FRONTIER_ENTRIES: number = 100;

/** Maximum peers offered in a single CYCLON shuffle. */
export const MAX_GOSSIP_OFFERED_PEERS: number = 50;

/** Maximum entries retained in the merged (remote) frontier. */
export const MAX_MERGED_FRONTIER_ENTRIES: number = 500;
