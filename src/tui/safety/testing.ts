/**
 * Test-only re-export of the DangerousToken factory. Production code
 * MUST import from `./index.js` (which only exports the type).
 * Test files import `__test_only_mintToken` from this module to
 * construct tokens for unit tests of dangerous client methods.
 *
 * The `__test_only_` prefix is intentional — it signals to code review
 * that any production callsite of this symbol is wrong.
 */
export { mintDangerousToken as __test_only_mintToken } from "./internal/token.js";
