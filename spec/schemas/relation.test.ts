import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RelationType } from "../../src/core/models.js";
import contributionSchema from "./contribution.json";
import relationSchema from "./relation.json";

/** Create a configured Ajv validator with the relation edge schema. */
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(relationSchema);
}

/** Create a configured Ajv validator for the contribution schema (standalone). */
function createContributionValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(contributionSchema);
}

/** Generate a valid blake3 CID for testing. Uses hex digit based on index. */
function validCid(index = 0): string {
  const hexDigit = "0123456789abcdef"[index % 16];
  return `blake3:${hexDigit.repeat(64)}`;
}

/** Minimal valid relation edge in wire format (snake_case). */
function validEdge(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    source_cid: validCid(0),
    target_cid: validCid(1),
    relation_type: "derives_from",
    created_at: "2026-03-08T10:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation — valid edges
// ---------------------------------------------------------------------------

describe("relation edge schema — valid edges", () => {
  const validate = createValidator();

  test("accepts minimal valid edge", () => {
    expect(validate(validEdge())).toBe(true);
  });

  test("accepts edge with metadata", () => {
    const edge = validEdge({
      metadata: { verdict: "approved", score: 0.95 },
    });
    expect(validate(edge)).toBe(true);
  });

  test("accepts edge with empty metadata", () => {
    const edge = validEdge({ metadata: {} });
    expect(validate(edge)).toBe(true);
  });

  test("accepts all relation types", () => {
    for (const relationType of ["derives_from", "responds_to", "reviews", "reproduces", "adopts"]) {
      const edge = validEdge({ relation_type: relationType });
      expect(validate(edge)).toBe(true);
    }
  });

  test("accepts timestamps with timezone offset", () => {
    const edge = validEdge({ created_at: "2026-03-08T10:00:00+05:30" });
    expect(validate(edge)).toBe(true);
  });

  test("accepts timestamps with fractional seconds", () => {
    const edge = validEdge({ created_at: "2026-03-08T10:00:00.123Z" });
    expect(validate(edge)).toBe(true);
  });

  test("accepts edge where source and target are different CIDs", () => {
    const edge = validEdge({
      source_cid: validCid(0),
      target_cid: validCid(1),
    });
    expect(validate(edge)).toBe(true);
  });

  test("accepts metadata with nested values", () => {
    const edge = validEdge({
      metadata: {
        review: { verdict: "approved", comments: ["looks good"] },
        score: 4.5,
      },
    });
    expect(validate(edge)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid edges
// ---------------------------------------------------------------------------

describe("relation edge schema — invalid edges", () => {
  const validate = createValidator();

  test("rejects missing required field: source_cid", () => {
    const { source_cid: _, ...edge } = validEdge();
    expect(validate(edge)).toBe(false);
  });

  test("rejects missing required field: target_cid", () => {
    const { target_cid: _, ...edge } = validEdge();
    expect(validate(edge)).toBe(false);
  });

  test("rejects missing required field: relation_type", () => {
    const { relation_type: _, ...edge } = validEdge();
    expect(validate(edge)).toBe(false);
  });

  test("rejects missing required field: created_at", () => {
    const { created_at: _, ...edge } = validEdge();
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid source_cid format — no prefix", () => {
    const edge = validEdge({ source_cid: "a".repeat(64) });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid source_cid format — wrong hash length", () => {
    const edge = validEdge({ source_cid: "blake3:abc" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid source_cid format — uppercase hex", () => {
    const edge = validEdge({ source_cid: `blake3:${"A".repeat(64)}` });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid target_cid format — no prefix", () => {
    const edge = validEdge({ target_cid: "a".repeat(64) });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid target_cid format — wrong hash length", () => {
    const edge = validEdge({ target_cid: "blake3:abc" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid relation type", () => {
    const edge = validEdge({ relation_type: "invalid_type" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects unknown properties", () => {
    const edge = validEdge({ unknown_field: "value" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects non-string source_cid", () => {
    const edge = validEdge({ source_cid: 12345 });
    expect(validate(edge)).toBe(false);
  });

  test("rejects non-string target_cid", () => {
    const edge = validEdge({ target_cid: null });
    expect(validate(edge)).toBe(false);
  });

  test("rejects non-object metadata", () => {
    const edge = validEdge({ metadata: "not-an-object" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects metadata array", () => {
    const edge = validEdge({ metadata: [1, 2, 3] });
    expect(validate(edge)).toBe(false);
  });

  test("rejects invalid created_at format", () => {
    const edge = validEdge({ created_at: "not-a-date" });
    expect(validate(edge)).toBe(false);
  });

  test("rejects created_at without timezone", () => {
    const edge = validEdge({ created_at: "2026-03-08T10:00:00" });
    expect(validate(edge)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — boundary cases
// ---------------------------------------------------------------------------

describe("relation edge schema — boundary cases", () => {
  const validate = createValidator();

  test("accepts metadata at maxProperties boundary (100)", () => {
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      metadata[`key_${i}`] = i;
    }
    const edge = validEdge({ metadata });
    expect(validate(edge)).toBe(true);
  });

  test("rejects metadata exceeding maxProperties (101)", () => {
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < 101; i++) {
      metadata[`key_${i}`] = i;
    }
    const edge = validEdge({ metadata });
    expect(validate(edge)).toBe(false);
  });

  test("accepts same CID for source and target (schema allows it)", () => {
    // Self-reference is impossible by CID construction in practice,
    // but the schema itself does not forbid it — that's a protocol-level invariant.
    const cid = validCid(0);
    const edge = validEdge({ source_cid: cid, target_cid: cid });
    expect(validate(edge)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enum sync: TypeScript RelationType ↔ JSON Schema relation_type
// ---------------------------------------------------------------------------

describe("relation type enum sync", () => {
  const relationEnum: readonly string[] = relationSchema.$defs.relation_type.enum;
  const contributionEnum: readonly string[] = (
    contributionSchema.$defs as Record<string, { enum: string[] }>
  ).relation_type.enum;
  const tsValues = Object.values(RelationType) as readonly string[];

  test("every TypeScript RelationType value exists in relation.json enum", () => {
    for (const value of tsValues) {
      expect(relationEnum).toContain(value);
    }
  });

  test("every relation.json enum value exists in TypeScript RelationType", () => {
    for (const value of relationEnum) {
      expect(tsValues).toContain(value);
    }
  });

  test("relation.json and TypeScript enum sets have the same size", () => {
    expect(tsValues.length).toBe(relationEnum.length);
  });

  test("relation.json and contribution.json relation_type enums are identical", () => {
    expect(relationEnum).toEqual(contributionEnum);
  });

  test("contribution.json compiles standalone without relation.json", () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(contributionSchema);
    const manifest = {
      cid: validCid(0),
      kind: "work",
      mode: "evaluation",
      summary: "Standalone test",
      artifacts: {},
      relations: [{ target_cid: validCid(1), relation_type: "derives_from" }],
      tags: [],
      agent: { agent_name: "test" },
      created_at: "2026-03-08T10:00:00Z",
    };
    expect(validate(manifest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-schema consistency: embedded relation + source_cid + created_at = valid edge
// ---------------------------------------------------------------------------

describe("cross-schema consistency", () => {
  const edgeValidate = createValidator();

  test("contribution.json validates embedded relations correctly", () => {
    const validate = createContributionValidator();
    const manifest = {
      cid: validCid(0),
      kind: "work",
      mode: "evaluation",
      summary: "Test contribution",
      artifacts: {},
      relations: [
        {
          target_cid: validCid(1),
          relation_type: "derives_from",
        },
      ],
      tags: [],
      agent: { agent_name: "test-agent" },
      created_at: "2026-03-08T10:00:00Z",
    };
    expect(validate(manifest)).toBe(true);
  });

  test("contribution.json rejects invalid relation types", () => {
    const validate = createContributionValidator();
    const manifest = {
      cid: validCid(0),
      kind: "work",
      mode: "evaluation",
      summary: "Test contribution",
      artifacts: {},
      relations: [
        {
          target_cid: validCid(1),
          relation_type: "invalid_type",
        },
      ],
      tags: [],
      agent: { agent_name: "test-agent" },
      created_at: "2026-03-08T10:00:00Z",
    };
    expect(validate(manifest)).toBe(false);
  });

  test("embedded relation + source_cid + created_at = valid full edge", () => {
    const embeddedRelation = {
      target_cid: validCid(1),
      relation_type: "reviews",
      metadata: { verdict: "approved" },
    };

    const fullEdge = {
      source_cid: validCid(0),
      created_at: "2026-03-08T10:00:00Z",
      ...embeddedRelation,
    };

    expect(edgeValidate(fullEdge)).toBe(true);
  });

  test("embedded relation without metadata + source_cid + created_at = valid full edge", () => {
    const embeddedRelation = {
      target_cid: validCid(2),
      relation_type: "adopts",
    };

    const fullEdge = {
      source_cid: validCid(0),
      created_at: "2026-03-08T10:00:00Z",
      ...embeddedRelation,
    };

    expect(edgeValidate(fullEdge)).toBe(true);
  });

  test("all five relation types work in both embedded and full-edge form", () => {
    const validate = createContributionValidator();
    const relationTypes = ["derives_from", "responds_to", "reviews", "reproduces", "adopts"];

    for (const relationType of relationTypes) {
      // Embedded form (in contribution)
      const manifest = {
        cid: validCid(0),
        kind: "work",
        mode: "evaluation",
        summary: "Test",
        artifacts: {},
        relations: [{ target_cid: validCid(1), relation_type: relationType }],
        tags: [],
        agent: { agent_name: "test" },
        created_at: "2026-03-08T10:00:00Z",
      };
      expect(validate(manifest)).toBe(true);

      // Full edge form
      const edge = validEdge({ relation_type: relationType });
      expect(edgeValidate(edge)).toBe(true);
    }
  });
});
