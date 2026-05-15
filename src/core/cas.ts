/**
 * Content-Addressable Storage (CAS) protocol.
 *
 * Artifacts are stored by BLAKE3 content hash.
 * Implementations handle deduplication automatically.
 *
 * This file ALSO houses the compare-and-set (CAS) mutation result type used
 * by stores/routes for `If-Match` precondition handling (C6, #304). The two
 * concepts share the "CAS" acronym in different domains: "Content-Addressable
 * Storage" for blobs and "Compare-And-Set" for optimistic concurrency.
 */

import type { Artifact } from "./models.js";

// ---------------------------------------------------------------------------
// Compare-And-Set mutation result (C6, #304)
// ---------------------------------------------------------------------------

/**
 * Successful CAS mutation: the write committed and the caller-visible
 * post-write view of the entity is returned.
 */
export interface CasOkResult<View> {
  readonly kind: "ok";
  readonly view: View;
}

/**
 * CAS precondition failure: the supplied `ifMatch` resource version did not
 * match the store's current value. The current `resourceVersion` and
 * `generation` are returned so the caller can decide whether to retry with
 * the new snapshot or surface a 409 to the user.
 */
export interface CasMismatchResult {
  readonly kind: "rv-mismatch";
  readonly current: {
    readonly resourceVersion: string;
    readonly generation: number;
  };
}

/**
 * Discriminated union returned by every CAS-aware store mutation method.
 *
 * Callers branch on `.kind`: `"ok"` carries the post-write view, while
 * `"rv-mismatch"` carries the store's current resource version so retry
 * logic can read-merge-retry without an extra round-trip.
 */
export type CasMutationResult<View> = CasOkResult<View> | CasMismatchResult;

/** Narrowing helper: was the mutation accepted? */
export function isOk<V>(r: CasMutationResult<V>): r is CasOkResult<V> {
  return r.kind === "ok";
}

/** Narrowing helper: did the precondition fail? */
export function isMismatch<V>(r: CasMutationResult<V>): r is CasMismatchResult {
  return r.kind === "rv-mismatch";
}

/**
 * Shared options shape for CAS mutation methods. Stores accept this on
 * `putXxxSpec` / `patchXxxStatus` / `deleteXxx`. When `ifMatch` is set, the
 * store compares it to the persisted `resource_version` and returns
 * `{ kind: "rv-mismatch", current }` on disagreement; when unset, the
 * mutation proceeds without the check (back-compat path).
 */
export interface CasOpts {
  readonly ifMatch?: string;
}

/**
 * Test helper: assert a CAS mutation succeeded and return the view.
 *
 * Throws if the result is `rv-mismatch`. Use only in tests where the
 * mismatch branch is unreachable (no `ifMatch` supplied, or `ifMatch`
 * provably fresh). Production code MUST handle both variants explicitly.
 */
export function expectOk<V>(result: CasMutationResult<V>): V {
  if (result.kind !== "ok") {
    throw new Error(
      `expected CasMutationResult.kind === "ok", got "${result.kind}"` +
        (result.kind === "rv-mismatch" ? ` (current RV=${result.current.resourceVersion})` : ""),
    );
  }
  return result.view;
}

/**
 * Production helper: unwrap a CasMutationResult inside a caller that does
 * not (yet) supply `ifMatch`. Throws with a caller-specific context string
 * if the result is `rv-mismatch`.
 *
 * Routes (T6) read `If-Match` via `getIfMatch(c)`, and controllers (T7)
 * use `withIfMatch()` for retry loops. This helper remains for the
 * remaining one-shot / user-facing callers (CLI commands, MCP tools,
 * TUI providers, SessionManager) where a fail-fast on RV mismatch is
 * acceptable until the `confirmAndMutate` UI surface lands (T10/T11).
 *
 * @param result the discriminated result from a store CAS method
 * @param context a human description of the caller, e.g.
 *                `"cli grove session delete (abc-123)"` or
 *                `"SessionManager.archiveSession(abc-123)"`
 */
export function expectCasOk<V>(result: CasMutationResult<V>, context: string): V {
  if (result.kind === "rv-mismatch") {
    throw new Error(
      `Unexpected RV mismatch on ${context}; caller does not yet supply If-Match (C6 T6 will wire this)`,
    );
  }
  return result.view;
}

/**
 * Construct a `CasOk` result. Reduces boilerplate in store mocks that
 * always return `{ kind: "ok", view }` because they don't model CAS
 * conflicts. Not for use in production stores — those must compute and
 * branch on `ifMatch`.
 */
export function casOk<V>(view: V): CasMutationResult<V> {
  return { kind: "ok", view };
}

/**
 * Composite Entity-level resource version: the sum of spec RV and status
 * RV, minus 1, so that the initial (spec=1, status=1) state surfaces as
 * RV=1 to entity consumers. Each subsequent spec or status mutation
 * advances the composite by 1, monotonically.
 *
 * Used by entity adapters (claim, agent-task, etc.) to project a single
 * `Entity.resourceVersion` from the two persisted columns.
 *
 * Both arguments accept `number | undefined`; undefined falls back to 1
 * (the SCHEMA_DDL DEFAULT for `resource_version` columns).
 */
export function rvComposite(specRv: number | undefined, statusRv: number | undefined): number {
  return (specRv ?? 1) + (statusRv ?? 1) - 1;
}

/**
 * Compute a `rv-mismatch` result if `ifMatch` is supplied and doesn't match
 * the persisted `existingRv`. Returns `null` if there's no mismatch (either
 * `ifMatch` is undefined, or it matches), letting callers continue to the
 * write path. Centralizes the CAS-check construction so every CAS-aware
 * store method uses identical mismatch payload shape.
 *
 * For entities with a single RV column (sessions, goals), pass the same
 * value for both args. For spec/status-split entities (claims, agent-tasks),
 * pass the relevant row's RV plus an explicit `generation`.
 *
 * @param existingRv the persisted resource_version value (number)
 * @param ifMatch the caller-supplied ifMatch token (string | undefined)
 * @param generation optional generation field for the mismatch payload;
 *                   defaults to `existingRv ?? 1`
 */
export function checkIfMatch(
  existingRv: number | undefined,
  ifMatch: string | undefined,
  generation?: number,
): CasMismatchResult | null {
  if (ifMatch === undefined) return null;
  const currentRv = String(existingRv ?? 1);
  if (currentRv === ifMatch) return null;
  return {
    kind: "rv-mismatch",
    current: {
      resourceVersion: currentRv,
      generation: generation ?? existingRv ?? 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Content-Addressable Storage (CAS) protocol
// ---------------------------------------------------------------------------

/** Options for storing artifacts. */
export interface PutOptions {
  /**
   * Advisory media type for the blob (e.g., "application/json").
   * Persisted alongside the content for retrieval via `stat()`.
   * Must be a bare IANA media type without parameters (no "; charset=..." etc.).
   */
  readonly mediaType?: string | undefined;
}

/**
 * Pattern for valid media types — matches artifact.json schema.
 * Bare type/subtype only; parameters (e.g., "; charset=utf-8") are rejected.
 */
const MEDIA_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

/**
 * Validate a media type string against the artifact schema pattern.
 * Throws if the value is not a valid bare IANA media type.
 */
export function validateMediaType(mediaType: string): void {
  if (mediaType.length > 256) {
    throw new Error(`mediaType exceeds 256 characters: '${mediaType.slice(0, 40)}...'`);
  }
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new Error(
      `Invalid mediaType '${mediaType}': must be a bare type/subtype without parameters`,
    );
  }
}

/**
 * Abstract content store — storage backends implement this.
 *
 * All content hashes use the format `blake3:<64-char-lowercase-hex>`
 * (71 characters total). This applies to both return values and parameters.
 *
 * The recommended local filesystem layout is:
 *   {root}/{hash[0:2]}/{hash[2:4]}/{hash}
 * where {hash} is the 64-char hex portion (without the `blake3:` prefix).
 * This layout is an implementation recommendation, not a protocol requirement.
 */
export interface ContentStore {
  /**
   * Store bytes and return the content hash.
   * @returns Content hash in `blake3:<hex64>` format.
   */
  put(data: Uint8Array, options?: PutOptions): Promise<string>;

  /** Retrieve bytes by content hash. Returns undefined if not found. */
  get(contentHash: string): Promise<Uint8Array | undefined>;

  /** Check if content exists. */
  exists(contentHash: string): Promise<boolean>;

  /** Check existence of multiple content hashes. Returns a map of hash → boolean. */
  existsMany(contentHashes: readonly string[]): Promise<ReadonlyMap<string, boolean>>;

  /** Delete content by hash. Returns true if deleted. */
  delete(contentHash: string): Promise<boolean>;

  /**
   * Store a file and return the content hash.
   * Preferred over `put()` for large artifacts — implementations SHOULD
   * use streaming I/O and incremental BLAKE3 hashing.
   * @returns Content hash in `blake3:<hex64>` format.
   */
  putFile(path: string, options?: PutOptions): Promise<string>;

  /** Retrieve content to a file. Returns true if found and written. */
  getToFile(contentHash: string, path: string): Promise<boolean>;

  /**
   * Get artifact metadata without downloading the blob bytes.
   * Returns content hash, size, and optional media type.
   */
  stat(contentHash: string): Promise<Artifact | undefined>;

  /** Release resources (e.g., clean up temp files). */
  close(): void;
}
