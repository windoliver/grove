/**
 * Nexus-backed ContentStore adapter.
 *
 * Implements the ContentStore interface using a NexusClient VFS for
 * content-addressed blob storage. Uses BLAKE3 hashing (same as Grove).
 *
 * Storage layout in Nexus VFS:
 * - Blob content:  /zones/{zoneId}/cas/{hash}
 * - Metadata:      /zones/{zoneId}/cas/{hash}.meta  (JSON with mediaType)
 *
 * Features:
 * - Zone-scoped paths for multi-tenancy
 * - exists-before-put optimization for large blobs
 * - LRU cache for exists() and stat() (immutable data)
 * - Concurrency semaphore to limit parallel Nexus requests
 * - Retry with exponential backoff for transient errors
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { hash } from "blake3";

import type { ContentStore, PutOptions } from "../core/cas.js";
import { validateMediaType } from "../core/cas.js";
import type { Artifact } from "../core/models.js";
import type { NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { isRetryable, mapNexusError } from "./errors.js";
import { LruCache } from "./lru-cache.js";
import { Semaphore } from "./semaphore.js";
import { casMetaPath, casPath } from "./vfs-paths.js";

/** Prefix for BLAKE3 content hashes. */
const HASH_PREFIX = "blake3:";

/** Pattern for valid hex portion: exactly 64 lowercase hex characters. */
const HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Compute the BLAKE3 hash of a Uint8Array and return the prefixed hex string. */
function computeHash(data: Uint8Array): string {
  const digest = hash(data).toString("hex");
  return `${HASH_PREFIX}${digest}`;
}

/** Validate a content hash string format. */
function validateHash(contentHash: string): void {
  if (!contentHash.startsWith(HASH_PREFIX)) {
    throw new Error(`Invalid content hash prefix: expected '${HASH_PREFIX}', got '${contentHash}'`);
  }
  const hex = contentHash.slice(HASH_PREFIX.length);
  if (!HEX_PATTERN.test(hex)) {
    throw new Error("Invalid content hash: hex portion must be 64 lowercase hex characters");
  }
}

const encoder = new TextEncoder();

/** Encode metadata sidecar as JSON bytes. */
function encodeMetadata(mediaType: string): Uint8Array {
  return encoder.encode(JSON.stringify({ mediaType }));
}

/** Decode metadata sidecar from JSON bytes. */
function decodeMetadata(data: Uint8Array): { mediaType?: string } {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return {};
  }
}

/**
 * Nexus-backed Content-Addressable Storage.
 */
export class NexusCas implements ContentStore {
  private readonly client: NexusClient;
  private readonly config: ResolvedNexusConfig;
  private readonly zoneId: string;
  private readonly semaphore: Semaphore;
  private readonly existsCache: LruCache<boolean>;
  private readonly statCache: LruCache<Artifact>;

  constructor(config: NexusConfig) {
    this.config = resolveConfig(config);
    this.client = this.config.client;
    this.zoneId = this.config.zoneId;
    this.semaphore = new Semaphore(this.config.maxConcurrency);
    this.existsCache = new LruCache(this.config.cacheMaxEntries);
    this.statCache = new LruCache(this.config.cacheMaxEntries);
  }

  async put(data: Uint8Array, options?: PutOptions): Promise<string> {
    const mediaType = options?.mediaType || undefined;
    if (mediaType) validateMediaType(mediaType);

    const contentHash = computeHash(data);
    const blobPath = casPath(this.zoneId, contentHash);

    // Exists-before-put optimization for large blobs
    if (data.byteLength > this.config.existsThresholdBytes) {
      const fileExists = await this.withRetry(
        () => this.runWithSemaphore(() => this.client.exists(blobPath)),
        "put.exists",
      );
      if (fileExists) {
        if (mediaType) {
          const metaPath = casMetaPath(this.zoneId, contentHash);
          await this.withRetry(
            () =>
              this.runWithSemaphore(() => this.client.write(metaPath, encodeMetadata(mediaType))),
            "put.meta",
          );
        }
        this.existsCache.set(contentHash, true);
        // Invalidate statCache — mediaType may have changed
        this.statCache.delete(contentHash);
        return contentHash;
      }
    }

    await this.withRetry(
      () => this.runWithSemaphore(() => this.client.write(blobPath, data)),
      "put",
    );

    if (mediaType) {
      const metaPath = casMetaPath(this.zoneId, contentHash);
      await this.withRetry(
        () => this.runWithSemaphore(() => this.client.write(metaPath, encodeMetadata(mediaType))),
        "put.meta",
      );
    }

    this.existsCache.set(contentHash, true);
    this.statCache.delete(contentHash);
    return contentHash;
  }

  async get(contentHash: string): Promise<Uint8Array | undefined> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    return this.withRetry(() => this.runWithSemaphore(() => this.client.read(blobPath)), "get");
  }

  async exists(contentHash: string): Promise<boolean> {
    validateHash(contentHash);

    const cached = this.existsCache.get(contentHash);
    if (cached !== undefined) return cached;

    const blobPath = casPath(this.zoneId, contentHash);
    const fileExists = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.exists(blobPath)),
      "exists",
    );
    if (fileExists) this.existsCache.set(contentHash, true);
    return fileExists;
  }

  async delete(contentHash: string): Promise<boolean> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    const deleted = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.delete(blobPath)),
      "delete",
    );
    // Also delete metadata sidecar
    const metaPath = casMetaPath(this.zoneId, contentHash);
    await this.withRetry(
      () => this.runWithSemaphore(() => this.client.delete(metaPath)),
      "delete.meta",
    ).catch(() => {});
    this.existsCache.delete(contentHash);
    this.statCache.delete(contentHash);
    return deleted;
  }

  async putFile(filePath: string, options?: PutOptions): Promise<string> {
    const mediaType = options?.mediaType || undefined;
    if (mediaType) validateMediaType(mediaType);

    // Read file and compute hash
    const fileData = new Uint8Array(readFileSync(filePath));
    const contentHash = computeHash(fileData);
    const blobPath = casPath(this.zoneId, contentHash);

    // Exists-before-put — file-based puts are always "large"
    const fileExists = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.exists(blobPath)),
      "putFile.exists",
    );
    if (fileExists) {
      if (mediaType) {
        const metaP = casMetaPath(this.zoneId, contentHash);
        await this.withRetry(
          () => this.runWithSemaphore(() => this.client.write(metaP, encodeMetadata(mediaType))),
          "putFile.meta",
        );
      }
      this.existsCache.set(contentHash, true);
      // Invalidate statCache — mediaType may have changed
      this.statCache.delete(contentHash);
      return contentHash;
    }

    await this.withRetry(
      () => this.runWithSemaphore(() => this.client.write(blobPath, fileData)),
      "putFile",
    );

    if (mediaType) {
      const metaP = casMetaPath(this.zoneId, contentHash);
      await this.withRetry(
        () => this.runWithSemaphore(() => this.client.write(metaP, encodeMetadata(mediaType))),
        "putFile.meta",
      );
    }

    this.existsCache.set(contentHash, true);
    this.statCache.delete(contentHash);
    return contentHash;
  }

  async getToFile(contentHash: string, destPath: string): Promise<boolean> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    const data = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.read(blobPath)),
      "getToFile",
    );
    if (data === undefined) return false;
    await writeFile(destPath, data);
    return true;
  }

  async stat(contentHash: string): Promise<Artifact | undefined> {
    validateHash(contentHash);

    const cached = this.statCache.get(contentHash);
    if (cached !== undefined) return cached;

    const blobPath = casPath(this.zoneId, contentHash);
    const fileMeta = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.stat(blobPath)),
      "stat",
    );
    if (fileMeta === undefined) return undefined;

    // Read metadata sidecar for mediaType
    let mediaType: string | undefined;
    const metaPath = casMetaPath(this.zoneId, contentHash);
    const metaData = await this.withRetry(
      () => this.runWithSemaphore(() => this.client.read(metaPath)),
      "stat.meta",
    ).catch(() => undefined);
    if (metaData !== undefined) {
      const meta = decodeMetadata(metaData);
      mediaType = meta.mediaType || undefined;
    }

    const artifact: Artifact = {
      contentHash,
      sizeBytes: fileMeta.size,
      ...(mediaType ? { mediaType } : {}),
    };
    this.statCache.set(contentHash, artifact);
    this.existsCache.set(contentHash, true);
    return artifact;
  }

  close(): void {
    // No-op — lifecycle managed by client
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async runWithSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    return this.semaphore.run(fn);
  }

  private async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.retryMaxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.config.retryMaxAttempts - 1) {
          throw mapNexusError(error, context);
        }
        const delay = Math.min(
          this.config.retryBaseDelayMs * 2 ** attempt,
          this.config.retryMaxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw mapNexusError(lastError, context);
  }
}
