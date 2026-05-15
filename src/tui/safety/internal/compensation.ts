/**
 * mintTokenForCompensation — internal escape hatch for in-process rollback
 * paths that already hold a fresh `resourceVersion` and have no operator
 * to confirm with (C6 #304, T9 review feedback).
 *
 * Use ONLY when:
 *   - The caller produced or just-read the entity in-process and has a
 *     fresh `resourceVersion` in hand.
 *   - No operator confirmation is appropriate (e.g., automatic rollback
 *     after a partial write).
 *
 * The token still threads through the @Dangerous server gate — the 428
 * middleware still enforces If-Match — so CAS protections remain in force.
 * This helper is NOT a CAS bypass; it's a UI bypass.
 *
 * Not exported through `safety/index.ts`; importers must reach into
 * `safety/internal/compensation.js` directly. The conspicuous import
 * path is the social signal that this is a special-case escape from the
 * normal `useConfirmAndMutate` flow.
 *
 * Current consumer: `nexus-provider.ts:392` — archive an orphan local
 * session after Nexus VFS mirror fails. T11 will wire it.
 *
 * See C6 (#304) T10 review for the design rationale.
 */

export { mintDangerousToken as mintTokenForCompensation } from "./token.js";
