/**
 * Public surface for C6's confirmAndMutate primitive (#304).
 *
 * Exports:
 *   - DangerousToken (type only)
 *   - ConfirmAndMutateProvider (React provider)
 *   - useConfirmAndMutate (hook)
 *   - ConfirmAndMutateRequest, ConfirmAndMutateResult (types)
 *   - ConfirmAndMutateEntityBus (type — for T11's production adapter)
 *
 * The token factory (`mintDangerousToken`) is intentionally NOT exported
 * — it lives in `./internal/token.js` and is imported only by
 * `confirm-and-mutate.tsx` and `./testing.js` (tests).
 *
 * `mintTokenForCompensation` is also intentionally NOT exported. Internal
 * rollback paths import it directly from `./internal/compensation.js` —
 * the deep import path is the social signal that the call is a special
 * case (see T9 review).
 */
export type {
  ConfirmAndMutateEntityBus,
  ConfirmAndMutateProviderProps,
  ConfirmAndMutateRequest,
  ConfirmAndMutateResult,
} from "./confirm-and-mutate.js";
export {
  ConfirmAndMutateProvider,
  useConfirmAndMutate,
} from "./confirm-and-mutate.js";
export type { DangerousToken } from "./internal/token.js";
export { makeEntityBusFromStore } from "./store-adapter.js";
