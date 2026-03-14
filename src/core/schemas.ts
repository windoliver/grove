/**
 * Shared Zod schemas and parse helpers for API response validation.
 *
 * Provides runtime validation at system boundaries (API responses,
 * external data) to prevent silent data corruption from unvalidated
 * `as` casts. Domain model types remain in models.ts — this module
 * provides the Zod counterparts for runtime checking.
 *
 * Parse helpers return frozen, validated domain objects. Consumers
 * should use these instead of raw `as` casts on JSON responses.
 */

import { z } from "zod";

import type { Bounty, BountyCriteria, BountyStatus } from "./bounty.js";
import type { Frontier, FrontierEntry } from "./frontier.js";
import type { PeerInfo } from "./gossip/types.js";
import { fromManifest } from "./manifest.js";
import type { AgentIdentity, Claim, ClaimStatus, Contribution, JsonValue } from "./models.js";
import type { OutcomeRecord, OutcomeStats, OutcomeStatus } from "./outcome.js";
import type { ThreadSummary } from "./store.js";

// ---------------------------------------------------------------------------
// Sub-schemas (not exported — used to compose higher-level schemas)
// ---------------------------------------------------------------------------

const AgentIdentitySchema: z.ZodType<AgentIdentity> = z.object({
  agentId: z.string(),
  agentName: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
  toolchain: z.string().optional(),
  runtime: z.string().optional(),
  role: z.string().optional(),
});

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// Domain model schemas
// ---------------------------------------------------------------------------

const ClaimSchema: z.ZodType<Claim> = z.object({
  claimId: z.string(),
  targetRef: z.string(),
  agent: AgentIdentitySchema,
  status: z.enum(["active", "released", "expired", "completed"]) as z.ZodType<ClaimStatus>,
  intentSummary: z.string(),
  createdAt: z.string(),
  heartbeatAt: z.string(),
  leaseExpiresAt: z.string(),
  context: z.record(z.string(), JsonValueSchema).optional(),
  attemptCount: z.number().optional(),
  revision: z.number().optional(),
});

const OutcomeRecordSchema: z.ZodType<OutcomeRecord> = z.object({
  cid: z.string(),
  status: z.enum(["accepted", "rejected", "crashed", "invalidated"]) as z.ZodType<OutcomeStatus>,
  reason: z.string().optional(),
  baselineCid: z.string().optional(),
  evaluatedAt: z.string(),
  evaluatedBy: z.string(),
});

const OutcomeStatsSchema: z.ZodType<OutcomeStats> = z.object({
  total: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  crashed: z.number(),
  invalidated: z.number(),
  acceptanceRate: z.number(),
});

const BountyCriteriaSchema: z.ZodType<BountyCriteria> = z.object({
  description: z.string(),
  metricName: z.string().optional(),
  metricThreshold: z.number().optional(),
  metricDirection: z.enum(["minimize", "maximize"]).optional(),
  requiredTags: z.array(z.string()).optional(),
});

const BountySchema: z.ZodType<Bounty> = z.object({
  bountyId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum([
    "draft",
    "open",
    "claimed",
    "completed",
    "settled",
    "expired",
    "cancelled",
  ]) as z.ZodType<BountyStatus>,
  creator: AgentIdentitySchema,
  amount: z.number(),
  criteria: BountyCriteriaSchema,
  zoneId: z.string().optional(),
  deadline: z.string(),
  claimedBy: AgentIdentitySchema.optional(),
  claimId: z.string().optional(),
  fulfilledByCid: z.string().optional(),
  reservationId: z.string().optional(),
  context: z.record(z.string(), JsonValueSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Schema for frontier entry summaries returned by the HTTP API.
 *
 * The server returns FrontierEntrySummary (cid, summary, value) — NOT
 * the internal FrontierEntry which includes the full contribution object.
 * The contribution field is optional to accommodate both formats.
 */
const FrontierEntrySchema: z.ZodType<FrontierEntry> = z.object({
  cid: z.string(),
  summary: z.string(),
  value: z.number(),
  contribution: z
    .unknown()
    .optional()
    .transform((data) =>
      data !== undefined && data !== null
        ? fromManifest(data, { verify: false })
        : (undefined as unknown as Contribution),
    ),
}) as z.ZodType<FrontierEntry>;

const FrontierSchema: z.ZodType<Frontier> = z.object({
  byMetric: z.record(z.string(), z.array(FrontierEntrySchema)),
  byAdoption: z.array(FrontierEntrySchema),
  byRecency: z.array(FrontierEntrySchema),
  byReviewScore: z.array(FrontierEntrySchema),
  byReproduction: z.array(FrontierEntrySchema),
});

const PeerInfoSchema: z.ZodType<PeerInfo> = z.object({
  peerId: z.string(),
  address: z.string(),
  age: z.number(),
  lastSeen: z.string(),
});

// ---------------------------------------------------------------------------
// Parse helpers — validated domain object constructors for API responses
// ---------------------------------------------------------------------------

/**
 * Parse and validate a single contribution from untrusted data.
 * Uses `fromManifest()` with CID verification disabled (server already verified).
 */
export function parseContribution(data: unknown): Contribution {
  return fromManifest(data, { verify: false });
}

/** Parse and validate an array of contributions from untrusted data. */
export function parseContributions(data: unknown): readonly Contribution[] {
  const arr = z.array(z.unknown()).parse(data);
  return arr.map((d) => fromManifest(d, { verify: false }));
}

/** Parse and validate a single claim from untrusted data. */
export function parseClaim(data: unknown): Claim {
  return ClaimSchema.parse(data);
}

/** Parse and validate an array of claims from untrusted data. */
export function parseClaims(data: unknown): readonly Claim[] {
  return z.array(ClaimSchema).parse(data);
}

/** Parse and validate a single outcome record from untrusted data. */
export function parseOutcomeRecord(data: unknown): OutcomeRecord {
  return OutcomeRecordSchema.parse(data);
}

/** Parse and validate an array of outcome records from untrusted data. */
export function parseOutcomeRecords(data: unknown): readonly OutcomeRecord[] {
  return z.array(OutcomeRecordSchema).parse(data);
}

/** Parse and validate outcome stats from untrusted data. */
export function parseOutcomeStats(data: unknown): OutcomeStats {
  return OutcomeStatsSchema.parse(data);
}

/** Parse and validate a frontier from untrusted data. */
export function parseFrontier(data: unknown): Frontier {
  return FrontierSchema.parse(data);
}

/** Parse and validate a single bounty from untrusted data. */
export function parseBounty(data: unknown): Bounty {
  return BountySchema.parse(data);
}

/** Parse and validate an array of bounties from untrusted data. */
export function parseBounties(data: unknown): readonly Bounty[] {
  return z.array(BountySchema).parse(data);
}

/** Parse and validate a single peer info from untrusted data. */
export function parsePeerInfo(data: unknown): PeerInfo {
  return PeerInfoSchema.parse(data);
}

/** Parse and validate an array of peer infos from untrusted data. */
export function parsePeerInfos(data: unknown): readonly PeerInfo[] {
  return z.array(PeerInfoSchema).parse(data);
}

/** Parse and validate a thread summary from untrusted data. */
export function parseThreadSummary(data: unknown): ThreadSummary {
  return z
    .object({
      contribution: z.unknown().transform((d) => fromManifest(d, { verify: false })),
      replyCount: z.number(),
      lastReplyAt: z.string(),
    })
    .parse(data) as ThreadSummary;
}

/** Parse and validate an array of thread summaries from untrusted data. */
export function parseThreadSummaries(data: unknown): readonly ThreadSummary[] {
  const schema = z.array(
    z.object({
      contribution: z.unknown().transform((d) => fromManifest(d, { verify: false })),
      replyCount: z.number(),
      lastReplyAt: z.string(),
    }),
  );
  return schema.parse(data) as readonly ThreadSummary[];
}
