/**
 * Filesystem-backed Content-Addressable Storage.
 *
 * Stores artifacts by BLAKE3 hash on the local filesystem.
 * Layout: {root}/{hash[0:2]}/{hash[2:4]}/{hash}
 *
 * Writes are atomic: data is written to a temp file first, then renamed
 * into place to prevent partial writes on crash.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hash } from "blake3";

import type { ContentStore, PutOptions } from "../core/cas.js";
import { validateMediaType } from "../core/cas.js";
import type { Artifact } from "../core/models.js";

/** Prefix for BLAKE3 content hashes. */
const HASH_PREFIX = "blake3:";

/**
 * Compute the BLAKE3 hash of a Uint8Array and return the prefixed hex string.
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
    throw new Error(`Invalid content hash: hex portion must be 64 lowercase hex characters`);
  }
  return hex;
}

/**
 * Filesystem-backed ContentStore using BLAKE3 hashing.
 *
 * Directory layout: `{rootPath}/{hex[0:2]}/{hex[2:4]}/{hex}`
 * where `hex` is the 64-character lowercase hex hash.
 */
export class FsCas implements ContentStore {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  /**
   * Build the filesystem path for a given hex hash.
   */
  private blobPath(hex: string): string {
    return join(this.rootPath, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  /**
   * Build the filesystem path for a metadata sidecar file.
   */
  private metaPath(hex: string): string {
    return `${this.blobPath(hex)}.meta`;
  }

  /**
   * Write a metadata sidecar JSON file if mediaType is provided.
   */
  private async writeMeta(hex: string, options?: PutOptions): Promise<void> {
    if (!options?.mediaType) return;
    validateMediaType(options.mediaType);
    const metaFile = this.metaPath(hex);
    await Bun.write(metaFile, JSON.stringify({ mediaType: options.mediaType }));
  }

  /**
   * Read a metadata sidecar JSON file, if it exists.
   */
  private async readMeta(hex: string): Promise<string | undefined> {
    const metaFile = this.metaPath(hex);
    const file = Bun.file(metaFile);
    if (!(await file.exists())) return undefined;
    const data = JSON.parse(await file.text()) as { mediaType?: string };
    return data.mediaType;
  }

  /**
   * Store bytes and return the content hash.
   * Uses atomic write (temp file + rename) for crash safety.
   */
  put = async (data: Uint8Array, options?: PutOptions): Promise<string> => {
    const contentHash = computeHash(data);
    const hex = hexFromHash(contentHash);
    const blobFile = this.blobPath(hex);

    // Skip write if content already exists
    const file = Bun.file(blobFile);
    if (await file.exists()) {
      // Still persist metadata if newly provided
      await this.writeMeta(hex, options);
      return contentHash;
    }

    // Ensure parent directories exist
    const dir = dirname(blobFile);
    await mkdir(dir, { recursive: true });

    // Atomic write: write to temp file, then rename
    const tmpFile = `${blobFile}.tmp.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await Bun.write(tmpFile, data);
    await rename(tmpFile, blobFile);

    await this.writeMeta(hex, options);

    return contentHash;
  };

  /**
   * Retrieve bytes by content hash.
   * Returns undefined if the content is not found.
   */
  get = async (contentHash: string): Promise<Uint8Array | undefined> => {
    const hex = hexFromHash(contentHash);
    const blobFile = this.blobPath(hex);
    const file = Bun.file(blobFile);

    if (!(await file.exists())) {
      return undefined;
    }

    return new Uint8Array(await file.arrayBuffer());
  };

  /**
   * Check if content exists by hash.
   */
  exists = async (contentHash: string): Promise<boolean> => {
    const hex = hexFromHash(contentHash);
    const blobFile = this.blobPath(hex);
    const file = Bun.file(blobFile);
    return file.exists();
  };

  /**
   * Delete content by hash.
   * Returns true if the content was deleted, false if it did not exist.
   */
  delete = async (contentHash: string): Promise<boolean> => {
    const hex = hexFromHash(contentHash);
    const blobFile = this.blobPath(hex);
    const file = Bun.file(blobFile);

    if (!(await file.exists())) {
      return false;
    }

    await unlink(blobFile);

    // Clean up sidecar metadata file if it exists
    const metaFile = this.metaPath(hex);
    try {
      await unlink(metaFile);
    } catch {
      // Sidecar may not exist — that's fine
    }

    return true;
  };

  /**
   * Store a file's contents and return the content hash.
   * Reads the file, hashes it, and stores via put().
   */
  putFile = async (path: string, options?: PutOptions): Promise<string> => {
    const file = Bun.file(path);
    const data = new Uint8Array(await file.arrayBuffer());
    return this.put(data, options);
  };

  /**
   * Retrieve content and write it to a file.
   * Returns true if the content was found and written, false otherwise.
   */
  getToFile = async (contentHash: string, path: string): Promise<boolean> => {
    const data = await this.get(contentHash);
    if (data === undefined) {
      return false;
    }
    await Bun.write(path, data);
    return true;
  };

  /**
   * Get artifact metadata without downloading the blob bytes.
   * Returns content hash, size, and optional media type from sidecar.
   */
  stat = async (contentHash: string): Promise<Artifact | undefined> => {
    const hex = hexFromHash(contentHash);
    const blobFile = this.blobPath(hex);
    const file = Bun.file(blobFile);

    if (!(await file.exists())) {
      return undefined;
    }

    const mediaType = await this.readMeta(hex);
    return {
      contentHash,
      sizeBytes: file.size,
      ...(mediaType !== undefined && { mediaType }),
    };
  };

  /**
   * Release resources. No-op for filesystem storage.
   */
  close(): void {
    // No resources to clean up
  }
}
