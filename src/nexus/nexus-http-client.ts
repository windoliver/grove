/**
 * Production NexusClient using JSON-RPC over HTTP.
 *
 * Connects to a real nexi-lab/nexus instance at the given URL.
 * All VFS operations are dispatched as JSON-RPC calls to POST /api/nfs/{method}.
 * Binary content is base64-encoded for JSON transport.
 */

import type {
  FileMeta,
  ListEntry,
  ListOptions,
  ListResult,
  MkdirOptions,
  NexusClient,
  ReadResult,
  SearchOptions,
  SearchResult,
  WriteOptions,
  WriteResult,
} from "./client.js";
import {
  type JsonRpcError,
  mapJsonRpcError,
  NexusAuthError,
  NexusConnectionError,
  NexusNotFoundError,
  NexusTimeoutError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the HTTP-based NexusClient. */
export interface NexusHttpConfig {
  /** Nexus server URL (e.g., "http://localhost:2026"). */
  readonly url: string;
  /** Bearer token for Authorization header. */
  readonly apiKey?: string | undefined;
  /** Request timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64(data: Uint8Array): string {
  // Use Buffer for efficient base64 encoding
  return Buffer.from(data).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------------------------------------------------------------------------
// NexusHttpClient
// ---------------------------------------------------------------------------

/**
 * JSON-RPC HTTP client for nexi-lab/nexus.
 */
export class NexusHttpClient implements NexusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private requestId = 0;
  private closed = false;

  constructor(config: NexusHttpConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // -----------------------------------------------------------------------
  // JSON-RPC transport
  // -----------------------------------------------------------------------

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new NexusConnectionError("Client is closed");

    const id = ++this.requestId;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, id });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/nfs/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new NexusTimeoutError(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw new NexusConnectionError(
        `Failed to connect to Nexus at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new NexusAuthError(`Auth failed: HTTP ${response.status}`);
    }
    if (response.status >= 500) {
      throw new NexusConnectionError(`Nexus server error: HTTP ${response.status}`);
    }

    const result = (await response.json()) as {
      result?: T;
      error?: JsonRpcError;
    };
    if (result.error) {
      throw mapJsonRpcError(result.error);
    }
    return result.result as T;
  }

  // -----------------------------------------------------------------------
  // NexusClient implementation
  // -----------------------------------------------------------------------

  async read(path: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.rpc<{ content: string; encoding: string }>("sys_read", { path });
      if (result.encoding === "base64") {
        return fromBase64(result.content);
      }
      // Handle raw string content
      return new TextEncoder().encode(result.content);
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async readWithMeta(path: string): Promise<ReadResult | undefined> {
    try {
      const result = await this.rpc<{ content: string; encoding: string; etag: string }>(
        "sys_read",
        { path, include_meta: true },
      );
      const content =
        result.encoding === "base64"
          ? fromBase64(result.content)
          : new TextEncoder().encode(result.content);
      return { content, etag: result.etag };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
    const params: Record<string, unknown> = {
      path,
      content: toBase64(content),
    };
    if (opts?.ifMatch !== undefined) params.if_match = opts.ifMatch;
    if (opts?.ifNoneMatch !== undefined) params.if_none_match = opts.ifNoneMatch;
    if (opts?.force !== undefined) params.force = opts.force;

    const result = await this.rpc<{ bytes_written: number; etag: string; version?: number }>(
      "sys_write",
      params,
    );
    return {
      bytesWritten: result.bytes_written,
      etag: result.etag,
      version: result.version,
    };
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.rpc<{ exists: boolean }>("exists", { path });
    return result.exists;
  }

  async stat(path: string): Promise<FileMeta | undefined> {
    try {
      const result = await this.rpc<{
        metadata: {
          size?: number;
          etag?: string;
          content_type?: string;
          created_at?: string;
          modified_at?: string;
        };
      }>("sys_stat", { path });
      const m = result.metadata;
      return {
        size: m.size ?? 0,
        etag: m.etag ?? "",
        contentType: m.content_type,
        createdAt: m.created_at,
        modifiedAt: m.modified_at,
      };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async delete(path: string): Promise<boolean> {
    try {
      await this.rpc<{ deleted: boolean }>("delete", { path });
      return true;
    } catch (err) {
      if (err instanceof NexusNotFoundError) return false;
      throw err;
    }
  }

  async list(path: string, opts?: ListOptions): Promise<ListResult> {
    const params: Record<string, unknown> = { path };
    if (opts?.recursive !== undefined) params.recursive = opts.recursive;
    if (opts?.details !== undefined) params.details = opts.details;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    if (opts?.cursor !== undefined) params.cursor = opts.cursor;

    const result = await this.rpc<{
      files: Array<{
        name: string;
        path: string;
        size?: number;
        etag?: string;
        is_directory?: boolean;
      }>;
      has_more: boolean;
      next_cursor?: string;
    }>("list", params);

    return {
      files: result.files.map(
        (f): ListEntry => ({
          name: f.name,
          path: f.path,
          size: f.size,
          etag: f.etag,
          isDirectory: f.is_directory,
        }),
      ),
      hasMore: result.has_more,
      nextCursor: result.next_cursor,
    };
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    const params: Record<string, unknown> = { path };
    if (opts?.parents !== undefined) params.parents = opts.parents;
    await this.rpc<{ created: boolean }>("mkdir", params);
  }

  async search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]> {
    const params: Record<string, unknown> = { query };
    if (opts?.path !== undefined) params.path = opts.path;
    if (opts?.limit !== undefined) params.limit = opts.limit;

    const result = await this.rpc<{
      results: Array<{ path: string; snippet?: string; score?: number }>;
    }>("search", params);

    return result.results.map(
      (r): SearchResult => ({
        path: r.path,
        snippet: r.snippet,
        score: r.score,
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
