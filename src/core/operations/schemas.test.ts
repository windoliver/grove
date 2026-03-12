/**
 * Tests for operation result Zod schemas.
 *
 * Verifies that each schema accepts valid data and rejects invalid data,
 * ensuring the schemas faithfully model the TypeScript result interfaces.
 */

import { describe, expect, test } from "bun:test";

import {
  CheckoutResultSchema,
  CheckStopResultSchema,
  ClaimBountyResultSchema,
  ClaimResultSchema,
  ContributeResultSchema,
  ContributionSummarySchema,
  CreateBountyResultSchema,
  DiscussResultSchema,
  FrontierEntrySummarySchema,
  FrontierResultSchema,
  ListBountiesResultSchema,
  ListClaimsResultSchema,
  LogResultSchema,
  OperationErrorSchema,
  OperationErrSchema,
  OperationResultSchema,
  OutcomeRecordSchema,
  OutcomeStatsSchema,
  ReleaseResultSchema,
  ReproduceResultSchema,
  ReviewResultSchema,
  SearchResultSchema,
  SettleBountyResultSchema,
  StopConditionStatusSchema,
  ThreadActivitySummarySchema,
  ThreadNodeSummarySchema,
  ThreadResultSchema,
  ThreadsResultSchema,
  TreeResultSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that parsing succeeds and returns the input. */
function expectValid<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const result = schema.parse(value);
  expect(result).toBeDefined();
  return result;
}

/** Assert that parsing fails. */
function expectInvalid(schema: { parse: (v: unknown) => unknown }, value: unknown): void {
  expect(() => schema.parse(value)).toThrow();
}

// ---------------------------------------------------------------------------
// OperationError / OperationResult
// ---------------------------------------------------------------------------

describe("OperationErrorSchema", () => {
  test("accepts valid error", () => {
    expectValid(OperationErrorSchema, {
      code: "NOT_FOUND",
      message: "Contribution not found: abc",
    });
  });

  test("accepts error with details", () => {
    expectValid(OperationErrorSchema, {
      code: "CLAIM_CONFLICT",
      message: "Already claimed",
      details: { targetRef: "task-1", heldByAgentId: "agent-2" },
    });
  });

  test("rejects unknown error code", () => {
    expectInvalid(OperationErrorSchema, {
      code: "UNKNOWN_CODE",
      message: "Something",
    });
  });

  test("rejects missing message", () => {
    expectInvalid(OperationErrorSchema, { code: "NOT_FOUND" });
  });
});

describe("OperationErrSchema", () => {
  test("accepts valid err", () => {
    expectValid(OperationErrSchema, {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "oops" },
    });
  });

  test("rejects ok: true", () => {
    expectInvalid(OperationErrSchema, {
      ok: true,
      error: { code: "INTERNAL_ERROR", message: "oops" },
    });
  });
});

describe("OperationResultSchema", () => {
  const StringResult = OperationResultSchema(ContributeResultSchema);

  test("accepts ok result", () => {
    expectValid(StringResult, {
      ok: true,
      value: {
        cid: "blake3:abc",
        kind: "work",
        mode: "evaluation",
        summary: "test",
        artifactCount: 0,
        relationCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
      },
    });
  });

  test("accepts err result", () => {
    expectValid(StringResult, {
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
    });
  });
});

// ---------------------------------------------------------------------------
// Contribute results
// ---------------------------------------------------------------------------

describe("ContributeResultSchema", () => {
  const valid = {
    cid: "blake3:abc123",
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    artifactCount: 2,
    relationCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };

  test("accepts valid result", () => {
    expectValid(ContributeResultSchema, valid);
  });

  test("rejects missing cid", () => {
    const { cid: _, ...rest } = valid;
    expectInvalid(ContributeResultSchema, rest);
  });

  test("rejects negative artifactCount", () => {
    expectInvalid(ContributeResultSchema, { ...valid, artifactCount: -1 });
  });

  test("rejects non-integer artifactCount", () => {
    expectInvalid(ContributeResultSchema, { ...valid, artifactCount: 1.5 });
  });
});

describe("ReviewResultSchema", () => {
  test("accepts valid review result", () => {
    expectValid(ReviewResultSchema, {
      cid: "blake3:abc",
      kind: "review",
      targetCid: "blake3:target",
      summary: "Looks good",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  test("rejects wrong kind literal", () => {
    expectInvalid(ReviewResultSchema, {
      cid: "blake3:abc",
      kind: "work",
      targetCid: "blake3:target",
      summary: "Looks good",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("ReproduceResultSchema", () => {
  test("accepts valid reproduction result", () => {
    expectValid(ReproduceResultSchema, {
      cid: "blake3:abc",
      kind: "reproduction",
      targetCid: "blake3:target",
      result: "confirmed",
      summary: "Reproduced successfully",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  test("rejects wrong kind literal", () => {
    expectInvalid(ReproduceResultSchema, {
      cid: "blake3:abc",
      kind: "review",
      targetCid: "blake3:target",
      result: "confirmed",
      summary: "test",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("DiscussResultSchema", () => {
  test("accepts discuss with targetCid", () => {
    expectValid(DiscussResultSchema, {
      cid: "blake3:abc",
      kind: "discussion",
      targetCid: "blake3:parent",
      summary: "I agree",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  test("accepts discuss without targetCid", () => {
    expectValid(DiscussResultSchema, {
      cid: "blake3:abc",
      kind: "discussion",
      summary: "New topic",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Claim results
// ---------------------------------------------------------------------------

describe("ClaimResultSchema", () => {
  const valid = {
    claimId: "uuid-123",
    targetRef: "task-1",
    status: "active",
    agentId: "agent-1",
    intentSummary: "Working on task 1",
    leaseExpiresAt: "2026-01-01T00:05:00Z",
    renewed: false,
  };

  test("accepts valid claim result", () => {
    expectValid(ClaimResultSchema, valid);
  });

  test("rejects missing renewed field", () => {
    const { renewed: _, ...rest } = valid;
    expectInvalid(ClaimResultSchema, rest);
  });
});

describe("ReleaseResultSchema", () => {
  test("accepts release action", () => {
    expectValid(ReleaseResultSchema, {
      claimId: "uuid-123",
      targetRef: "task-1",
      status: "released",
      action: "release",
    });
  });

  test("accepts complete action", () => {
    expectValid(ReleaseResultSchema, {
      claimId: "uuid-123",
      targetRef: "task-1",
      status: "completed",
      action: "complete",
    });
  });

  test("rejects invalid action", () => {
    expectInvalid(ReleaseResultSchema, {
      claimId: "uuid-123",
      targetRef: "task-1",
      status: "released",
      action: "cancel",
    });
  });
});

describe("ListClaimsResultSchema", () => {
  test("accepts valid list with claims", () => {
    expectValid(ListClaimsResultSchema, {
      claims: [
        {
          claimId: "c1",
          targetRef: "task-1",
          status: "active",
          agentId: "a1",
          intentSummary: "Working",
          leaseExpiresAt: "2026-01-01T00:05:00Z",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      count: 1,
    });
  });

  test("accepts empty list", () => {
    expectValid(ListClaimsResultSchema, { claims: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

describe("ContributionSummarySchema", () => {
  const valid = {
    cid: "blake3:abc",
    summary: "Test",
    kind: "work",
    mode: "evaluation",
    tags: ["alpha", "beta"],
    agentId: "agent-1",
    createdAt: "2026-01-01T00:00:00Z",
  };

  test("accepts without scores", () => {
    expectValid(ContributionSummarySchema, valid);
  });

  test("accepts with scores", () => {
    expectValid(ContributionSummarySchema, {
      ...valid,
      scores: { val_bpb: { value: 0.95, direction: "minimize" } },
    });
  });

  test("rejects missing tags", () => {
    const { tags: _, ...rest } = valid;
    expectInvalid(ContributionSummarySchema, rest);
  });
});

describe("FrontierEntrySummarySchema", () => {
  test("accepts valid entry", () => {
    expectValid(FrontierEntrySummarySchema, {
      cid: "blake3:abc",
      summary: "Best work",
      value: 0.95,
      kind: "work",
      mode: "evaluation",
      agentId: "agent-1",
    });
  });
});

describe("FrontierResultSchema", () => {
  test("accepts valid frontier result", () => {
    const entry = {
      cid: "blake3:abc",
      summary: "test",
      value: 1.0,
      kind: "work",
      mode: "evaluation",
      agentId: "a1",
    };

    expectValid(FrontierResultSchema, {
      byMetric: { val_bpb: [entry] },
      byAdoption: [],
      byRecency: [entry],
      byReviewScore: [],
      byReproduction: [],
    });
  });

  test("accepts empty frontier", () => {
    expectValid(FrontierResultSchema, {
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    });
  });
});

describe("SearchResultSchema", () => {
  test("accepts valid search result", () => {
    expectValid(SearchResultSchema, {
      results: [
        {
          cid: "blake3:abc",
          summary: "found",
          kind: "work",
          mode: "evaluation",
          tags: [],
          agentId: "a1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      count: 1,
    });
  });
});

describe("LogResultSchema", () => {
  test("accepts valid log result", () => {
    expectValid(LogResultSchema, { results: [], count: 0 });
  });
});

describe("TreeResultSchema", () => {
  test("accepts with both children and ancestors", () => {
    expectValid(TreeResultSchema, {
      cid: "blake3:root",
      summary: "Root",
      kind: "work",
      children: [],
      ancestors: [],
    });
  });

  test("accepts without children/ancestors", () => {
    expectValid(TreeResultSchema, {
      cid: "blake3:root",
      summary: "Root",
      kind: "work",
    });
  });
});

describe("ThreadNodeSummarySchema", () => {
  test("accepts valid node", () => {
    expectValid(ThreadNodeSummarySchema, {
      cid: "blake3:abc",
      depth: 0,
      summary: "Root message",
      kind: "discussion",
      agentId: "a1",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  test("rejects negative depth", () => {
    expectInvalid(ThreadNodeSummarySchema, {
      cid: "blake3:abc",
      depth: -1,
      summary: "test",
      kind: "discussion",
      agentId: "a1",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

describe("ThreadResultSchema", () => {
  test("accepts valid thread result", () => {
    expectValid(ThreadResultSchema, {
      nodes: [
        {
          cid: "blake3:abc",
          depth: 0,
          summary: "Root",
          kind: "discussion",
          agentId: "a1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      count: 1,
    });
  });
});

describe("ThreadActivitySummarySchema", () => {
  test("accepts valid activity summary", () => {
    expectValid(ThreadActivitySummarySchema, {
      cid: "blake3:abc",
      summary: "Hot topic",
      kind: "discussion",
      replyCount: 5,
      lastReplyAt: "2026-01-01T01:00:00Z",
      agentId: "a1",
    });
  });
});

describe("ThreadsResultSchema", () => {
  test("accepts valid threads result", () => {
    expectValid(ThreadsResultSchema, { threads: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Checkout results
// ---------------------------------------------------------------------------

describe("CheckoutResultSchema", () => {
  test("accepts valid checkout result", () => {
    expectValid(CheckoutResultSchema, {
      cid: "blake3:abc",
      workspacePath: "/tmp/grove-ws/abc",
      status: "ready",
      agentId: "agent-1",
      artifactCount: 3,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle results
// ---------------------------------------------------------------------------

describe("StopConditionStatusSchema", () => {
  test("accepts with details", () => {
    expectValid(StopConditionStatusSchema, {
      met: true,
      reason: "Contribution limit reached",
      details: { current: 100, limit: 100 },
    });
  });

  test("accepts without details", () => {
    expectValid(StopConditionStatusSchema, {
      met: false,
      reason: "Not yet met",
    });
  });
});

describe("CheckStopResultSchema", () => {
  test("accepts valid check stop result", () => {
    expectValid(CheckStopResultSchema, {
      stopped: false,
      reason: "No stop conditions met",
      conditions: {},
      evaluatedAt: "2026-01-01T00:00:00Z",
    });
  });

  test("accepts with conditions", () => {
    expectValid(CheckStopResultSchema, {
      stopped: true,
      reason: "max_contributions: Limit reached",
      conditions: {
        max_contributions: {
          met: true,
          reason: "100 of 100 contributions",
        },
      },
      evaluatedAt: "2026-01-01T00:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Bounty results
// ---------------------------------------------------------------------------

describe("CreateBountyResultSchema", () => {
  test("accepts valid result with reservation", () => {
    expectValid(CreateBountyResultSchema, {
      bountyId: "uuid-bounty",
      title: "Improve val_bpb",
      amount: 100,
      status: "open",
      deadline: "2026-01-08T00:00:00Z",
      reservationId: "uuid-res",
    });
  });

  test("accepts valid result without reservation", () => {
    expectValid(CreateBountyResultSchema, {
      bountyId: "uuid-bounty",
      title: "Improve val_bpb",
      amount: 100,
      status: "open",
      deadline: "2026-01-08T00:00:00Z",
    });
  });

  test("rejects invalid status", () => {
    expectInvalid(CreateBountyResultSchema, {
      bountyId: "uuid-bounty",
      title: "test",
      amount: 100,
      status: "invalid_status",
      deadline: "2026-01-08T00:00:00Z",
    });
  });
});

describe("ListBountiesResultSchema", () => {
  test("accepts valid list", () => {
    expectValid(ListBountiesResultSchema, {
      bounties: [
        {
          bountyId: "b1",
          title: "Bounty 1",
          amount: 50,
          status: "open",
          deadline: "2026-01-08T00:00:00Z",
        },
      ],
      count: 1,
    });
  });
});

describe("ClaimBountyResultSchema", () => {
  test("accepts valid claim bounty result", () => {
    expectValid(ClaimBountyResultSchema, {
      bountyId: "b1",
      title: "Bounty",
      status: "claimed",
      claimId: "c1",
      claimedBy: "agent-1",
    });
  });
});

describe("SettleBountyResultSchema", () => {
  test("accepts valid settle result", () => {
    expectValid(SettleBountyResultSchema, {
      bountyId: "b1",
      status: "settled",
      fulfilledByCid: "blake3:abc",
      amount: 100,
      paidTo: "agent-1",
    });
  });

  test("accepts settle without optional fields", () => {
    expectValid(SettleBountyResultSchema, {
      bountyId: "b1",
      status: "settled",
      amount: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Outcome results
// ---------------------------------------------------------------------------

describe("OutcomeRecordSchema", () => {
  test("accepts valid outcome record", () => {
    expectValid(OutcomeRecordSchema, {
      cid: "blake3:abc",
      status: "accepted",
      evaluatedAt: "2026-01-01T00:00:00Z",
      evaluatedBy: "agent-1",
    });
  });

  test("accepts with optional fields", () => {
    expectValid(OutcomeRecordSchema, {
      cid: "blake3:abc",
      status: "rejected",
      reason: "Does not meet criteria",
      baselineCid: "blake3:baseline",
      evaluatedAt: "2026-01-01T00:00:00Z",
      evaluatedBy: "agent-1",
    });
  });

  test("rejects invalid status", () => {
    expectInvalid(OutcomeRecordSchema, {
      cid: "blake3:abc",
      status: "unknown_status",
      evaluatedAt: "2026-01-01T00:00:00Z",
      evaluatedBy: "agent-1",
    });
  });
});

describe("OutcomeStatsSchema", () => {
  test("accepts valid stats", () => {
    expectValid(OutcomeStatsSchema, {
      total: 10,
      accepted: 7,
      rejected: 2,
      crashed: 1,
      invalidated: 0,
      acceptanceRate: 0.7,
    });
  });

  test("rejects negative total", () => {
    expectInvalid(OutcomeStatsSchema, {
      total: -1,
      accepted: 0,
      rejected: 0,
      crashed: 0,
      invalidated: 0,
      acceptanceRate: 0,
    });
  });
});
