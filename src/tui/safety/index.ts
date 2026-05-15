/**
 * Public surface for C6's confirmAndMutate primitive (#304).
 *
 * Currently exports the DangerousToken type only. T10 will add:
 * - ConfirmAndMutateProvider (React provider)
 * - useConfirmAndMutate (hook)
 * - ConfirmAndMutateRequest, ConfirmAndMutateResult (types)
 *
 * The token factory (`mintDangerousToken`) is intentionally NOT
 * exported — it lives in `./internal/token.js` and is imported only
 * by `confirm-and-mutate.tsx` (T10) and `./testing.js` (tests).
 */
export type { DangerousToken } from "./internal/token.js";
