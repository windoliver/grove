/**
 * Shared route utilities.
 *
 * Canonical definitions for schemas and guards that are duplicated across
 * multiple route files. Importing from here keeps the route modules DRY.
 */

import type { Context } from "hono";
import { z } from "zod";
import type { ContributionStore } from "../../core/store.js";
import type { ServerDeps } from "../deps.js";
import { CID_REGEX } from "../schemas.js";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Zod schema for a `:cid` path parameter (blake3:<64-hex>). */
export const cidParamSchema: z.ZodObject<{ cid: z.ZodString }> = z.object({
  cid: z.string().regex(CID_REGEX, "CID must be in format blake3:<64-hex-chars>"),
});

// ---------------------------------------------------------------------------
// Feature guards
// ---------------------------------------------------------------------------

/**
 * Return a 501 "not configured" JSON response when an optional dependency is
 * missing. Route handlers should use this as an early return:
 *
 * ```ts
 * const { bountyStore } = c.get("deps");
 * if (!bountyStore) return notConfigured(c, "Bounty store is not configured");
 * ```
 */
export function notConfigured(c: Context, message: string): Response {
  return c.json({ error: { code: "NOT_CONFIGURED", message } }, 501);
}

/** Resolve the contribution store for an optional session-scoped request. */
export function contributionStoreForSession(
  deps: ServerDeps,
  sessionId: string | undefined,
): ContributionStore {
  if (sessionId !== undefined && deps.contributionStoreForSession !== undefined) {
    return deps.contributionStoreForSession(sessionId);
  }
  return deps.contributionStore;
}

export type JsonBodyResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly response: Response };

/** Parse a JSON request body, returning a consistent 400 on malformed input. */
export async function readJsonBody(c: Context): Promise<JsonBodyResult> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }, 400),
    };
  }
}
