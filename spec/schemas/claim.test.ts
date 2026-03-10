import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import claimSchema from "./claim.json";
import contributionSchema from "./contribution.json";

/** Create a configured Ajv validator with the claim schema. */
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(claimSchema);
}

/** Minimal valid claim in wire format (snake_case). */
function validClaim(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    claim_id: "claim-abc-123",
    target_ref: "optimize-attention-kernel",
    agent: { agent_id: "research-agent-001" },
    status: "active",
    intent_summary: "Exploring attention optimizations on H100",
    created_at: "2026-01-15T10:00:00Z",
    heartbeat_at: "2026-01-15T10:02:00Z",
    lease_expires_at: "2026-01-15T10:05:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation — valid claims
// ---------------------------------------------------------------------------

describe("claim schema — valid claims", () => {
  const validate = createValidator();

  test("accepts minimal valid claim (agent_id only, no context)", () => {
    expect(validate(validClaim())).toBe(true);
  });

  test("accepts claim with agent_id and agent_name", () => {
    const claim = validClaim({
      agent: { agent_id: "agent-001", agent_name: "Research Agent" },
    });
    expect(validate(claim)).toBe(true);
  });

  test("accepts claim with all fields", () => {
    const claim = validClaim({
      context: { branch: "feat/attention", priority: 5 },
    });
    expect(validate(claim)).toBe(true);
  });

  test("accepts all valid statuses", () => {
    for (const status of ["active", "released", "expired", "completed"]) {
      expect(validate(validClaim({ status }))).toBe(true);
    }
  });

  test("accepts claim with full agent identity", () => {
    const claim = validClaim({
      agent: {
        agent_id: "agent-007",
        agent_name: "Research Agent",
        provider: "anthropic",
        model: "claude-opus-4-6",
        version: "1.0.0",
        toolchain: "claude-code",
        runtime: "bun-1.3.9",
        platform: "H100",
      },
    });
    expect(validate(claim)).toBe(true);
  });

  test("accepts claim with structured target_ref", () => {
    const refs = [
      "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "task-1/implementation",
      "task-1/testing",
      "optimize-attention-kernel",
      "simple-task",
    ];
    for (const ref of refs) {
      expect(validate(validClaim({ target_ref: ref }))).toBe(true);
    }
  });

  test("accepts claim with empty context object", () => {
    expect(validate(validClaim({ context: {} }))).toBe(true);
  });

  test("accepts claim with nested context values", () => {
    const claim = validClaim({
      context: {
        workflow: "autoresearch",
        config: { model: "claude-opus-4-6", budget: 100 },
        tags: ["ml", "nlp"],
        nullable: null,
        flag: true,
      },
    });
    expect(validate(claim)).toBe(true);
  });

  test("accepts claim with timezone-offset timestamps", () => {
    const claim = validClaim({
      created_at: "2026-01-15T10:00:00+05:30",
      heartbeat_at: "2026-01-15T10:02:00-08:00",
      lease_expires_at: "2026-01-15T10:05:00+00:00",
    });
    expect(validate(claim)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — invalid claims
// ---------------------------------------------------------------------------

describe("claim schema — invalid claims", () => {
  const validate = createValidator();

  // Missing required fields
  test("rejects missing claim_id", () => {
    const { claim_id: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing target_ref", () => {
    const { target_ref: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing agent", () => {
    const { agent: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing status", () => {
    const { status: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing intent_summary", () => {
    const { intent_summary: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing created_at", () => {
    const { created_at: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing heartbeat_at", () => {
    const { heartbeat_at: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects missing lease_expires_at", () => {
    const { lease_expires_at: _, ...claim } = validClaim();
    expect(validate(claim)).toBe(false);
  });

  test("rejects empty object", () => {
    expect(validate({})).toBe(false);
  });

  // Type validation
  test("rejects invalid status value", () => {
    expect(validate(validClaim({ status: "pending" }))).toBe(false);
  });

  test("rejects non-string claim_id", () => {
    expect(validate(validClaim({ claim_id: 123 }))).toBe(false);
  });

  test("rejects empty claim_id", () => {
    expect(validate(validClaim({ claim_id: "" }))).toBe(false);
  });

  test("rejects empty target_ref", () => {
    expect(validate(validClaim({ target_ref: "" }))).toBe(false);
  });

  test("rejects empty intent_summary", () => {
    expect(validate(validClaim({ intent_summary: "" }))).toBe(false);
  });

  // Timestamp validation
  test("rejects invalid created_at format", () => {
    expect(validate(validClaim({ created_at: "not-a-date" }))).toBe(false);
  });

  test("rejects invalid heartbeat_at format", () => {
    expect(validate(validClaim({ heartbeat_at: "2026-13-01T00:00:00Z" }))).toBe(false);
  });

  test("rejects invalid lease_expires_at format", () => {
    expect(validate(validClaim({ lease_expires_at: "yesterday" }))).toBe(false);
  });

  // Agent validation — agent_id is required
  test("rejects agent without agent_id", () => {
    expect(validate(validClaim({ agent: {} }))).toBe(false);
  });

  test("rejects agent with only agent_name (missing agent_id)", () => {
    expect(validate(validClaim({ agent: { agent_name: "Research Agent" } }))).toBe(false);
  });

  test("rejects agent with empty agent_id", () => {
    expect(validate(validClaim({ agent: { agent_id: "" } }))).toBe(false);
  });

  test("rejects agent with unknown properties", () => {
    expect(validate(validClaim({ agent: { agent_id: "test", unknown: "value" } }))).toBe(false);
  });

  // Strict mode — no unknown properties
  test("rejects unknown properties on claim", () => {
    expect(validate(validClaim({ unknown_field: "value" }))).toBe(false);
  });

  // claim_id length
  test("rejects claim_id exceeding max length", () => {
    expect(validate(validClaim({ claim_id: "x".repeat(257) }))).toBe(false);
  });

  // target_ref length
  test("rejects target_ref exceeding max length", () => {
    expect(validate(validClaim({ target_ref: "x".repeat(1025) }))).toBe(false);
  });

  // intent_summary length
  test("rejects intent_summary exceeding max length", () => {
    expect(validate(validClaim({ intent_summary: "x".repeat(1025) }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-schema consistency
// ---------------------------------------------------------------------------

describe("cross-schema consistency", () => {
  test("claim agent_identity has same properties as contribution agent_identity", () => {
    const claimAgentProps = claimSchema.$defs.agent_identity.properties;
    const contributionAgentProps = (
      contributionSchema.$defs as { agent_identity: { properties: Record<string, unknown> } }
    ).agent_identity.properties;

    expect(Object.keys(claimAgentProps).sort()).toEqual(Object.keys(contributionAgentProps).sort());
  });

  test("claim agent_identity has same required fields as contribution agent_identity", () => {
    const claimRequired = claimSchema.$defs.agent_identity.required;
    const contributionRequired = (
      contributionSchema.$defs as { agent_identity: { required: string[] } }
    ).agent_identity.required;

    expect(claimRequired).toEqual(contributionRequired);
  });

  test("both schemas require agent_id (not agent_name)", () => {
    const claimRequired = claimSchema.$defs.agent_identity.required;
    expect(claimRequired).toContain("agent_id");
    expect(claimRequired).not.toContain("agent_name");
  });

  test("claim status enum matches expected lifecycle states", () => {
    const statuses = claimSchema.$defs.claim_status.enum;
    expect(statuses).toEqual(["active", "released", "expired", "completed"]);
  });
});
