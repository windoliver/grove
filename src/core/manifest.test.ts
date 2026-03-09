import { describe, expect, test } from "bun:test";

import type { ContributionInput } from "./manifest.js";
import {
  computeCid,
  createContribution,
  fromManifest,
  MANIFEST_VERSION,
  toManifest,
  verifyCid,
} from "./manifest.js";
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode, RelationType, ScoreDirection } from "./models.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MINIMAL_INPUT: ContributionInput = {
  kind: ContributionKind.Work,
  mode: ContributionMode.Evaluation,
  summary: "Test contribution",
  artifacts: {},
  relations: [],
  tags: [],
  agent: { agentId: "test-agent" },
  createdAt: "2026-01-01T00:00:00Z",
};

const FULL_INPUT: ContributionInput = {
  kind: ContributionKind.Work,
  mode: ContributionMode.Evaluation,
  summary: "Vectorized inner loop with numpy",
  description: "Replaced naive Python loop with vectorized numpy operations",
  artifacts: { "train.py": "blake3:deed456deed456deed456deed456deed456deed456deed456deed456deed" },
  relations: [
    {
      targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relationType: RelationType.DerivesFrom,
    },
  ],
  scores: { val_bpb: { value: 0.9697, direction: ScoreDirection.Minimize, unit: "bpb" } },
  tags: ["optimizer", "numpy"],
  context: { repo: "autoresearch", seed: 42 },
  agent: {
    agentId: "claude-code-alice",
    agentName: "Alice",
    provider: "anthropic",
    model: "claude-opus-4-6",
    platform: "H100",
    version: "1.0.0",
    toolchain: "bun",
    runtime: "cloudflare-workers",
  },
  createdAt: "2026-03-08T10:00:00Z",
};

const EXPLORATION_INPUT: ContributionInput = {
  kind: ContributionKind.Work,
  mode: ContributionMode.Exploration,
  summary: "Database connection pool bottleneck analysis",
  artifacts: {
    "analysis.md": "blake3:44444444444444444444444444444444444444444444444444444444444444ee",
  },
  relations: [],
  tags: ["performance", "database"],
  agent: { agentId: "codex-bob" },
  createdAt: "2026-03-08T11:00:00Z",
};

// ---------------------------------------------------------------------------
// computeCid
// ---------------------------------------------------------------------------

describe("computeCid", () => {
  describe("golden vectors", () => {
    test("minimal contribution produces expected CID", () => {
      const cid = computeCid(MINIMAL_INPUT);
      expect(cid).toBe("blake3:a9308ab958f14c1b78132904f9ff1d8ca066c83f83e82726b489c40de5aa82d2");
    });

    test("full contribution produces expected CID", () => {
      const cid = computeCid(FULL_INPUT);
      expect(cid).toBe("blake3:6fca516148f194a547c81939baf6d4c77a56267374c2fbc90d7bc63cf22e79cb");
    });

    test("exploration contribution produces expected CID", () => {
      const cid = computeCid(EXPLORATION_INPUT);
      expect(cid).toBe("blake3:aad9b9d15a774028209cad399bf92c39abad8fe915cb2e400ec487ae16c86f4a");
    });
  });

  describe("determinism", () => {
    test("same input always produces same CID", () => {
      const cid1 = computeCid(MINIMAL_INPUT);
      const cid2 = computeCid(MINIMAL_INPUT);
      expect(cid1).toBe(cid2);
    });

    test("deep-cloned input produces same CID", () => {
      const cloned = JSON.parse(JSON.stringify(FULL_INPUT)) as ContributionInput;
      expect(computeCid(cloned)).toBe(computeCid(FULL_INPUT));
    });

    test("input field ordering does not affect CID", () => {
      const reordered: ContributionInput = {
        createdAt: FULL_INPUT.createdAt,
        tags: FULL_INPUT.tags,
        agent: FULL_INPUT.agent,
        kind: FULL_INPUT.kind,
        mode: FULL_INPUT.mode,
        summary: FULL_INPUT.summary,
        description: FULL_INPUT.description,
        artifacts: FULL_INPUT.artifacts,
        relations: FULL_INPUT.relations,
        scores: FULL_INPUT.scores,
        context: FULL_INPUT.context,
      };
      expect(computeCid(reordered)).toBe(computeCid(FULL_INPUT));
    });

    test("CID on a Contribution ignores the cid field", () => {
      const contribution = createContribution(MINIMAL_INPUT);
      const fakeContribution: Contribution = {
        ...contribution,
        cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
      };
      expect(computeCid(fakeContribution)).toBe(contribution.cid);
    });
  });

  describe("sensitivity", () => {
    test("changing summary changes CID", () => {
      const altered = { ...MINIMAL_INPUT, summary: "Different summary" };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("changing kind changes CID", () => {
      const altered = { ...MINIMAL_INPUT, kind: ContributionKind.Review };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("changing mode changes CID", () => {
      const altered = { ...MINIMAL_INPUT, mode: ContributionMode.Exploration };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("adding description changes CID", () => {
      const altered = { ...MINIMAL_INPUT, description: "Some description" };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("changing agent changes CID", () => {
      const altered = { ...MINIMAL_INPUT, agent: { agentId: "different-agent" } };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("changing createdAt changes CID", () => {
      const altered = { ...MINIMAL_INPUT, createdAt: "2026-01-02T00:00:00Z" };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("adding a tag changes CID", () => {
      const altered = { ...MINIMAL_INPUT, tags: ["new-tag"] };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("adding scores changes CID", () => {
      const altered = {
        ...MINIMAL_INPUT,
        scores: { metric: { value: 1.0, direction: ScoreDirection.Maximize } },
      };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("adding context changes CID", () => {
      const altered = { ...MINIMAL_INPUT, context: { key: "value" } };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });

    test("adding a relation changes CID", () => {
      const altered = {
        ...MINIMAL_INPUT,
        relations: [
          {
            targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            relationType: RelationType.DerivesFrom,
          },
        ],
      };
      expect(computeCid(altered)).not.toBe(computeCid(MINIMAL_INPUT));
    });
  });

  describe("input validation", () => {
    test("rejects Date in context", () => {
      const input = {
        ...MINIMAL_INPUT,
        context: { when: new Date("2026-01-01") },
      } as unknown as ContributionInput;
      expect(() => computeCid(input)).toThrow();
    });

    test("rejects Date in relation metadata", () => {
      const input = {
        ...MINIMAL_INPUT,
        relations: [
          {
            targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            relationType: RelationType.DerivesFrom,
            metadata: { when: new Date("2026-01-01") },
          },
        ],
      } as unknown as ContributionInput;
      expect(() => computeCid(input)).toThrow();
    });

    test("rejects non-JSON-safe values when called with a Contribution", () => {
      const contribution = {
        ...createContribution(MINIMAL_INPUT),
        context: { data: new Map() },
      } as unknown as Contribution;
      expect(() => computeCid(contribution)).toThrow();
    });
  });

  describe("CID format", () => {
    test("starts with blake3: prefix", () => {
      const cid = computeCid(MINIMAL_INPUT);
      expect(cid.startsWith("blake3:")).toBe(true);
    });

    test("has 71 characters total (7 prefix + 64 hex)", () => {
      const cid = computeCid(MINIMAL_INPUT);
      expect(cid).toHaveLength(71);
    });

    test("hex portion is lowercase", () => {
      const cid = computeCid(MINIMAL_INPUT);
      const hex = cid.slice(7);
      expect(hex).toBe(hex.toLowerCase());
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

// ---------------------------------------------------------------------------
// createContribution
// ---------------------------------------------------------------------------

describe("createContribution", () => {
  test("returns a contribution with computed CID", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    expect(contribution.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  test("sets manifestVersion to current version", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    expect(contribution.manifestVersion).toBe(MANIFEST_VERSION);
  });

  test("preserves all input fields", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(contribution.kind).toBe(FULL_INPUT.kind);
    expect(contribution.mode).toBe(FULL_INPUT.mode);
    expect(contribution.summary).toBe(FULL_INPUT.summary);
    expect(contribution.description).toBe(FULL_INPUT.description);
    expect(contribution.artifacts).toEqual(FULL_INPUT.artifacts);
    expect(contribution.relations).toEqual(FULL_INPUT.relations);
    expect(contribution.scores).toEqual(FULL_INPUT.scores);
    expect(contribution.tags).toEqual(FULL_INPUT.tags);
    expect(contribution.context).toEqual(FULL_INPUT.context);
    expect(contribution.agent).toEqual(FULL_INPUT.agent);
    expect(contribution.createdAt).toBe(FULL_INPUT.createdAt);
  });

  test("returns a frozen object", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    expect(Object.isFrozen(contribution)).toBe(true);
  });

  test("CID is verifiable", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(verifyCid(contribution)).toBe(true);
  });

  test("is isolated from input mutation", () => {
    const tags = ["original"];
    const input = { ...MINIMAL_INPUT, tags };
    const contribution = createContribution(input);
    tags.push("mutated");
    expect(contribution.tags).toEqual(["original"]);
  });

  test("is isolated from input agent mutation", () => {
    const agent = { agentId: "test-agent", agentName: "Original" };
    const input = { ...MINIMAL_INPUT, agent };
    const contribution = createContribution(input);
    agent.agentName = "Mutated";
    expect(contribution.agent.agentName).toBe("Original");
  });
});

// ---------------------------------------------------------------------------
// toManifest
// ---------------------------------------------------------------------------

describe("toManifest", () => {
  test("includes cid in output", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    const manifest = toManifest(contribution);
    expect(manifest.cid).toBe(contribution.cid);
  });

  test("includes manifestVersion", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    const manifest = toManifest(contribution);
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
  });

  test("omits undefined optional fields", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    const manifest = toManifest(contribution);
    expect("description" in manifest).toBe(false);
    expect("scores" in manifest).toBe(false);
    expect("context" in manifest).toBe(false);
  });

  test("includes present optional fields", () => {
    const contribution = createContribution(FULL_INPUT);
    const manifest = toManifest(contribution);
    expect("description" in manifest).toBe(true);
    expect("scores" in manifest).toBe(true);
    expect("context" in manifest).toBe(true);
  });

  test("output is JSON-serializable", () => {
    const contribution = createContribution(FULL_INPUT);
    const manifest = toManifest(contribution);
    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.cid).toBe(contribution.cid);
  });

  test("omits undefined agent optional fields", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    const manifest = toManifest(contribution);
    const agent = manifest.agent as Record<string, unknown>;
    expect("agentId" in agent).toBe(true);
    expect("agentName" in agent).toBe(false);
    expect("provider" in agent).toBe(false);
    expect("model" in agent).toBe(false);
    expect("platform" in agent).toBe(false);
  });

  test("includes present agent optional fields", () => {
    const contribution = createContribution(FULL_INPUT);
    const manifest = toManifest(contribution);
    const agent = manifest.agent as Record<string, unknown>;
    expect(agent.agentName).toBe("Alice");
    expect(agent.provider).toBe("anthropic");
    expect(agent.version).toBe("1.0.0");
    expect(agent.toolchain).toBe("bun");
    expect(agent.runtime).toBe("cloudflare-workers");
  });

  test("omits undefined relation metadata", () => {
    const contribution = createContribution({
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          relationType: RelationType.DerivesFrom,
        },
      ],
    });
    const manifest = toManifest(contribution);
    const relations = manifest.relations as Record<string, unknown>[];
    expect(relations[0] && "metadata" in relations[0]).toBe(false);
  });

  test("includes present relation metadata", () => {
    const contribution = createContribution({
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          relationType: RelationType.Reviews,
          metadata: { confidence: 0.9 },
        },
      ],
    });
    const manifest = toManifest(contribution);
    const relations = manifest.relations as Record<string, unknown>[];
    const firstRelation = relations[0] as Record<string, unknown> | undefined;
    expect(firstRelation?.metadata).toEqual({ confidence: 0.9 });
  });
});

// ---------------------------------------------------------------------------
// fromManifest — round-trip
// ---------------------------------------------------------------------------

describe("fromManifest", () => {
  describe("round-trip", () => {
    test("minimal contribution survives round-trip", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.cid).toBe(original.cid);
      expect(restored.manifestVersion).toBe(original.manifestVersion);
      expect(restored.kind).toBe(original.kind);
      expect(restored.mode).toBe(original.mode);
      expect(restored.summary).toBe(original.summary);
      expect(restored.agent.agentId).toBe(original.agent.agentId);
    });

    test("full contribution survives round-trip", () => {
      const original = createContribution(FULL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.cid).toBe(original.cid);
      expect(restored.description).toBe(original.description);
      expect(restored.artifacts).toEqual(original.artifacts);
      expect(restored.relations).toEqual(original.relations);
      expect(restored.tags).toEqual(original.tags);
      expect(restored.context).toEqual(original.context);
      expect(restored.agent).toEqual(original.agent);
    });

    test("exploration contribution survives round-trip", () => {
      const original = createContribution(EXPLORATION_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.cid).toBe(original.cid);
      expect(restored.mode).toBe("exploration");
      expect(restored.scores).toBeUndefined();
    });

    test("CID is valid after round-trip", () => {
      const original = createContribution(FULL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(verifyCid(restored)).toBe(true);
    });

    test("round-trip through JSON.stringify/parse preserves CID", () => {
      const original = createContribution(FULL_INPUT);
      const json = JSON.stringify(toManifest(original));
      const parsed = JSON.parse(json) as unknown;
      const restored = fromManifest(parsed);
      expect(restored.cid).toBe(original.cid);
      expect(verifyCid(restored)).toBe(true);
    });

    test("scores survive round-trip with correct types", () => {
      const original = createContribution(FULL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      const score = restored.scores?.val_bpb;
      expect(score).toBeDefined();
      expect(score?.value).toBe(0.9697);
      expect(score?.direction).toBe("minimize");
      expect(score?.unit).toBe("bpb");
    });
  });

  describe("edge cases", () => {
    test("handles empty artifacts", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.artifacts).toEqual({});
    });

    test("handles empty relations", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.relations).toEqual([]);
    });

    test("handles empty tags", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.tags).toEqual([]);
    });

    test("handles Unicode in summary and description", () => {
      const input: ContributionInput = {
        ...MINIMAL_INPUT,
        summary: "Unicode test: \u00e9\u00e0\u00fc\u00f1 \u4f60\u597d \ud83d\ude80",
        description: "Emoji and CJK: \ud83c\udf1f\ud83c\udf0d \u65e5\u672c\u8a9e",
      };
      const original = createContribution(input);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.summary).toBe(input.summary);
      expect(restored.description).toBe(input.description);
      expect(verifyCid(restored)).toBe(true);
    });

    test("handles zero and negative score values", () => {
      const input: ContributionInput = {
        ...MINIMAL_INPUT,
        scores: {
          zero: { value: 0, direction: ScoreDirection.Minimize },
          negative: { value: -42.5, direction: ScoreDirection.Maximize },
        },
      };
      const original = createContribution(input);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.scores?.zero?.value).toBe(0);
      expect(restored.scores?.negative?.value).toBe(-42.5);
    });

    test("handles multiple relations of different types", () => {
      const input: ContributionInput = {
        ...MINIMAL_INPUT,
        relations: [
          {
            targetCid: "blake3:1111111111111111111111111111111111111111111111111111111111111111",
            relationType: RelationType.DerivesFrom,
          },
          {
            targetCid: "blake3:2222222222222222222222222222222222222222222222222222222222222222",
            relationType: RelationType.Adopts,
          },
          {
            targetCid: "blake3:3333333333333333333333333333333333333333333333333333333333333333",
            relationType: RelationType.Reviews,
            metadata: { score: 5 },
          },
        ],
      };
      const original = createContribution(input);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.relations).toHaveLength(3);
      expect(restored.relations[0]?.relationType).toBe("derives_from");
      expect(restored.relations[1]?.relationType).toBe("adopts");
      expect(restored.relations[2]?.metadata).toEqual({ score: 5 });
    });

    test("handles score without unit", () => {
      const input: ContributionInput = {
        ...MINIMAL_INPUT,
        scores: { accuracy: { value: 0.95, direction: ScoreDirection.Maximize } },
      };
      const original = createContribution(input);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(restored.scores?.accuracy?.unit).toBeUndefined();
    });

    test("returns frozen object", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect(Object.isFrozen(restored)).toBe(true);
    });

    test("omits absent optional keys (no undefined-valued keys)", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const restored = fromManifest(manifest);
      expect("description" in restored).toBe(false);
      expect("scores" in restored).toBe(false);
      expect("context" in restored).toBe(false);
      expect("agentName" in restored.agent).toBe(false);
      expect("provider" in restored.agent).toBe(false);
    });
  });

  describe("validation — invalid inputs", () => {
    test("rejects null input", () => {
      expect(() => fromManifest(null)).toThrow();
    });

    test("rejects string input", () => {
      expect(() => fromManifest("not an object")).toThrow();
    });

    test("rejects empty object", () => {
      expect(() => fromManifest({})).toThrow();
    });

    test("rejects missing required field: kind", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      delete manifest.kind;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects missing required field: summary", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      delete manifest.summary;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects missing required field: agent", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      delete manifest.agent;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects missing required field: cid", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      delete manifest.cid;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects invalid kind value", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.kind = "invalid_kind";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects invalid mode value", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.mode = "invalid_mode";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects invalid relationType value", () => {
      const manifest = toManifest(
        createContribution({
          ...MINIMAL_INPUT,
          relations: [
            {
              targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              relationType: RelationType.DerivesFrom,
            },
          ],
        }),
      );
      const rels = manifest.relations as Record<string, unknown>[];
      const firstRel = rels[0];
      if (firstRel) firstRel.relationType = "invalid_type";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects NaN score value", () => {
      const manifest = toManifest(
        createContribution({
          ...MINIMAL_INPUT,
          scores: { metric: { value: 1.0, direction: ScoreDirection.Maximize } },
        }),
      );
      const scores = manifest.scores as Record<string, Record<string, unknown>>;
      const metric = scores.metric;
      if (metric) metric.value = Number.NaN;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects Infinity score value", () => {
      const manifest = toManifest(
        createContribution({
          ...MINIMAL_INPUT,
          scores: { metric: { value: 1.0, direction: ScoreDirection.Maximize } },
        }),
      );
      const scores = manifest.scores as Record<string, Record<string, unknown>>;
      const metric = scores.metric;
      if (metric) metric.value = Number.POSITIVE_INFINITY;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects wrong type for summary (number instead of string)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.summary = 42;
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects empty string for required string fields", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.summary = "";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects empty agentId", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      (manifest.agent as Record<string, unknown>).agentId = "";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects unknown fields (strict mode)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.unknownField = "should fail";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects unknown agent fields (strict mode)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      (manifest.agent as Record<string, unknown>).unknownField = "should fail";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects invalid CID format (too short)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.cid = "blake3:abc123";
      expect(() => fromManifest(manifest, { verify: false })).toThrow(/CID must be/);
    });

    test("rejects invalid CID format (wrong prefix)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.cid = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      expect(() => fromManifest(manifest, { verify: false })).toThrow(/CID must be/);
    });

    test("rejects invalid targetCid format in relations", () => {
      const manifest = toManifest(
        createContribution({
          ...MINIMAL_INPUT,
          relations: [
            {
              targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              relationType: RelationType.DerivesFrom,
            },
          ],
        }),
      );
      const rels = manifest.relations as Record<string, unknown>[];
      const firstRel = rels[0];
      if (firstRel) firstRel.targetCid = "not-a-cid";
      expect(() => fromManifest(manifest, { verify: false })).toThrow(/CID must be/);
    });

    test("rejects invalid createdAt (not ISO 8601)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.createdAt = "yesterday";
      expect(() => fromManifest(manifest)).toThrow();
    });

    test("rejects invalid createdAt (non-date string)", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.createdAt = "2026-13-45T99:99:99Z";
      expect(() => fromManifest(manifest)).toThrow();
    });
  });

  describe("CID integrity verification", () => {
    test("rejects tampered manifest by default", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.summary = "tampered summary";
      expect(() => fromManifest(manifest)).toThrow(/CID integrity check failed/);
    });

    test("allows tampered manifest with verify: false", () => {
      const manifest = toManifest(createContribution(MINIMAL_INPUT));
      manifest.summary = "tampered summary";
      const result = fromManifest(manifest, { verify: false });
      expect(result.summary).toBe("tampered summary");
    });

    test("passes valid manifest with verify: true (default)", () => {
      const original = createContribution(MINIMAL_INPUT);
      const manifest = toManifest(original);
      const result = fromManifest(manifest);
      expect(result.cid).toBe(original.cid);
    });
  });
});

// ---------------------------------------------------------------------------
// verifyCid
// ---------------------------------------------------------------------------

describe("verifyCid", () => {
  test("returns true for valid contribution", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(verifyCid(contribution)).toBe(true);
  });

  test("returns false for tampered contribution", () => {
    const contribution = createContribution(FULL_INPUT);
    const tampered: Contribution = { ...contribution, summary: "tampered" };
    expect(verifyCid(tampered)).toBe(false);
  });

  test("returns false for wrong CID", () => {
    const contribution = createContribution(FULL_INPUT);
    const wrongCid: Contribution = {
      ...contribution,
      cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(verifyCid(wrongCid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Relation-specific CID behavior
// ---------------------------------------------------------------------------

describe("relation-specific CID behavior", () => {
  test("relation order affects CID (relations are an ordered array, not a set)", () => {
    const relA = {
      targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relationType: RelationType.DerivesFrom,
    };
    const relB = {
      targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      relationType: RelationType.Reviews,
    };
    const cid1 = computeCid({ ...MINIMAL_INPUT, relations: [relA, relB] });
    const cid2 = computeCid({ ...MINIMAL_INPUT, relations: [relB, relA] });
    expect(cid1).not.toBe(cid2);
  });

  test("relation metadata key order does NOT affect CID (canonical JSON sorts keys)", () => {
    const rel1 = {
      targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relationType: RelationType.Reviews,
      metadata: { score: 0.9, verdict: "approved" },
    };
    const rel2 = {
      targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relationType: RelationType.Reviews,
      metadata: { verdict: "approved", score: 0.9 },
    };
    const cid1 = computeCid({ ...MINIMAL_INPUT, relations: [rel1] });
    const cid2 = computeCid({ ...MINIMAL_INPUT, relations: [rel2] });
    expect(cid1).toBe(cid2);
  });

  test("rejects invalid targetCid format — no prefix", () => {
    expect(() =>
      createContribution({
        ...MINIMAL_INPUT,
        relations: [{ targetCid: "not-a-valid-cid", relationType: RelationType.DerivesFrom }],
      }),
    ).toThrow();
  });

  test("rejects invalid targetCid format — wrong hash length", () => {
    expect(() =>
      createContribution({
        ...MINIMAL_INPUT,
        relations: [{ targetCid: "blake3:abc", relationType: RelationType.DerivesFrom }],
      }),
    ).toThrow();
  });

  test("rejects invalid targetCid format — uppercase hex", () => {
    expect(() =>
      createContribution({
        ...MINIMAL_INPUT,
        relations: [
          {
            targetCid: `blake3:${"A".repeat(64)}`,
            relationType: RelationType.DerivesFrom,
          },
        ],
      }),
    ).toThrow();
  });

  test("accepts valid targetCid format", () => {
    const contribution = createContribution({
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          relationType: RelationType.DerivesFrom,
        },
      ],
    });
    expect(contribution.relations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MANIFEST_VERSION
// ---------------------------------------------------------------------------

describe("MANIFEST_VERSION", () => {
  test("is 1", () => {
    expect(MANIFEST_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deep freeze (Codex fix 1)
// ---------------------------------------------------------------------------

describe("deep freeze", () => {
  test("nested tags array is frozen after createContribution", () => {
    const contribution = createContribution(MINIMAL_INPUT);
    expect(Object.isFrozen(contribution.tags)).toBe(true);
    expect(() => (contribution.tags as string[]).push("mutated")).toThrow();
  });

  test("nested agent object is frozen after createContribution", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(Object.isFrozen(contribution.agent)).toBe(true);
    expect(() => {
      (contribution.agent as { agentId: string }).agentId = "hacked";
    }).toThrow();
  });

  test("nested relations array is frozen after createContribution", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(Object.isFrozen(contribution.relations)).toBe(true);
    expect(() =>
      (contribution.relations as { targetCid: string; relationType: string }[]).push({
        targetCid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
        relationType: "derives_from",
      }),
    ).toThrow();
  });

  test("nested scores object is frozen after createContribution", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(contribution.scores).toBeDefined();
    expect(Object.isFrozen(contribution.scores)).toBe(true);
  });

  test("nested artifacts object is frozen after createContribution", () => {
    const contribution = createContribution(FULL_INPUT);
    expect(Object.isFrozen(contribution.artifacts)).toBe(true);
  });

  test("fromManifest returns deeply frozen object", () => {
    const original = createContribution(FULL_INPUT);
    const manifest = toManifest(original);
    const restored = fromManifest(manifest);
    expect(Object.isFrozen(restored.tags)).toBe(true);
    expect(Object.isFrozen(restored.agent)).toBe(true);
    expect(Object.isFrozen(restored.relations)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timezone offset support (Codex fix 2)
// ---------------------------------------------------------------------------

describe("timezone offset support", () => {
  test("createContribution accepts ISO 8601 with positive offset", () => {
    const input = { ...MINIMAL_INPUT, createdAt: "2026-03-08T10:00:00+05:30" };
    const contribution = createContribution(input);
    expect(contribution.createdAt).toBe("2026-03-08T10:00:00+05:30");
  });

  test("createContribution accepts ISO 8601 with negative offset", () => {
    const input = { ...MINIMAL_INPUT, createdAt: "2026-03-08T10:00:00-08:00" };
    const contribution = createContribution(input);
    expect(contribution.createdAt).toBe("2026-03-08T10:00:00-08:00");
  });

  test("fromManifest accepts ISO 8601 with offset", () => {
    const input = { ...MINIMAL_INPUT, createdAt: "2026-03-08T10:00:00+09:00" };
    const original = createContribution(input);
    const manifest = toManifest(original);
    const restored = fromManifest(manifest);
    expect(restored.createdAt).toBe("2026-03-08T10:00:00+09:00");
  });

  test("offset timestamps produce different CID than UTC", () => {
    const utcInput = { ...MINIMAL_INPUT, createdAt: "2026-03-08T10:00:00Z" };
    const offsetInput = { ...MINIMAL_INPUT, createdAt: "2026-03-08T10:00:00+05:00" };
    expect(computeCid(utcInput)).not.toBe(computeCid(offsetInput));
  });
});

// ---------------------------------------------------------------------------
// Input validation in createContribution (Codex fix 3)
// ---------------------------------------------------------------------------

describe("createContribution does not freeze caller-owned objects", () => {
  test("caller's nested context objects remain unfrozen", () => {
    const inner = { nested: "value" };
    const input = { ...MINIMAL_INPUT, context: { inner } };
    createContribution(input);
    expect(Object.isFrozen(inner)).toBe(false);
    inner.nested = "modified";
    expect(inner.nested).toBe("modified");
  });

  test("caller's relation metadata remains unfrozen", () => {
    const metadata = { confidence: 0.9, details: { source: "manual" } };
    const input = {
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          relationType: RelationType.DerivesFrom,
          metadata,
        },
      ],
    };
    createContribution(input);
    expect(Object.isFrozen(metadata)).toBe(false);
    expect(Object.isFrozen(metadata.details)).toBe(false);
    metadata.confidence = 0.5;
    expect(metadata.confidence).toBe(0.5);
  });

  test("caller's tags array remains unfrozen", () => {
    const tags = ["original"];
    const input = { ...MINIMAL_INPUT, tags };
    createContribution(input);
    expect(Object.isFrozen(tags)).toBe(false);
    tags.push("added");
    expect(tags).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// JSON-safe context/metadata validation (Codex fix — non-JSON values)
// ---------------------------------------------------------------------------

describe("JSON-safe context and metadata validation", () => {
  test("rejects Date in context", () => {
    const input = {
      ...MINIMAL_INPUT,
      context: { when: new Date("2026-01-01") },
    } as unknown as ContributionInput;
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects Map in context", () => {
    const input = {
      ...MINIMAL_INPUT,
      context: { data: new Map() },
    } as unknown as ContributionInput;
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects function in context", () => {
    const input = {
      ...MINIMAL_INPUT,
      context: { fn: () => 42 },
    } as unknown as ContributionInput;
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects Date in relation metadata", () => {
    const input = {
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          relationType: RelationType.DerivesFrom,
          metadata: { when: new Date("2026-01-01") },
        },
      ],
    } as unknown as ContributionInput;
    expect(() => createContribution(input)).toThrow();
  });

  test("accepts nested plain JSON objects in context", () => {
    const input = {
      ...MINIMAL_INPUT,
      context: { nested: { deep: { array: [1, "two", true, null] } } },
    };
    const contribution = createContribution(input);
    expect(contribution.context).toEqual(input.context);
  });

  test("accepts nested plain JSON objects in relation metadata", () => {
    const input = {
      ...MINIMAL_INPUT,
      relations: [
        {
          targetCid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          relationType: RelationType.DerivesFrom,
          metadata: { nested: { scores: [1, 2, 3] } },
        },
      ],
    };
    const contribution = createContribution(input);
    const firstRel = contribution.relations[0];
    expect(firstRel?.metadata).toEqual({ nested: { scores: [1, 2, 3] } });
  });
});

// ---------------------------------------------------------------------------
// createContribution input validation (Codex fix 3)
// ---------------------------------------------------------------------------

describe("createContribution input validation", () => {
  test("rejects empty summary", () => {
    const input = { ...MINIMAL_INPUT, summary: "" };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects invalid kind", () => {
    const input = { ...MINIMAL_INPUT, kind: "invalid" as ContributionKind };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects invalid mode", () => {
    const input = { ...MINIMAL_INPUT, mode: "invalid" as ContributionMode };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects invalid createdAt format", () => {
    const input = { ...MINIMAL_INPUT, createdAt: "not-a-date" };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects empty agentId", () => {
    const input = { ...MINIMAL_INPUT, agent: { agentId: "" } };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects NaN score value", () => {
    const input = {
      ...MINIMAL_INPUT,
      scores: { metric: { value: Number.NaN, direction: ScoreDirection.Maximize } },
    };
    expect(() => createContribution(input)).toThrow();
  });

  test("rejects Infinity score value", () => {
    const input = {
      ...MINIMAL_INPUT,
      scores: { metric: { value: Number.POSITIVE_INFINITY, direction: ScoreDirection.Maximize } },
    };
    expect(() => createContribution(input)).toThrow();
  });

  test("accepts valid minimal input", () => {
    expect(() => createContribution(MINIMAL_INPUT)).not.toThrow();
  });

  test("accepts valid full input", () => {
    expect(() => createContribution(FULL_INPUT)).not.toThrow();
  });
});
