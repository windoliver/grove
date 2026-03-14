/**
 * Tests for shared Zod schemas and parse helpers.
 */

import { describe, expect, test } from "bun:test";

import {
  parseBounties,
  parseBounty,
  parseClaim,
  parseClaims,
  parseContribution,
  parseContributions,
  parseFrontier,
  parseOutcomeRecord,
  parseOutcomeStats,
  parsePeerInfo,
  parsePeerInfos,
  parseThreadSummaries,
  parseThreadSummary,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Helpers — minimal valid objects for each domain type
// ---------------------------------------------------------------------------

function validContributionManifest(): Record<string, unknown> {
  return {
    cid: `blake3:${"a".repeat(64)}`,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary: "Test contribution",
    artifacts: {},
    relations: [],
    tags: ["test"],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  };
}

function validClaim(): Record<string, unknown> {
  return {
    claimId: "claim-1",
    targetRef: "target-1",
    agent: { agentId: "agent-1" },
    status: "active",
    intentSummary: "Working on it",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

function validOutcomeRecord(): Record<string, unknown> {
  return {
    cid: `blake3:${"b".repeat(64)}`,
    status: "accepted",
    evaluatedAt: new Date().toISOString(),
    evaluatedBy: "operator-1",
  };
}

function validBounty(): Record<string, unknown> {
  return {
    bountyId: "bounty-1",
    title: "Fix the bug",
    description: "The parser is broken",
    status: "open",
    creator: { agentId: "agent-1" },
    amount: 100,
    criteria: { description: "Fix the parser" },
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function validPeerInfo(): Record<string, unknown> {
  return {
    peerId: "peer-1",
    address: "http://localhost:4515",
    age: 3,
    lastSeen: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Contribution parsing
// ---------------------------------------------------------------------------

describe("parseContribution", () => {
  test("parses a valid contribution manifest", () => {
    const data = validContributionManifest();
    const result = parseContribution(data);
    expect(result.cid).toBe(data.cid as string);
    expect(result.kind).toBe("work");
    expect(result.summary).toBe("Test contribution");
  });

  test("rejects missing required fields", () => {
    expect(() => parseContribution({})).toThrow();
  });

  test("rejects non-object input", () => {
    expect(() => parseContribution("not an object")).toThrow();
    expect(() => parseContribution(null)).toThrow();
    expect(() => parseContribution(42)).toThrow();
  });

  test("rejects invalid kind", () => {
    const data = { ...validContributionManifest(), kind: "invalid" };
    expect(() => parseContribution(data)).toThrow();
  });
});

describe("parseContributions", () => {
  test("parses an array of contributions", () => {
    const data = [validContributionManifest()];
    const result = parseContributions(data);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("work");
  });

  test("returns empty array for empty input", () => {
    expect(parseContributions([])).toHaveLength(0);
  });

  test("rejects non-array input", () => {
    expect(() => parseContributions("not an array")).toThrow();
  });

  test("rejects array with invalid elements", () => {
    expect(() => parseContributions([{}])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Claim parsing
// ---------------------------------------------------------------------------

describe("parseClaim", () => {
  test("parses a valid claim", () => {
    const data = validClaim();
    const result = parseClaim(data);
    expect(result.claimId).toBe("claim-1");
    expect(result.status).toBe("active");
    expect(result.agent.agentId).toBe("agent-1");
  });

  test("parses claim with optional fields", () => {
    const data = {
      ...validClaim(),
      context: { key: "value" },
      attemptCount: 3,
      revision: 5,
    };
    const result = parseClaim(data);
    expect(result.attemptCount).toBe(3);
    expect(result.revision).toBe(5);
  });

  test("rejects missing required fields", () => {
    expect(() => parseClaim({})).toThrow();
  });

  test("rejects invalid status", () => {
    const data = { ...validClaim(), status: "invalid" };
    expect(() => parseClaim(data)).toThrow();
  });
});

describe("parseClaims", () => {
  test("parses array of claims", () => {
    const result = parseClaims([validClaim(), { ...validClaim(), claimId: "claim-2" }]);
    expect(result).toHaveLength(2);
  });

  test("rejects invalid elements", () => {
    expect(() => parseClaims([validClaim(), {}])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Outcome parsing
// ---------------------------------------------------------------------------

describe("parseOutcomeRecord", () => {
  test("parses a valid outcome", () => {
    const result = parseOutcomeRecord(validOutcomeRecord());
    expect(result.status).toBe("accepted");
    expect(result.evaluatedBy).toBe("operator-1");
  });

  test("parses with optional fields", () => {
    const data = {
      ...validOutcomeRecord(),
      reason: "Looks good",
      baselineCid: `blake3:${"c".repeat(64)}`,
    };
    const result = parseOutcomeRecord(data);
    expect(result.reason).toBe("Looks good");
  });

  test("rejects invalid status", () => {
    expect(() => parseOutcomeRecord({ ...validOutcomeRecord(), status: "pending" })).toThrow();
  });
});

describe("parseOutcomeStats", () => {
  test("parses valid stats", () => {
    const data = {
      total: 10,
      accepted: 5,
      rejected: 3,
      crashed: 1,
      invalidated: 1,
      acceptanceRate: 0.5,
    };
    const result = parseOutcomeStats(data);
    expect(result.total).toBe(10);
    expect(result.acceptanceRate).toBe(0.5);
  });

  test("rejects missing fields", () => {
    expect(() => parseOutcomeStats({ total: 10 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bounty parsing
// ---------------------------------------------------------------------------

describe("parseBounty", () => {
  test("parses a valid bounty", () => {
    const result = parseBounty(validBounty());
    expect(result.bountyId).toBe("bounty-1");
    expect(result.status).toBe("open");
    expect(result.amount).toBe(100);
  });

  test("parses all bounty statuses", () => {
    for (const status of [
      "draft",
      "open",
      "claimed",
      "completed",
      "settled",
      "expired",
      "cancelled",
    ] as const) {
      const result = parseBounty({ ...validBounty(), status });
      expect(result.status).toBe(status);
    }
  });

  test("rejects invalid status", () => {
    expect(() => parseBounty({ ...validBounty(), status: "invalid" })).toThrow();
  });
});

describe("parseBounties", () => {
  test("parses array of bounties", () => {
    const result = parseBounties([validBounty()]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Peer info parsing
// ---------------------------------------------------------------------------

describe("parsePeerInfo", () => {
  test("parses valid peer info", () => {
    const result = parsePeerInfo(validPeerInfo());
    expect(result.peerId).toBe("peer-1");
    expect(result.age).toBe(3);
  });

  test("rejects missing fields", () => {
    expect(() => parsePeerInfo({ peerId: "peer-1" })).toThrow();
  });
});

describe("parsePeerInfos", () => {
  test("parses array", () => {
    const result = parsePeerInfos([validPeerInfo()]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Thread summary parsing
// ---------------------------------------------------------------------------

describe("parseThreadSummary", () => {
  test("parses valid thread summary with contribution", () => {
    const data = {
      contribution: validContributionManifest(),
      replyCount: 5,
      lastReplyAt: new Date().toISOString(),
    };
    const result = parseThreadSummary(data);
    expect(result.replyCount).toBe(5);
    expect(result.contribution.kind).toBe("work");
  });
});

describe("parseThreadSummaries", () => {
  test("parses array of thread summaries", () => {
    const data = [
      {
        contribution: validContributionManifest(),
        replyCount: 3,
        lastReplyAt: new Date().toISOString(),
      },
    ];
    const result = parseThreadSummaries(data);
    expect(result).toHaveLength(1);
    expect(result[0]?.replyCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Frontier parsing
// ---------------------------------------------------------------------------

describe("parseFrontier", () => {
  test("parses empty frontier", () => {
    const data = {
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    };
    const result = parseFrontier(data);
    expect(result.byAdoption).toHaveLength(0);
    expect(Object.keys(result.byMetric)).toHaveLength(0);
  });

  test("parses frontier with entries", () => {
    const data = {
      byMetric: {
        val_bpb: [
          {
            cid: `blake3:${"a".repeat(64)}`,
            summary: "Best model",
            value: 0.95,
            contribution: validContributionManifest(),
          },
        ],
      },
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    };
    const result = parseFrontier(data);
    expect(result.byMetric.val_bpb).toHaveLength(1);
    expect(result.byMetric.val_bpb?.[0]?.value).toBe(0.95);
  });

  test("rejects missing frontier fields", () => {
    expect(() => parseFrontier({ byMetric: {} })).toThrow();
  });
});
