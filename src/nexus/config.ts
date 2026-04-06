/**
 * Configuration types for the Nexus adapter.
 */

import type { NexusClient } from "./client.js";

/** Configuration for Nexus-backed Grove adapters. */
export interface NexusConfig {
  /** The Nexus client implementation to use. */
  readonly client: NexusClient;

  /** Zone identifier for multi-tenant scoping. All keys are prefixed with this. */
  readonly zoneId: string;

  /** Session ID for per-session contribution isolation. When set, contributions
   *  are stored under /zones/{zoneId}/sessions/{sessionId}/ instead of the zone root.
   *  This prevents N+1 VFS reads from scanning all historical contributions. */
  readonly sessionId?: string | undefined;

  /** Maximum concurrent requests to Nexus. Defaults to 20. */
  readonly maxConcurrency?: number | undefined;

  /**
   * Byte threshold for exists-before-put optimization on CAS puts.
   * Blobs larger than this check `exists()` before uploading.
   * Defaults to 65536 (64 KB).
   */
  readonly existsThresholdBytes?: number | undefined;

  /** Maximum entries in the LRU cache for immutable data. Defaults to 1000. */
  readonly cacheMaxEntries?: number | undefined;

  /** Maximum retry attempts for transient errors. Defaults to 3. */
  readonly retryMaxAttempts?: number | undefined;

  /** Base delay in milliseconds for exponential backoff. Defaults to 100. */
  readonly retryBaseDelayMs?: number | undefined;

  /** Maximum delay in milliseconds for exponential backoff. Defaults to 5000. */
  readonly retryMaxDelayMs?: number | undefined;
}

/** Resolved configuration with defaults applied. */
export interface ResolvedNexusConfig {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly sessionId: string | undefined;
  readonly maxConcurrency: number;
  readonly existsThresholdBytes: number;
  readonly cacheMaxEntries: number;
  readonly retryMaxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
}

/** Apply defaults to a NexusConfig. */
export function resolveConfig(config: NexusConfig): ResolvedNexusConfig {
  return {
    client: config.client,
    zoneId: config.zoneId,
    sessionId: config.sessionId,
    maxConcurrency: config.maxConcurrency ?? 20,
    existsThresholdBytes: config.existsThresholdBytes ?? 65_536,
    cacheMaxEntries: config.cacheMaxEntries ?? 1_000,
    retryMaxAttempts: config.retryMaxAttempts ?? 3,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 100,
    retryMaxDelayMs: config.retryMaxDelayMs ?? 5_000,
  };
}
