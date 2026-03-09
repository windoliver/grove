/**
 * Content-Addressable Storage (CAS) protocol.
 *
 * Artifacts are stored by BLAKE3 content hash.
 * Implementations handle deduplication automatically.
 */

/** Abstract content store — storage backends implement this. */
export interface ContentStore {
  /** Store bytes and return the content hash. */
  put(data: Uint8Array): Promise<string>;

  /** Retrieve bytes by content hash. Returns undefined if not found. */
  get(contentHash: string): Promise<Uint8Array | undefined>;

  /** Check if content exists. */
  exists(contentHash: string): Promise<boolean>;

  /** Delete content by hash. Returns true if deleted. */
  delete(contentHash: string): Promise<boolean>;

  /** Store a file and return the content hash. */
  putFile(path: string): Promise<string>;

  /** Retrieve content to a file. Returns true if found and written. */
  getToFile(contentHash: string, path: string): Promise<boolean>;
}
