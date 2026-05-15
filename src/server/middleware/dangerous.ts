import type { Context, Handler } from "hono";

/**
 * Inner handler accepted by {@link dangerous}. Mirrors a normal Hono route
 * handler but takes only the {@link Context} (no `next`) because the wrapped
 * route is always a terminal mutating handler — there is no next middleware
 * to call from inside it.
 */
export type DangerousHandler = (c: Context) => Promise<Response> | Response;

/**
 * Server-side `@Dangerous` enforcement: wraps a Hono handler so the route
 * rejects with `428 Precondition Required` when the request does not
 * carry a non-empty `If-Match` header.
 *
 * Used on every CAS-aware mutating route (DELETE, PUT, PATCH against
 * volatile state). Pairs with the TUI `confirmAndMutate` helper, which
 * always sets the header — and with the `DangerousToken` type brand,
 * which prevents the TUI client from constructing a mutation call
 * without going through the helper.
 *
 * Defense-in-depth: even if a TUI bypasses the brand or a non-TUI
 * caller hand-crafts a request, this middleware returns 428 before any
 * store logic runs. The `ifMatch` value is stashed in the Hono context
 * via `c.set("ifMatch", value)` so the inner handler can read it
 * without re-reading the header.
 *
 * Empty-string `If-Match` is treated as missing (rejected with 428).
 * The HTTP spec permits an empty If-Match with semantics roughly
 * "no entity tag", which is exactly what we are guarding against.
 *
 * Reference: RFC 7232 §3.1, k8s `metav1.UpdateOptions`.
 */
export function dangerous(handler: DangerousHandler): Handler {
  return async (c) => {
    const ifMatch = c.req.header("If-Match");
    if (ifMatch === undefined || ifMatch === "") {
      return c.json(
        {
          error: {
            code: "PRECONDITION_REQUIRED",
            message: "If-Match header required for @Dangerous endpoint",
          },
        },
        428,
      );
    }
    c.set("ifMatch", ifMatch);
    return handler(c);
  };
}
