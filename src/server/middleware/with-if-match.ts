import type { CasMutationResult } from "../../core/cas.js";

/**
 * Controller-side helper for CAS-aware store mutations: reads current RV,
 * patches with `ifMatch` set, and retries on `rv-mismatch` by re-reading.
 *
 * Use this in reconciler / bridge / any non-HTTP controller code that
 * programmatically mutates a CAS-aware store and cannot rely on the
 * {@link dangerous} middleware to thread `If-Match` from a request header.
 *
 * Counterpart to the server-side {@link dangerous} middleware (C6, #304):
 * routes get `ifMatch` from the request, but controllers (reconciler,
 * bridge, status loops) operate without an HTTP request, so they need a
 * get-modify-write retry loop that handles concurrent advancement.
 *
 * Throws `Error("withIfMatch: exhausted N retries; last current RV=X")`
 * if all retries fail. Callers that need to surface the conflict (vs.
 * crash) should catch and decide; most controller loops want the throw
 * because a persistent conflict at this layer indicates an unhealthy
 * state-machine that needs operator attention.
 *
 * @param read  reads the current entity and returns `{ resourceVersion }`.
 *              The string MUST match the value the store will compare
 *              against (e.g. status `resource_version` for status-row
 *              patches; whole-entity `resource_version` for sessions/goals).
 * @param patch performs the mutation; receives `{ ifMatch }` to set on
 *              the store call.
 * @param opts.maxRetries number of retries AFTER the initial attempt
 *                        (default 3; total attempts = maxRetries + 1).
 */
export async function withIfMatch<View>(
  read: () => Promise<{ readonly resourceVersion: string }>,
  patch: (opts: { readonly ifMatch: string }) => Promise<CasMutationResult<View>>,
  opts?: { readonly maxRetries?: number },
): Promise<View> {
  const max = opts?.maxRetries ?? 3;
  let lastMismatch: { readonly resourceVersion: string; readonly generation: number } | undefined;
  for (let i = 0; i <= max; i++) {
    const cur = await read();
    const result = await patch({ ifMatch: cur.resourceVersion });
    if (result.kind === "ok") return result.view;
    lastMismatch = result.current;
  }
  throw new Error(
    `withIfMatch: exhausted ${max} retries; last current RV=${lastMismatch?.resourceVersion ?? "?"}`,
  );
}
