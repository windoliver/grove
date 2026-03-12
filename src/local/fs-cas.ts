/**
 * Filesystem-backed Content-Addressable Storage.
 *
 * Stores artifacts by BLAKE3 hash on the local filesystem.
 * Layout: {root}/{hash[0:2]}/{hash[2:4]}/{hash}
 *
 * Writes are atomic: data is written to a temp file first, then renamed
 * into place to prevent partial writes on crash.
 *
 * Metadata updates on re-put follow last-writer-wins semantics:
 * if two concurrent puts store the same content with different mediaType
 * values, the last write determines the persisted mediaType.
 */

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, stat as fsStat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createHash as createBlake3, hash } from "blake3";

import type { ContentStore, PutOptions } from "../core/cas.js";
import { validateMediaType } from "../core/cas.js";
import type { Artifact } from "../core/models.js";

/** Prefix for BLAKE3 content hashes. */
const HASH_PREFIX = "blake3:";

/**
 * Compute the BLAKE3 hash of a Uint8Array and return the prefixed hex string.
 *
 * Hashes the entire buffer synchronously in a single call. For large buffers
 * (100MB+) this may block the event loop for ~100ms. Prefer `putFile()` for
 * large artifacts — it uses streaming I/O and incremental hashing.
 */
function computeHash(data: Uint8Array): string {
  const digest = hash(data).toString("hex");
  return `${HASH_PREFIX}${digest}`;
}

/** Pattern for valid hex portion: exactly 64 lowercase hex characters. */
const HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Extract and validate the hex portion from a content hash string.
 * Throws if the hash is not in "blake3:<64-hex>" format.
 */
function hexFromHash(contentHash: string): string {
  if (!contentHash.startsWith(HASH_PREFIX)) {
    throw new Error(`Invalid content hash prefix: expected '${HASH_PREFIX}', got '${contentHash}'`);
  }
  const hex = contentHash.slice(HASH_PREFIX.length);
  if (!HEX_PATTERN.test(hex)) {
    throw new Error("Invalid content hash: hex portion must be 64 lowercase hex characters");
  }
  return hex;
}

/** Check if an error is a "file not found" (ENOENT) error. */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Write data to a file atomically via temp file + rename.
 * Prevents partial writes on crash.
 */
async function atomicWrite(targetPath: string, data: string | Uint8Array): Promise<void> {
  const tmpFile = `${targetPath}.tmp.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await Bun.write(tmpFile, data);
  await rename(tmpFile, targetPath);
}

/**
 * Filesystem-backed ContentStore using BLAKE3 hashing.
 *
 * Directory layout: `{rootPath}/{hex[0:2]}/{hex[2:4]}/{hex}`
 * where `hex` is the 64-character lowercase hex hash.
 */
export class FsCas implements ContentStore {
  readonly rootPath: string;

  /** Tracks directories created this session to skip redundant mkdir syscalls. */
  private readonly knownDirs = new Set<string>();

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  /**
   * Resolve a content hash to its filesystem paths.
   * Validates the hash format and returns blob path and meta path.
   */
  private resolve(contentHash: string): { blobPath: string; metaPath: string } {
    const hex = hexFromHash(contentHash);
    const blobPath = join(this.rootPath, hex.slice(0, 2), hex.slice(2, 4), hex);
    return { blobPath, metaPath: `${blobPath}.meta` };
  }

  /**
   * Ensure the parent directory for a blob path exists.
   * Skips the mkdir syscall if the directory was already created this session.
   */
  private async ensureDir(blobPath: string): Promise<void> {
    const dir = dirname(blobPath);
    if (this.knownDirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    this.knownDirs.add(dir);
  }

  /**
   * Write a metadata sidecar JSON file atomically if mediaType is provided.
   * Uses temp file + rename for crash safety, matching the blob write pattern.
   */
  private async writeMeta(metaPath: string, options?: PutOptions): Promise<void> {
    if (!options?.mediaType) return;
    validateMediaType(options.mediaType);
    await atomicWrite(metaPath, JSON.stringify({ mediaType: options.mediaType }));
  }

  /**
   * Read a metadata sidecar JSON file.
   * Returns undefined if the sidecar is missing or corrupted (graceful degradation).
   */
  private async readMeta(metaPath: string): Promise<string | undefined> {
    try {
      const file = Bun.file(metaPath);
      const text = await file.text();
      const data = JSON.parse(text) as { mediaType?: string };
      return typeof data.mediaType === "string" ? data.mediaType : undefined;
    } catch (err) {
      // Missing sidecar or corrupted JSON — degrade gracefully.
      // Rethrow real infrastructure errors (permissions, disk I/O).
      if (isNotFound(err) || err instanceof SyntaxError) return undefined;
      throw err;
    }
  }

  /**
   * Store bytes and return the content hash.
   * Uses atomic write (temp file + rename) for crash safety.
   *
   * For in-memory data, the BLAKE3 hash is computed synchronously.
   * For large buffers (100MB+) this may briefly block the event loop.
   * Prefer `putFile()` for large artifacts — it uses streaming I/O
   * and incremental hashing in constant memory.
   */
  async put(data: Uint8Array, options?: PutOptions): Promise<string> {
    const contentHash = computeHash(data);
    const { blobPath, metaPath } = this.resolve(contentHash);

    // Skip write if content already exists
    try {
      await fsStat(blobPath);
      // Content exists — still persist metadata if newly provided
      await this.writeMeta(metaPath, options);
      return contentHash;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    await this.ensureDir(blobPath);
    await atomicWrite(blobPath, data);
    await this.writeMeta(metaPath, options);

    return contentHash;
  }

  /**
   * Retrieve bytes by content hash.
   * Returns undefined if the content is not found.
   */
  async get(contentHash: string): Promise<Uint8Array | undefined> {
    const { blobPath } = this.resolve(contentHash);
    try {
      const file = Bun.file(blobPath);
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Check if content exists by hash.
   */
  async exists(contentHash: string): Promise<boolean> {
    const { blobPath } = this.resolve(contentHash);
    try {
      await fsStat(blobPath);
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * Check existence of multiple content hashes in parallel.
   * Returns a map of hash → boolean.
   */
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

  /**
   * Delete content by hash.
   * Returns true if the content was deleted, false if it did not exist.
   */
  async delete(contentHash: string): Promise<boolean> {
    const { blobPath, metaPath } = this.resolve(contentHash);

    try {
      await unlink(blobPath);
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }

    // Clean up sidecar metadata — only ignore ENOENT, rethrow other errors
    try {
      await unlink(metaPath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    return true;
  }

  /**
   * Store a file and return the content hash.
   *
   * Uses streaming I/O and incremental BLAKE3 hashing so that
   * arbitrarily large files can be stored in constant memory.
   * Preferred over `put()` for large artifacts.
   *
   * The source file is copied to a staging temp file first, then the
   * temp file is hashed. This guarantees the stored blob always matches
   * its content hash — no two-pass TOCTOU window on the source.
   */
  async putFile(path: string, options?: PutOptions): Promise<string> {
    // Stage: copy source to a temp file so we have an immutable snapshot.
    // We use the CAS root for temp files to ensure same-filesystem rename.
    await mkdir(this.rootPath, { recursive: true });
    const stagingFile = join(
      this.rootPath,
      `.staging.${Date.now()}.${randomBytes(4).toString("hex")}`,
    );
    try {
      await copyFile(path, stagingFile);
    } catch (err) {
      // Clean up staging file on copy failure (may not exist yet)
      try {
        await unlink(stagingFile);
      } catch {
        /* ignore cleanup errors */
      }
      throw err;
    }

    // Hash the staged copy — this is the single source of truth.
    // dispose() frees native WASM memory if the stream errors before digest().
    const hasher = createBlake3();
    try {
      for await (const chunk of createReadStream(stagingFile)) {
        hasher.update(chunk);
      }
    } catch (err) {
      hasher.dispose();
      await unlink(stagingFile).catch(() => {});
      throw err;
    }
    // Note: digest() internally frees the native WASM handle.
    // Do NOT call hasher.dispose() after digest() — it will crash.
    const contentHash = `${HASH_PREFIX}${hasher.digest("hex")}`;
    const { blobPath, metaPath } = this.resolve(contentHash);

    // Skip rename if content already exists
    try {
      await fsStat(blobPath);
      await unlink(stagingFile).catch(() => {});
      await this.writeMeta(metaPath, options);
      return contentHash;
    } catch (err) {
      if (!isNotFound(err)) {
        await unlink(stagingFile).catch(() => {});
        throw err;
      }
    }

    // Atomic placement: rename staged temp into the content-addressed path
    await this.ensureDir(blobPath);
    await rename(stagingFile, blobPath);

    await this.writeMeta(metaPath, options);
    return contentHash;
  }

  /**
   * Retrieve content to a file.
   * Uses kernel-optimized file copy (sendfile/clonefile) for efficient transfer
   * without buffering the entire blob in memory.
   * Returns true if found and written, false otherwise.
   * Throws if the output path's parent directory does not exist.
   */
  async getToFile(contentHash: string, path: string): Promise<boolean> {
    const { blobPath } = this.resolve(contentHash);

    try {
      await copyFile(blobPath, path);
      return true;
    } catch (err) {
      if (!isNotFound(err)) throw err;

      // ENOENT could mean the source blob is missing (return false)
      // or the destination parent directory doesn't exist (rethrow).
      // Disambiguate by checking the source.
      try {
        await fsStat(blobPath);
      } catch {
        // Source doesn't exist — blob not found
        return false;
      }
      // Source exists but dest path is invalid — rethrow original error
      throw err;
    }
  }

  /**
   * Get artifact metadata without downloading the blob bytes.
   * Returns content hash, size, and optional media type.
   * Uses a single stat syscall for existence check and size.
   */
  async stat(contentHash: string): Promise<Artifact | undefined> {
    const { blobPath, metaPath } = this.resolve(contentHash);
    try {
      const stats = await fsStat(blobPath);
      const mediaType = await this.readMeta(metaPath);
      return {
        contentHash,
        sizeBytes: stats.size,
        ...(mediaType !== undefined && { mediaType }),
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Release resources. No-op for filesystem storage.
   */
  close(): void {
    // No resources to clean up
  }
}
