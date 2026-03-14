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
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { NexusClient } from "./client.js";
import type { NexusConfig, ResolvedNexusConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { LruCache } from "./lru-cache.js";
import { withRetry, withSemaphore } from "./retry.js";
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
      const fileExists = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.exists(blobPath)),
        "put.exists",
        this.config,
      );
      if (fileExists) {
        if (mediaType) {
          const metaPath = casMetaPath(this.zoneId, contentHash);
          await withRetry(
            () =>
              withSemaphore(this.semaphore, () =>
                this.client.write(metaPath, encodeMetadata(mediaType)),
              ),
            "put.meta",
            this.config,
          );
        }
        this.existsCache.set(contentHash, true);
        // Invalidate statCache — mediaType may have changed
        this.statCache.delete(contentHash);
        return contentHash;
      }
    }

    await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.write(blobPath, data)),
      "put",
      this.config,
    );

    if (mediaType) {
      const metaPath = casMetaPath(this.zoneId, contentHash);
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(metaPath, encodeMetadata(mediaType)),
          ),
        "put.meta",
        this.config,
      );
    }

    this.existsCache.set(contentHash, true);
    this.statCache.delete(contentHash);
    return contentHash;
  }

  async get(contentHash: string): Promise<Uint8Array | undefined> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    return withRetry(
      () => withSemaphore(this.semaphore, () => this.client.read(blobPath)),
      "get",
      this.config,
    );
  }

  async exists(contentHash: string): Promise<boolean> {
    validateHash(contentHash);

    const cached = this.existsCache.get(contentHash);
    if (cached !== undefined) return cached;

    const blobPath = casPath(this.zoneId, contentHash);
    const fileExists = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.exists(blobPath)),
      "exists",
      this.config,
    );
    if (fileExists) this.existsCache.set(contentHash, true);
    return fileExists;
  }

  async existsMany(contentHashes: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const result = new Map<string, boolean>();
    if (contentHashes.length === 0) return result;
    const entries = await Promise.all(
      contentHashes.map(async (hash) => [hash, await this.exists(hash)] as const),
    );
    for (const [hash, exists] of entries) {
      result.set(hash, exists);
    }
    return result;
  }

  async delete(contentHash: string): Promise<boolean> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    const deleted = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.delete(blobPath)),
      "delete",
      this.config,
    );
    // Also delete metadata sidecar
    const metaPath = casMetaPath(this.zoneId, contentHash);
    await safeCleanup(
      withRetry(
        () => withSemaphore(this.semaphore, () => this.client.delete(metaPath)),
        "delete.meta",
        this.config,
      ),
      "delete CAS metadata sidecar",
      { silent: true },
    );
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
    const fileExists = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.exists(blobPath)),
      "putFile.exists",
      this.config,
    );
    if (fileExists) {
      if (mediaType) {
        const metaP = casMetaPath(this.zoneId, contentHash);
        await withRetry(
          () =>
            withSemaphore(this.semaphore, () =>
              this.client.write(metaP, encodeMetadata(mediaType)),
            ),
          "putFile.meta",
          this.config,
        );
      }
      this.existsCache.set(contentHash, true);
      // Invalidate statCache — mediaType may have changed
      this.statCache.delete(contentHash);
      return contentHash;
    }

    await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.write(blobPath, fileData)),
      "putFile",
      this.config,
    );

    if (mediaType) {
      const metaP = casMetaPath(this.zoneId, contentHash);
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () => this.client.write(metaP, encodeMetadata(mediaType))),
        "putFile.meta",
        this.config,
      );
    }

    this.existsCache.set(contentHash, true);
    this.statCache.delete(contentHash);
    return contentHash;
  }

  async getToFile(contentHash: string, destPath: string): Promise<boolean> {
    validateHash(contentHash);
    const blobPath = casPath(this.zoneId, contentHash);
    const data = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.read(blobPath)),
      "getToFile",
      this.config,
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
    const fileMeta = await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.stat(blobPath)),
      "stat",
      this.config,
    );
    if (fileMeta === undefined) return undefined;

    // Read metadata sidecar for mediaType
    let mediaType: string | undefined;
    const metaPath = casMetaPath(this.zoneId, contentHash);
    let metaData: Uint8Array | undefined;
    try {
      metaData = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.read(metaPath)),
        "stat.meta",
        this.config,
      );
    } catch {
      // Expected: metadata sidecar may not exist
      metaData = undefined;
    }
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
}
