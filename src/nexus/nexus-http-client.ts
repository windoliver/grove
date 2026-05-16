/**
 * Production NexusClient using the Nexus REST file API.
 *
 * Connects to a real nexi-lab/nexus instance at the given URL. All VFS
 * operations dispatch as REST calls under `/api/v2/files/*`. Latest
 * Nexus images dropped the `sys_*` JSON-RPC methods that the original
 * client used; the REST file router is the durable surface that
 * survives image rolls.
 *
 * Binary safety: content is base64-encoded into a UTF-8 text wrapper
 * before write, so the server's lossy UTF-8 read decode round-trips
 * arbitrary binary (including non-UTF-8 bytes like 0xFF). Write uses
 * `encoding: "utf8"` (default) so the server stores the base64 chars
 * verbatim; read returns those base64 chars as `content`, and the
 * client decodes once to recover the original bytes.
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
  WriteBatchEntry,
  WriteOptions,
  WriteResult,
} from "./client.js";
import {
  NexusAuthError,
  NexusConflictError,
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

function utf8ToBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------------------------------------------------------------------------
// REST response schemas
// ---------------------------------------------------------------------------

const WriteResponseSchema = z
  .object({
    content_id: z.string().nullable().optional(),
    version: z.number().nullable().optional(),
    size: z.number().nullable().optional(),
    modified_at: z.string().nullable().optional(),
  })
  .passthrough();

const BatchWriteResponseSchema = z.object({
  results: z.array(
    z
      .object({
        path: z.string(),
        content_id: z.string().nullable().optional(),
        version: z.number().nullable().optional(),
        size: z.number().nullable().optional(),
        modified_at: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
});

const ReadResponseSchema = z
  .object({
    content: z.string(),
    content_id: z.string().nullable().optional(),
    version: z.number().nullable().optional(),
    size: z.number().nullable().optional(),
    modified_at: z.string().nullable().optional(),
  })
  .passthrough();

const ExistsResponseSchema = z.object({ exists: z.boolean() });

const MetadataResponseSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    content_id: z.string().nullable().optional(),
    version: z.number(),
    is_directory: z.boolean(),
    created_at: z.string().nullable().optional(),
    modified_at: z.string().nullable().optional(),
    mime_type: z.string().nullable().optional(),
    content_type: z.string().nullable().optional(),
  })
  .passthrough();

const DeleteResponseSchema = z.object({ deleted: z.boolean(), path: z.string() });

// Both serialized aliases (camelCase) and the underlying snake_case fields
// can appear depending on the FastAPI response_model_by_alias toggle. Accept
// either to insulate the client from server-side serialization changes.
const FileItemSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    size: z.number().optional(),
    isDirectory: z.boolean().optional(),
    is_directory: z.boolean().optional(),
    contentId: z.string().nullable().optional(),
    content_id: z.string().nullable().optional(),
    modifiedAt: z.string().nullable().optional(),
    modified_at: z.string().nullable().optional(),
  })
  .passthrough();

const ListResponseSchema = z.object({
  items: z.array(FileItemSchema),
  has_more: z.boolean().optional(),
  hasMore: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
  nextCursor: z.string().nullable().optional(),
});

const GrepMatchSchema = z.object({
  file: z.string(),
  line: z.number(),
  content: z.string(),
  match: z.string(),
});

const GrepResponseSchema = z.object({
  matches: z.array(GrepMatchSchema),
  total: z.number(),
  truncated: z.boolean().optional(),
  pattern: z.string().optional(),
  base_path: z.string().optional(),
});

// ---------------------------------------------------------------------------
// NexusHttpClient
// ---------------------------------------------------------------------------

type RestMethod = "GET" | "POST" | "DELETE";

/** REST HTTP client for nexi-lab/nexus v2 file API. */
export class NexusHttpClient implements NexusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(config: NexusHttpConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // -----------------------------------------------------------------------
  // REST transport
  // -----------------------------------------------------------------------

  private async request<T>(
    method: RestMethod,
    path: string,
    schema: z.ZodType<T>,
    opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<T> {
    if (this.closed) throw new NexusConnectionError("Client is closed");

    const url = new URL(`${this.baseUrl}${path}`);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          ...(opts?.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
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
    if (response.status === 404) {
      throw new NexusNotFoundError(path);
    }
    if (response.status === 412 || response.status === 409) {
      // Optimistic-concurrency mismatch (if_match / if_none_match). Surface
      // as a structured conflict so store-level repair paths can run.
      const detail = await response.text().catch(() => "");
      const actualEtag = response.headers.get("etag") ?? undefined;
      throw new NexusConflictError({
        message: `Precondition failed: ${detail || response.status}`,
        ...(actualEtag !== undefined ? { actualEtag } : {}),
      });
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
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new NexusConnectionError(`Nexus HTTP ${response.status}: ${detail}`);
    }

    const json = (await response.json()) as unknown;
    return schema.parse(json);
  }

  // -----------------------------------------------------------------------
  // NexusClient implementation
  // -----------------------------------------------------------------------

  async read(path: string): Promise<Uint8Array | undefined> {
    try {
      const result = await this.request("GET", "/api/v2/files/read", ReadResponseSchema, {
        query: { path },
      });
      // Server returns the stored UTF-8 text directly. We base64-encoded
      // on write for binary safety, so decode once to recover original bytes.
      return fromBase64(result.content);
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async readWithMeta(path: string): Promise<ReadResult | undefined> {
    try {
      // Combined read + metadata. The REST /read endpoint returns
      // content_id (the etag) inline, so a single round-trip suffices —
      // no need for the stat-then-read CAS dance the JSON-RPC client used.
      const result = await this.request("GET", "/api/v2/files/read", ReadResponseSchema, {
        query: { path, include_metadata: true },
      });
      return {
        content: fromBase64(result.content),
        etag: result.content_id ?? "",
      };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async write(path: string, content: Uint8Array, opts?: WriteOptions): Promise<WriteResult> {
    // We base64-encode arbitrary bytes into a UTF-8 text wrapper so binary
    // (e.g. CAS blobs) round-trips through the server's lossy UTF-8 read
    // decode. Server stores the base64 chars verbatim; read decodes once
    // to recover the original bytes.
    const body: Record<string, unknown> = {
      path,
      content: toBase64(content),
      encoding: "utf8",
    };
    if (opts?.ifMatch !== undefined) body.if_match = opts.ifMatch;
    if (opts?.ifNoneMatch !== undefined) {
      // Grove's storage port uses the HTTP If-None-Match "*" sentinel for
      // create-only writes. Nexus REST v0.10 models the same condition as a
      // boolean field instead of the raw header value.
      body.if_none_match = opts.ifNoneMatch === "*";
    }

    const result = await this.request("POST", "/api/v2/files/write", WriteResponseSchema, {
      body,
    });
    return {
      bytesWritten: result.size ?? content.byteLength,
      etag: result.content_id ?? "",
      version: result.version ?? undefined,
    };
  }

  async writeBatch(files: readonly WriteBatchEntry[]): Promise<readonly WriteResult[]> {
    const result = await this.request(
      "POST",
      "/api/v2/files/batch/write",
      BatchWriteResponseSchema,
      {
        body: {
          files: files.map((file) => ({
            path: file.path,
            content_base64: utf8ToBase64(toBase64(file.content)),
          })),
        },
      },
    );

    return result.results.map((item, index) => ({
      bytesWritten: item.size ?? files[index]?.content.byteLength ?? 0,
      etag: item.content_id ?? "",
      version: item.version ?? undefined,
    }));
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.request("GET", "/api/v2/files/exists", ExistsResponseSchema, {
      query: { path },
    });
    return result.exists;
  }

  async stat(path: string): Promise<FileMeta | undefined> {
    try {
      const result = await this.request("GET", "/api/v2/files/metadata", MetadataResponseSchema, {
        query: { path },
      });
      return {
        size: result.size,
        etag: result.content_id ?? "",
        contentType: result.content_type ?? result.mime_type ?? undefined,
        createdAt: result.created_at ?? undefined,
        modifiedAt: result.modified_at ?? undefined,
      };
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  async delete(path: string): Promise<boolean> {
    try {
      const result = await this.request("DELETE", "/api/v2/files/delete", DeleteResponseSchema, {
        query: { path },
      });
      return result.deleted;
    } catch (err) {
      if (err instanceof NexusNotFoundError) return false;
      throw err;
    }
  }

  async list(path: string, opts?: ListOptions): Promise<ListResult> {
    const result = await this.request("GET", "/api/v2/files/list", ListResponseSchema, {
      query: {
        path,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}),
        ...(opts?.recursive !== undefined ? { recursive: opts.recursive } : {}),
      },
    });
    return {
      files: result.items.map(
        (f): ListEntry => ({
          name: f.name,
          path: f.path,
          size: f.size,
          isDirectory: f.isDirectory ?? f.is_directory,
          etag: f.contentId ?? f.content_id ?? undefined,
        }),
      ),
      hasMore: result.has_more ?? result.hasMore ?? false,
      nextCursor: result.next_cursor ?? result.nextCursor ?? undefined,
    };
  }

  async mkdir(path: string, opts?: MkdirOptions): Promise<void> {
    await this.request("POST", "/api/v2/files/mkdir", z.unknown(), {
      body: {
        path,
        ...(opts?.parents !== undefined ? { parents: opts.parents } : {}),
      },
    });
  }

  async search(query: string, opts?: SearchOptions): Promise<readonly SearchResult[]> {
    // The legacy `search` JSON-RPC method was full-text/semantic. The REST
    // file API exposes regex grep, which is a strict subset. Treat the
    // user query as a literal pattern (escaped) so word-style searches
    // still work; semantic ranking is no longer available, so we report
    // a constant score.
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await this.request("GET", "/api/v2/files/grep", GrepResponseSchema, {
      query: {
        pattern: literal,
        path: opts?.path ?? "/",
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      },
    });
    return result.matches.map(
      (m): SearchResult => ({
        path: m.file,
        snippet: m.content,
        score: 1,
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
