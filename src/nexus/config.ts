/**
 * Configuration types for the Nexus adapter.
 */

import type { NexusClient } from "./client.js";
import type { NexusWatchPublisher } from "./nexus-watch-publisher.js";

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

  /**
   * Optional publisher for cross-process watch fan-out (#292).
   *
   * When set, store mutations also publish lightweight `entity.changed`
   * envelopes onto the in-process event-bus so that NexusWatchSubscriber
   * (running in the grove-server) can hydrate the WatchHub for any process
   * that wrote through Nexus, regardless of which process holds the watcher.
   *
   * Optional so existing test code (and pure-local mode) can omit it.
   */
  readonly watchPublisher?: NexusWatchPublisher | undefined;

  /** Maximum concurrent requests to Nexus. Defaults to 20. */
  readonly maxConcurrency?: number | undefined;

  /**
   * Byte threshold for exists-before-put optimization on CAS puts.
   * Blobs larger than this check `exists()` before uploading.
   * Defaults to 65536 (64 KB).
   */
  readonly existsThresholdBytes?: number | undefined;

  /**
   * Maximum file size accepted by NexusCas.putFile().
   *
   * Nexus currently uploads blobs through a JSON/base64 transport, so putFile()
   * must reject very large files before reading them into memory. Defaults to
   * 67,108,864 bytes (64 MiB).
   */
  readonly maxPutFileBytes?: number | undefined;

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
  readonly maxPutFileBytes: number;
  readonly cacheMaxEntries: number;
  readonly retryMaxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly watchPublisher: NexusWatchPublisher | undefined;
}

/** Apply defaults to a NexusConfig. */
export function resolveConfig(config: NexusConfig): ResolvedNexusConfig {
  return {
    client: config.client,
    zoneId: config.zoneId,
    sessionId: config.sessionId,
    maxConcurrency: config.maxConcurrency ?? 20,
    existsThresholdBytes: config.existsThresholdBytes ?? 65_536,
    maxPutFileBytes: config.maxPutFileBytes ?? 67_108_864,
    cacheMaxEntries: config.cacheMaxEntries ?? 1_000,
    retryMaxAttempts: config.retryMaxAttempts ?? 3,
    retryBaseDelayMs: config.retryBaseDelayMs ?? 100,
    retryMaxDelayMs: config.retryMaxDelayMs ?? 5_000,
    watchPublisher: config.watchPublisher,
  };
}
