/**
 * Production NexusClient using JSON-RPC over HTTP.
 *
 * Connects to a real nexi-lab/nexus instance at the given URL.
 * All VFS operations are dispatched as JSON-RPC calls to POST /api/nfs/{method}.
 * Binary content is base64-encoded for JSON transport.
 */

import { z } from "zod";

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
  return Buffer.from(data).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------------------------------------------------------------------------
// RPC response schemas — validate Nexus JSON-RPC responses at runtime
// ---------------------------------------------------------------------------

// Nexus returns bytes as { __type__: "bytes", data: "base64..." }
const BytesResultSchema = z.object({ __type__: z.literal("bytes"), data: z.string() });
// Also accept the legacy { content, encoding } shape for forward compat
const LegacyReadResultSchema = z.object({ content: z.string(), encoding: z.string() });
const ReadResultSchema = z.union([BytesResultSchema, LegacyReadResultSchema]);
const WriteResultSchema = z
  .object({
    bytes_written: z.number(),
    etag: z.string().optional(),
    version: z.number().optional(),
  })
  .passthrough();
const ExistsResultSchema = z.object({ exists: z.boolean() });
const StatResultSchema = z.object({
  metadata: z
    .object({
      size: z.number().optional(),
      etag: z.string().optional(),
      content_type: z.string().optional().nullable(),
      mime_type: z.string().optional().nullable(),
      created_at: z.string().optional().nullable(),
      modified_at: z.string().optional().nullable(),
    })
    .passthrough()
    .nullable(),
});
const DeleteResultSchema = z.object({ deleted: z.boolean() });
// Nexus list returns either flat strings or objects depending on details flag.
// - Without details: ["path/to/file", ...]
// - With details: [{ path, size, etag, is_directory, ... }, ...]
const ListEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    path: z.string(),
    size: z.number().optional(),
    etag: z.string().optional(),
    is_directory: z.boolean().optional(),
  }),
]);
const ListResultSchema = z.object({
  files: z.array(ListEntrySchema),
  has_more: z.boolean(),
  next_cursor: z.string().optional().nullable(),
});
const MkdirResultSchema = z.object({ created: z.boolean() });
const SearchResultSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      snippet: z.string().optional(),
      score: z.number().optional(),
    }),
  ),
});

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

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
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
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new NexusConnectionError(
        `Nexus rate limit exceeded (retry after ${retryAfter ?? "?"}s)`,
      );
    }
    if (response.status >= 500) {
      throw new NexusConnectionError(`Nexus server error: HTTP ${response.status}`);
    }

    const envelope = (await response.json()) as {
      result?: unknown;
      error?: JsonRpcError | string;
      detail?: string;
      retry_after?: number;
    };

    // Handle non-JSON-RPC error responses (e.g., rate limit responses
    // returned as plain JSON instead of JSON-RPC envelope)
    if (typeof envelope.error === "string") {
      if (envelope.error.toLowerCase().includes("rate limit")) {
        throw new NexusConnectionError(
          `Nexus rate limit: ${envelope.error} (retry after ${envelope.retry_after ?? "?"}s)`,
        );
      }
      throw new NexusConnectionError(`Nexus error: ${envelope.error}`);
    }

    if (envelope.error) {
      throw mapJsonRpcError(envelope.error);
    }
    return schema.parse(envelope.result);
  }

  // -----------------------------------------------------------------------
  // NexusClient implementation
  // -----------------------------------------------------------------------

  async read(path: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.rpc("sys_read", { path }, ReadResultSchema);
      // Nexus returns stored bytes base64-encoded for JSON transport.
      // We also base64-encode on write (for binary safety), so we need
      // to decode twice: once for transport, once for our storage encoding.
      const transportDecoded = this.decodeReadResult(result);
      return fromBase64(new TextDecoder().decode(transportDecoded));
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async readWithMeta(path: string): Promise<ReadResult | undefined> {
    try {
      // Nexus sys_read doesn't return etag inline. We stat FIRST to get
      // the etag, then read. This ordering is safe for CAS: if a concurrent
      // writer updates between stat and read, we get a stale etag with newer
      // content. A subsequent ifMatch write will fail (etag mismatch),
      // forcing a correct retry. The unsafe direction (read-then-stat) could
      // pair old content with a new etag, allowing a write to succeed when
      // it shouldn't.
      const meta = await this.stat(path);
      if (meta === undefined) return undefined;

      const result = await this.rpc("sys_read", { path }, ReadResultSchema);
      const transportDecoded = this.decodeReadResult(result);
      const content = fromBase64(new TextDecoder().decode(transportDecoded));
      return { content, etag: meta.etag };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
    // Nexus sys_write treats `content` as a raw string stored verbatim.
    // We base64-encode content so arbitrary binary (including non-UTF-8
    // bytes like 0xFF) survives the JSON transport and storage round-trip.
    // The corresponding read() double-decodes (transport base64 → our base64).
    const params: Record<string, unknown> = {
      path,
      content: toBase64(content),
    };
    if (opts?.ifMatch !== undefined) params.if_match = opts.ifMatch;
    if (opts?.ifNoneMatch !== undefined) params.if_none_match = opts.ifNoneMatch;
    if (opts?.force !== undefined) params.force = opts.force;

    const result = await this.rpc("sys_write", params, WriteResultSchema);
    return {
      bytesWritten: result.bytes_written,
      etag: result.etag ?? "",
      version: result.version,
    };
  }

  /** Decode a sys_read response into raw stored bytes (before our base64 layer). */
  private decodeReadResult(
    result: { __type__: "bytes"; data: string } | { content: string; encoding: string },
  ): Uint8Array {
    if ("__type__" in result && result.__type__ === "bytes") {
      return fromBase64(result.data);
    }
    if ("encoding" in result && result.encoding === "base64") {
      return fromBase64(result.content);
    }
    return new TextEncoder().encode("content" in result ? result.content : "");
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.rpc("exists", { path }, ExistsResultSchema);
    return result.exists;
  }

  async stat(path: string): Promise<FileMeta | undefined> {
    try {
      const result = await this.rpc("sys_stat", { path }, StatResultSchema);
      const m = result.metadata;
      if (!m) return { size: 0, etag: "" };
      return {
        size: m.size ?? 0,
        etag: m.etag ?? "",
        contentType: m.content_type ?? m.mime_type ?? undefined,
        createdAt: m.created_at ?? undefined,
        modifiedAt: m.modified_at ?? undefined,
      };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async delete(path: string): Promise<boolean> {
    try {
      await this.rpc("delete", { path }, DeleteResultSchema);
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

    const result = await this.rpc("list", params, ListResultSchema);

    return {
      files: result.files.map((f): ListEntry => {
        if (typeof f === "string") {
          // Flat string path — extract name and infer isDirectory from trailing /
          const isDir = f.endsWith("/");
          const cleanPath = isDir ? f.slice(0, -1) : f;
          const name = cleanPath.split("/").pop() ?? cleanPath;
          return { name, path: cleanPath, isDirectory: isDir };
        }
        // Object entry (details=true)
        return {
          name: f.name ?? f.path.split("/").pop() ?? f.path,
          path: f.path,
          size: f.size,
          etag: f.etag,
          isDirectory: f.is_directory,
        };
      }),
      hasMore: result.has_more,
      nextCursor: result.next_cursor ?? undefined,
    };
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    const params: Record<string, unknown> = { path };
    if (opts?.parents !== undefined) params.parents = opts.parents;
    await this.rpc("mkdir", params, MkdirResultSchema);
  }

  async search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]> {
    const params: Record<string, unknown> = { query };
    if (opts?.path !== undefined) params.path = opts.path;
    if (opts?.limit !== undefined) params.limit = opts.limit;

    const result = await this.rpc("search", params, SearchResultSchema);

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
