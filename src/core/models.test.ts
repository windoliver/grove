import { describe, expect, test } from "bun:test";
import type { AgentIdentity, Contribution, Relation, Score } from "./models.js";
import {
  ClaimStatus,
  ContributionKind,
  ContributionMode,
  RelationType,
  ScoreDirection,
} from "./models.js";

describe("ContributionKind", () => {
  test("has all expected values", () => {
    expect(ContributionKind.Work).toBe("work");
    expect(ContributionKind.Review).toBe("review");
    expect(ContributionKind.Discussion).toBe("discussion");
    expect(ContributionKind.Adoption).toBe("adoption");
    expect(ContributionKind.Reproduction).toBe("reproduction");
  });
});

describe("ContributionMode", () => {
  test("has evaluation and exploration", () => {
    expect(ContributionMode.Evaluation).toBe("evaluation");
    expect(ContributionMode.Exploration).toBe("exploration");
  });
});

describe("RelationType", () => {
  test("has all v1 relation types", () => {
    expect(RelationType.DerivesFrom).toBe("derives_from");
    expect(RelationType.RespondsTo).toBe("responds_to");
    expect(RelationType.Reviews).toBe("reviews");
    expect(RelationType.Reproduces).toBe("reproduces");
    expect(RelationType.Adopts).toBe("adopts");
  });
});

describe("ClaimStatus", () => {
  test("has all lifecycle states", () => {
    expect(ClaimStatus.Active).toBe("active");
    expect(ClaimStatus.Released).toBe("released");
    expect(ClaimStatus.Expired).toBe("expired");
    expect(ClaimStatus.Completed).toBe("completed");
  });
});

describe("Contribution interface", () => {
  test("can construct a valid contribution object", () => {
    const agent: AgentIdentity = {
      agentId: "claude-code-alice",
      agentName: "Alice",
      provider: "anthropic",
      model: "claude-opus-4-6",
      platform: "H100",
    };

    const relation: Relation = {
      targetCid: "blake3:parent123",
      relationType: RelationType.DerivesFrom,
    };

    const score: Score = {
      value: 0.9697,
      direction: ScoreDirection.Minimize,
      unit: "bpb",
    };

    const contribution: Contribution = {
      cid: "blake3:abc123",
      kind: ContributionKind.Work,
      mode: ContributionMode.Evaluation,
      summary: "Vectorized inner loop with numpy",
      artifacts: { "train.py": "blake3:deed456" },
      relations: [relation],
      scores: { val_bpb: score },
      tags: ["optimizer", "numpy"],
      agent,
      createdAt: "2026-03-08T10:00:00Z",
    };

    expect(contribution.cid).toBe("blake3:abc123");
    expect(contribution.kind).toBe("work");
    expect(contribution.mode).toBe("evaluation");
    expect(contribution.relations).toHaveLength(1);
    expect(contribution.scores?.val_bpb?.value).toBe(0.9697);
    expect(contribution.tags).toEqual(["optimizer", "numpy"]);
  });

  test("supports exploration mode with no scores", () => {
    const contribution: Contribution = {
      cid: "blake3:explore789",
      kind: ContributionKind.Work,
      mode: ContributionMode.Exploration,
      summary: "Database connection pool bottleneck analysis",
      artifacts: { "analysis.md": "blake3:report456" },
      relations: [],
      tags: ["performance", "database"],
      agent: { agentId: "codex-bob" },
      createdAt: "2026-03-08T11:00:00Z",
    };

    expect(contribution.mode).toBe("exploration");
    expect(contribution.scores).toBeUndefined();
  });
});
