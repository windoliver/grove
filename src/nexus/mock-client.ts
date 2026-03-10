/**
 * In-memory MockNexusClient for testing.
 *
 * Implements the NexusClient VFS interface with an in-memory file tree.
 * Supports ETag-based optimistic concurrency and failure injection.
 */

import type {
  FileMeta,
  ListEntry,
  ListOptions,
  ListResult,
  MkdirOptions,
  NexusClient,
  SearchOptions,
  SearchResult,
  WriteOptions,
  WriteResult,
} from "./client.js";
import { NexusConflictError, NexusConnectionError, NexusTimeoutError } from "./errors.js";

// ---------------------------------------------------------------------------
// Failure injection types
// ---------------------------------------------------------------------------

export type FailureKind = "timeout" | "connection" | "auth";

export interface FailureMode {
  /** Number of next calls that will fail. */
  readonly failNext: number;
  /** Type of failure to simulate. */
  readonly failWith: FailureKind;
}

// ---------------------------------------------------------------------------
// Internal file representation
// ---------------------------------------------------------------------------

interface VfsFile {
  content: Uint8Array;
  etag: string;
  createdAt: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// MockNexusClient
// ---------------------------------------------------------------------------

/**
 * In-memory VFS implementation of NexusClient for testing.
 *
 * All data is stored in Maps. Supports failure injection via
 * `setFailureMode()` for resilience testing.
 */
export class MockNexusClient implements NexusClient {
  private readonly files = new Map<string, VfsFile>();
  private readonly directories = new Set<string>(["/"]); // root always exists
  private etagCounter = 0;
  private failureMode: { failNext: number; failWith: FailureKind } | undefined;
  private closed = false;

  /**
   * Configure failure injection. The next `failNext` calls to any method
   * will throw the specified error. After that, calls succeed normally.
   */
  setFailureMode(mode: FailureMode | undefined): void {
    this.failureMode = mode !== undefined ? { ...mode } : undefined;
  }

  /** Check if the client has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  // -----------------------------------------------------------------------
  // Failure injection helper
  // -----------------------------------------------------------------------

  private maybeThrow(): void {
    if (this.closed) {
      throw new NexusConnectionError("Client is closed");
    }
    if (this.failureMode !== undefined && this.failureMode.failNext > 0) {
      this.failureMode = {
        ...this.failureMode,
        failNext: this.failureMode.failNext - 1,
      };
      switch (this.failureMode.failWith) {
        case "timeout":
          throw new NexusTimeoutError("Mock timeout");
        case "connection":
          throw new NexusConnectionError("Mock ECONNREFUSED");
        case "auth":
          throw new Error("401 Unauthorized");
        default:
          throw new NexusConnectionError("Mock failure");
      }
    }
  }

  // -----------------------------------------------------------------------
  // ETag generation
  // -----------------------------------------------------------------------

  private nextEtag(): string {
    return `etag-${++this.etagCounter}`;
  }

  // -----------------------------------------------------------------------
  // Directory helpers
  // -----------------------------------------------------------------------

  private ensureParentDirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      this.directories.add(current);
    }
  }

  private normalizeDirPath(path: string): string {
    return path.endsWith("/") ? path.slice(0, -1) : path;
  }

  // -----------------------------------------------------------------------
  // NexusClient implementation
  // -----------------------------------------------------------------------

  async read(path: string): Promise<Uint8Array | undefined> {
    this.maybeThrow();
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    return new Uint8Array(file.content);
  }

  async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
    this.maybeThrow();

    const existing = this.files.get(path);

    // Conditional write: ifNoneMatch="*" means file must not exist
    if (opts?.ifNoneMatch === "*" && existing !== undefined) {
      throw new NexusConflictError({
        message: `File already exists: ${path}`,
        expectedEtag: "*",
        actualEtag: existing.etag,
      });
    }

    // Conditional write: ifMatch means ETags must match
    if (opts?.ifMatch !== undefined && existing !== undefined && existing.etag !== opts.ifMatch) {
      throw new NexusConflictError({
        message: `ETag mismatch on ${path}: expected '${opts.ifMatch}', got '${existing.etag}'`,
        expectedEtag: opts.ifMatch,
        actualEtag: existing.etag,
      });
    }

    // ifMatch on a non-existent file also conflicts
    if (opts?.ifMatch !== undefined && existing === undefined) {
      throw new NexusConflictError({
        message: `File does not exist for conditional write: ${path}`,
        expectedEtag: opts.ifMatch,
      });
    }

    this.ensureParentDirs(path);
    const now = new Date().toISOString();
    const etag = this.nextEtag();

    this.files.set(path, {
      content: new Uint8Array(content),
      etag,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    });

    return { bytesWritten: content.byteLength, etag };
  }

  async exists(path: string): Promise<boolean> {
    this.maybeThrow();
    return this.files.has(path) || this.directories.has(this.normalizeDirPath(path));
  }

  async stat(path: string): Promise<FileMeta | undefined> {
    this.maybeThrow();
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    return {
      size: file.content.byteLength,
      etag: file.etag,
      createdAt: file.createdAt,
      modifiedAt: file.modifiedAt,
    };
  }

  async delete(path: string): Promise<boolean> {
    this.maybeThrow();
    return this.files.delete(path);
  }

  async list(path: string, opts?: ListOptions): Promise<ListResult> {
    this.maybeThrow();

    const dirPath = this.normalizeDirPath(path);
    const prefix = `${dirPath}/`;
    const entries: ListEntry[] = [];
    const seenDirs = new Set<string>();

    // Collect all files under this path
    const sortedPaths = [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();

    for (const filePath of sortedPaths) {
      const relativePath = filePath.slice(prefix.length);

      if (opts?.recursive) {
        const file = this.files.get(filePath);
        entries.push({
          name: relativePath.split("/").pop() ?? relativePath,
          path: filePath,
          ...(opts.details && file ? { size: file.content.byteLength, etag: file.etag } : {}),
          isDirectory: false,
        });
      } else {
        // Non-recursive: only immediate children
        const slashIndex = relativePath.indexOf("/");
        if (slashIndex === -1) {
          // Direct child file
          const file = this.files.get(filePath);
          entries.push({
            name: relativePath,
            path: filePath,
            ...(opts?.details && file ? { size: file.content.byteLength, etag: file.etag } : {}),
            isDirectory: false,
          });
        } else {
          // Subdirectory — add as directory entry (deduplicate)
          const dirName = relativePath.slice(0, slashIndex);
          const fullDirPath = `${prefix}${dirName}`;
          if (!seenDirs.has(fullDirPath)) {
            seenDirs.add(fullDirPath);
            entries.push({
              name: dirName,
              path: fullDirPath,
              isDirectory: true,
            });
          }
        }
      }
    }

    // Handle cursor-based pagination
    let startIndex = 0;
    if (opts?.cursor !== undefined) {
      const cursor = opts.cursor;
      const cursorIndex = entries.findIndex((e) => e.path > cursor);
      startIndex = cursorIndex >= 0 ? cursorIndex : entries.length;
    }

    const limit = opts?.limit ?? entries.length;
    const page = entries.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < entries.length;

    return {
      files: page,
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.path : undefined,
    };
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    this.maybeThrow();
    const dirPath = this.normalizeDirPath(path);
    if (opts?.parents) {
      this.ensureParentDirs(`${dirPath}/placeholder`);
      this.directories.add(dirPath);
    } else {
      this.directories.add(dirPath);
    }
  }

  async search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]> {
    this.maybeThrow();

    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];
    const decoder = new TextDecoder();
    const pathPrefix = opts?.path ?? "";

    for (const [filePath, file] of this.files) {
      if (pathPrefix && !filePath.startsWith(pathPrefix)) continue;

      try {
        const text = decoder.decode(file.content);
        const lowerText = text.toLowerCase();
        const index = lowerText.indexOf(lowerQuery);
        if (index >= 0) {
          const snippetStart = Math.max(0, index - 40);
          const snippetEnd = Math.min(text.length, index + query.length + 40);
          results.push({
            path: filePath,
            snippet: text.slice(snippetStart, snippetEnd),
          });
        }
      } catch {
        // Not a text file — skip
      }

      if (opts?.limit !== undefined && results.length >= opts.limit) break;
    }

    return results;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
