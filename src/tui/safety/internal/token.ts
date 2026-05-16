/**
 * DangerousToken — opaque type brand that proves the caller obtained
 * `ifMatch` from `confirmAndMutate` (C6, #304).
 *
 * Dangerous client methods (the ones backing mutating routes) accept
 * `DangerousToken<K>` as their first parameter. Token construction is
 * gated to the `confirm-and-mutate` module via a private factory that
 * lives in `internal/token.ts` and is NOT exported through `safety/index.ts`.
 *
 * Compile-time enforcement: callers outside the safety package cannot
 * construct a token via object literal (the `__dangerousToken` field
 * has a `unique symbol` type that is unforgeable), so they cannot call
 * the dangerous client methods. The server's `dangerous()` middleware
 * provides defense-in-depth at runtime (rejects requests missing
 * `If-Match` with 428).
 *
 * A deliberate `as unknown as DangerousToken<K>` cast can still bypass
 * at the source level, but that double-cast pattern is conspicuous in
 * code review.
 *
 * Tests can mint tokens via `src/tui/safety/testing.ts` which re-exports
 * the factory under `__test_only_mintToken`.
 */

declare const __dangerousToken: unique symbol;

export type DangerousToken<K extends string> = {
  readonly [__dangerousToken]: never;
  readonly kind: K;
  readonly id: string;
  readonly ifMatch: string;
};

export function mintDangerousToken<K extends string>(
  kind: K,
  id: string,
  ifMatch: string,
): DangerousToken<K> {
  return { kind, id, ifMatch } as unknown as DangerousToken<K>;
}
