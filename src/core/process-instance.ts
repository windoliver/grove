/**
 * Stable per-process instance identifier.
 *
 * Used by ACP publisher/bridge wiring to distinguish self-loop SSE events
 * (same instance) from legitimate cross-process same-role events (different
 * instance). Without this, a bridge receiving an envelope without a
 * `sourceInstance` marker cannot distinguish "local publisher too old to
 * stamp markers" from "remote sender in another process that happens to
 * share the role name" — and must pick a side (dup vs. drop).
 *
 * Defaulting both the publisher's `sourceInstance` and the bridge's
 * `localInstanceId` to this utility closes the blind spot: within this
 * codebase both sides always carry markers, so strict equality is
 * sufficient.
 */

let cached: string | undefined;

export function getProcessInstanceId(): string {
  if (cached === undefined) {
    // pid + startup time survives fork but is unique per concurrent
    // process; no cryptographic strength needed — this is a dedupe
    // identity, not a security boundary.
    cached = `${process.pid}-${Date.now()}`;
  }
  return cached;
}

/** Test-only: reset the memoized id so each test can assert a fresh value. */
export function __resetProcessInstanceIdForTests(): void {
  cached = undefined;
}
