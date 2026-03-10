/**
 * NexusClient port interface.
 *
 * Defines the abstract contract that a Nexus VFS backend must satisfy.
 * Models the real nexi-lab/nexus API: a POSIX-inspired virtual filesystem
 * accessed via JSON-RPC (HTTP) or gRPC.
 *
 * The Nexus adapters (NexusCas, NexusContributionStore, NexusClaimStore)
 * depend on this port — not on any concrete transport.
 *
 * For testing, use MockNexusClient (in-memory VFS).
 * For production, use NexusHttpClient (JSON-RPC over HTTP).
 */

// ---------------------------------------------------------------------------
// Write options and result
// ---------------------------------------------------------------------------

/** Options for write operations. */
export interface WriteOptions {
  /** ETag for conditional write (optimistic concurrency). */
  readonly ifMatch?: string | undefined;
  /** Set to "*" to only write if the file does not exist. */
  readonly ifNoneMatch?: string | undefined;
  /** Force overwrite regardless of conditions. */
  readonly force?: boolean | undefined;
}

/** Result of a successful write. */
export interface WriteResult {
  readonly bytesWritten: number;
  readonly etag: string;
  readonly version?: number | undefined;
}

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

/** File metadata returned by stat(). */
export interface FileMeta {
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly modifiedAt?: string | undefined;
}

// ---------------------------------------------------------------------------
// List (directory listing)
// ---------------------------------------------------------------------------

/** Options for list(). */
export interface ListOptions {
  readonly recursive?: boolean | undefined;
  readonly details?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** Result of a list() call. */
export interface ListResult {
  readonly files: readonly ListEntry[];
  readonly hasMore: boolean;
  readonly nextCursor?: string | undefined;
}

/** A single entry in a directory listing. */
export interface ListEntry {
  readonly name: string;
  readonly path: string;
  readonly size?: number | undefined;
  readonly etag?: string | undefined;
  readonly isDirectory?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Mkdir
// ---------------------------------------------------------------------------

/** Options for mkdir(). */
export interface MkdirOptions {
  readonly parents?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Options for search(). */
export interface SearchOptions {
  readonly path?: string | undefined;
  readonly limit?: number | undefined;
}

/** A single search result. */
export interface SearchResult {
  readonly path: string;
  readonly snippet?: string | undefined;
  readonly score?: number | undefined;
}

// ---------------------------------------------------------------------------
// Read result
// ---------------------------------------------------------------------------

/** Result of readWithMeta(): content + ETag from a single atomic read. */
export interface ReadResult {
  readonly content: Uint8Array;
  readonly etag: string;
}

// ---------------------------------------------------------------------------
// NexusClient interface
// ---------------------------------------------------------------------------

/**
 * Abstract port for communicating with a Nexus VFS backend.
 *
 * Models the real nexi-lab/nexus syscall API:
 * - sys_read / sys_write / exists / sys_stat / delete / list / mkdir / search
 * - ETag-based optimistic concurrency on writes
 * - Path-based addressing (not generic keys)
 */
export interface NexusClient {
  /** Read a file. Returns undefined if the file does not exist. */
  read(path: string): Promise<Uint8Array | undefined>;

  /**
   * Read a file and return both its content and ETag atomically.
   * Returns undefined if the file does not exist.
   * Used for compare-and-swap patterns where the ETag must correspond
   * to exactly the version whose content was read.
   */
  readWithMeta(path: string): Promise<ReadResult | undefined>;

  /** Write a file. Supports conditional writes via ETags. */
  write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult>;

  /** Check if a file or directory exists. */
  exists(path: string): Promise<boolean>;

  /** Get file metadata. Returns undefined if not found. */
  stat(path: string): Promise<FileMeta | undefined>;

  /** Delete a file. Returns true if deleted, false if not found. */
  delete(path: string): Promise<boolean>;

  /** List files in a directory. */
  list(path: string, opts?: ListOptions): Promise<ListResult>;

  /** Create a directory. */
  mkdir(path: string, opts?: MkdirOptions): Promise<void>;

  /** Full-text search across files. */
  search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]>;

  /** Release resources. */
  close(): Promise<void>;
}
