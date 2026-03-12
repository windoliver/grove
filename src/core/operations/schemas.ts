/**
 * Shared Zod schemas for operation result types.
 *
 * These schemas define the canonical JSON response shape for each operation.
 * All surfaces (CLI, MCP, HTTP) must return data conforming to these schemas,
 * ensuring cross-surface response parity.
 *
 * Phase 5.2/5.3 — shared JSON response schemas.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Error codes shared across all surfaces. */
export const OperationErrorCodeSchema: z.ZodType = z.enum([
  "CLAIM_CONFLICT",
  "CONCURRENCY_LIMIT",
  "RATE_LIMIT",
  "ARTIFACT_LIMIT",
  "RETRY_EXHAUSTED",
  "LEASE_VIOLATION",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INTERNAL_ERROR",
]);

/** Structured error from an operation. */
export const OperationErrorSchema: z.ZodType = z.object({
  code: OperationErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Successful operation result wrapper. */
export const OperationOkSchema = <T extends z.ZodType>(valueSchema: T): z.ZodType =>
  z.object({
    ok: z.literal(true),
    value: valueSchema,
  });

/** Failed operation result wrapper. */
export const OperationErrSchema: z.ZodType = z.object({
  ok: z.literal(false),
  error: OperationErrorSchema,
});

/** Discriminated union: every operation returns one of these. */
export const OperationResultSchema = <T extends z.ZodType>(valueSchema: T): z.ZodType =>
  z.union([OperationOkSchema(valueSchema), OperationErrSchema]);

// ---------------------------------------------------------------------------
// Score schema (reused by ContributionSummary)
// ---------------------------------------------------------------------------

export const ScoreSchema: z.ZodType = z.object({
  value: z.number(),
  direction: z.string(),
});

// ---------------------------------------------------------------------------
// Contribute results
// ---------------------------------------------------------------------------

/** Schema for ContributeResult. */
export const ContributeResultSchema: z.ZodType = z.object({
  cid: z.string(),
  kind: z.string(),
  mode: z.string(),
  summary: z.string(),
  artifactCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

/** Schema for ReviewResult. */
export const ReviewResultSchema: z.ZodType = z.object({
  cid: z.string(),
  kind: z.literal("review"),
  targetCid: z.string(),
  summary: z.string(),
  createdAt: z.string(),
});

/** Schema for ReproduceResult. */
export const ReproduceResultSchema: z.ZodType = z.object({
  cid: z.string(),
  kind: z.literal("reproduction"),
  targetCid: z.string(),
  result: z.string(),
  summary: z.string(),
  createdAt: z.string(),
});

/** Schema for DiscussResult. */
export const DiscussResultSchema: z.ZodType = z.object({
  cid: z.string(),
  kind: z.literal("discussion"),
  targetCid: z.string().optional(),
  summary: z.string(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Claim results
// ---------------------------------------------------------------------------

/** Schema for ClaimResult. */
export const ClaimResultSchema: z.ZodType = z.object({
  claimId: z.string(),
  targetRef: z.string(),
  status: z.string(),
  agentId: z.string(),
  intentSummary: z.string(),
  leaseExpiresAt: z.string(),
  renewed: z.boolean(),
});

/** Schema for ReleaseResult. */
export const ReleaseResultSchema: z.ZodType = z.object({
  claimId: z.string(),
  targetRef: z.string(),
  status: z.string(),
  action: z.enum(["release", "complete"]),
});

/** Schema for ClaimSummary (used in list responses). */
export const ClaimSummarySchema: z.ZodType = z.object({
  claimId: z.string(),
  targetRef: z.string(),
  status: z.string(),
  agentId: z.string(),
  intentSummary: z.string(),
  leaseExpiresAt: z.string(),
  createdAt: z.string(),
});

/** Schema for ListClaimsResult. */
export const ListClaimsResultSchema: z.ZodType = z.object({
  claims: z.array(ClaimSummarySchema),
  count: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

/** Schema for ContributionSummary (shared across query responses). */
export const ContributionSummarySchema: z.ZodType = z.object({
  cid: z.string(),
  summary: z.string(),
  kind: z.string(),
  mode: z.string(),
  tags: z.array(z.string()),
  scores: z.record(z.string(), ScoreSchema).optional(),
  agentId: z.string(),
  createdAt: z.string(),
});

/** Schema for FrontierEntrySummary. */
export const FrontierEntrySummarySchema: z.ZodType = z.object({
  cid: z.string(),
  summary: z.string(),
  value: z.number(),
  kind: z.string(),
  mode: z.string(),
  agentId: z.string(),
});

/** Schema for FrontierResult. */
export const FrontierResultSchema: z.ZodType = z.object({
  byMetric: z.record(z.string(), z.array(FrontierEntrySummarySchema)),
  byAdoption: z.array(FrontierEntrySummarySchema),
  byRecency: z.array(FrontierEntrySummarySchema),
  byReviewScore: z.array(FrontierEntrySummarySchema),
  byReproduction: z.array(FrontierEntrySummarySchema),
});

/** Schema for SearchResult. */
export const SearchResultSchema: z.ZodType = z.object({
  results: z.array(ContributionSummarySchema),
  count: z.number().int().nonnegative(),
});

/** Schema for LogResult. */
export const LogResultSchema: z.ZodType = z.object({
  results: z.array(ContributionSummarySchema),
  count: z.number().int().nonnegative(),
});

/** Schema for TreeResult. */
export const TreeResultSchema: z.ZodType = z.object({
  cid: z.string(),
  summary: z.string(),
  kind: z.string(),
  children: z.array(ContributionSummarySchema).optional(),
  ancestors: z.array(ContributionSummarySchema).optional(),
});

/** Schema for ThreadNodeSummary. */
export const ThreadNodeSummarySchema: z.ZodType = z.object({
  cid: z.string(),
  depth: z.number().int().nonnegative(),
  summary: z.string(),
  kind: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
});

/** Schema for ThreadResult. */
export const ThreadResultSchema: z.ZodType = z.object({
  nodes: z.array(ThreadNodeSummarySchema),
  count: z.number().int().nonnegative(),
});

/** Schema for ThreadActivitySummary. */
export const ThreadActivitySummarySchema: z.ZodType = z.object({
  cid: z.string(),
  summary: z.string(),
  kind: z.string(),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: z.string(),
  agentId: z.string(),
});

/** Schema for ThreadsResult. */
export const ThreadsResultSchema: z.ZodType = z.object({
  threads: z.array(ThreadActivitySummarySchema),
  count: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Checkout results
// ---------------------------------------------------------------------------

/** Schema for CheckoutResult. */
export const CheckoutResultSchema: z.ZodType = z.object({
  cid: z.string(),
  workspacePath: z.string(),
  status: z.string(),
  agentId: z.string(),
  artifactCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// Lifecycle results
// ---------------------------------------------------------------------------

/** Schema for StopConditionStatus. */
export const StopConditionStatusSchema: z.ZodType = z.object({
  met: z.boolean(),
  reason: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Schema for CheckStopResult. */
export const CheckStopResultSchema: z.ZodType = z.object({
  stopped: z.boolean(),
  reason: z.string(),
  conditions: z.record(z.string(), StopConditionStatusSchema),
  evaluatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Bounty results
// ---------------------------------------------------------------------------

/** Schema for BountyStatus enum values. */
export const BountyStatusSchema: z.ZodType = z.enum([
  "draft",
  "open",
  "claimed",
  "completed",
  "settled",
  "expired",
  "cancelled",
]);

/** Schema for CreateBountyResult. */
export const CreateBountyResultSchema: z.ZodType = z.object({
  bountyId: z.string(),
  title: z.string(),
  amount: z.number(),
  status: BountyStatusSchema,
  deadline: z.string(),
  reservationId: z.string().optional(),
});

/** Schema for BountySummary. */
export const BountySummarySchema: z.ZodType = z.object({
  bountyId: z.string(),
  title: z.string(),
  amount: z.number(),
  status: BountyStatusSchema,
  deadline: z.string(),
  claimedBy: z.string().optional(),
});

/** Schema for ListBountiesResult. */
export const ListBountiesResultSchema: z.ZodType = z.object({
  bounties: z.array(BountySummarySchema),
  count: z.number().int().nonnegative(),
});

/** Schema for ClaimBountyResult. */
export const ClaimBountyResultSchema: z.ZodType = z.object({
  bountyId: z.string(),
  title: z.string(),
  status: BountyStatusSchema,
  claimId: z.string(),
  claimedBy: z.string().optional(),
});

/** Schema for SettleBountyResult. */
export const SettleBountyResultSchema: z.ZodType = z.object({
  bountyId: z.string(),
  status: BountyStatusSchema,
  fulfilledByCid: z.string().optional(),
  amount: z.number(),
  paidTo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Outcome results
// ---------------------------------------------------------------------------

/** Schema for OutcomeStatus enum values. */
export const OutcomeStatusSchema: z.ZodType = z.enum([
  "accepted",
  "rejected",
  "crashed",
  "invalidated",
]);

/** Schema for OutcomeRecord. */
export const OutcomeRecordSchema: z.ZodType = z.object({
  cid: z.string(),
  status: OutcomeStatusSchema,
  reason: z.string().optional(),
  baselineCid: z.string().optional(),
  evaluatedAt: z.string(),
  evaluatedBy: z.string(),
});

/** Schema for OutcomeStats. */
export const OutcomeStatsSchema: z.ZodType = z.object({
  total: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  crashed: z.number().int().nonnegative(),
  invalidated: z.number().int().nonnegative(),
  acceptanceRate: z.number().nonnegative(),
});
