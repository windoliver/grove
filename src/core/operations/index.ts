/**
 * Core operations barrel re-exports.
 *
 * All operations, result types, and dependency interfaces are available
 * through this single entry point.
 */

export type { AgentOverrides } from "./agent.js";
export { resolveAgent } from "./agent.js";
// Bounty operations
export type {
  BountySummary,
  ClaimBountyInput,
  ClaimBountyResult,
  CreateBountyInput,
  CreateBountyResult,
  ListBountiesInput,
  ListBountiesResult,
  SettleBountyInput,
  SettleBountyResult,
} from "./bounty.js";
export {
  claimBountyOperation,
  createBountyOperation,
  listBountiesOperation,
  settleBountyOperation,
} from "./bounty.js";
// Checkout operation
export type { CheckoutInput, CheckoutResult } from "./checkout.js";
export { checkoutOperation } from "./checkout.js";
// Claim operations
export type {
  ClaimInput,
  ClaimResult,
  ClaimSummary,
  ListClaimsInput,
  ListClaimsResult,
  ReleaseInput,
  ReleaseResult,
} from "./claim.js";
export { claimOperation, listClaimsOperation, releaseOperation } from "./claim.js";
// Contribute operations
export type {
  ContributeInput,
  ContributeResult,
  DiscussInput,
  DiscussResult,
  ReproduceInput,
  ReproduceResult,
  ReviewInput,
  ReviewResult,
} from "./contribute.js";
export {
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "./contribute.js";
// Foundation
export type { OperationDeps } from "./deps.js";
// Lifecycle operation
export type { CheckStopResult, StopConditionStatus } from "./lifecycle.js";
export { checkStopOperation } from "./lifecycle.js";
// Outcome operations
export type {
  GetOutcomeInput,
  ListOutcomesInput,
  SetOutcomeInput,
} from "./outcome.js";
export {
  getOutcomeOperation,
  listOutcomesOperation,
  outcomeStatsOperation,
  setOutcomeOperation,
} from "./outcome.js";
// Query operations
export type {
  ContributionSummary,
  FrontierEntrySummary,
  FrontierInput,
  FrontierResult,
  LogInput,
  LogResult,
  SearchInput,
  SearchResult,
  ThreadActivitySummary,
  ThreadInput,
  ThreadNodeSummary,
  ThreadResult,
  ThreadsInput,
  ThreadsResult,
  TreeInput,
  TreeResult,
} from "./query.js";
export {
  frontierOperation,
  logOperation,
  searchOperation,
  threadOperation,
  threadsOperation,
  treeOperation,
} from "./query.js";
export type {
  OperationErr,
  OperationError,
  OperationErrorCode,
  OperationOk,
  OperationResult,
} from "./result.js";
export {
  err,
  fromGroveError,
  notFound,
  OperationErrorCode as ErrorCode,
  ok,
  validationErr,
} from "./result.js";
