/**
 * Shared Zod schemas for MCP tool inputs.
 *
 * Extracted from individual tool files to avoid duplication.
 * All MCP tools that accept agent identity, relations, or scores
 * import these schemas.
 */

import { z } from "zod";

/** Agent identity schema — optional, auto-resolved from env vars if omitted. */
export const agentSchema: z.ZodTypeAny = z
  .object({
    agentId: z
      .string()
      .optional()
      .describe("Unique agent identifier (default: GROVE_AGENT_ID env var or hostname-pid)"),
    agentName: z.string().optional().describe("Human-readable agent name"),
    provider: z.string().optional().describe("Agent provider (e.g., anthropic, openai)"),
    model: z.string().optional().describe("Model identifier"),
    platform: z.string().optional().describe("Platform (e.g., darwin, linux)"),
    version: z.string().optional().describe("Agent version"),
    toolchain: z.string().optional().describe("Toolchain (e.g., claude-code, codex)"),
    runtime: z.string().optional().describe("Runtime environment"),
    role: z.string().optional().describe("Agent role (e.g., reviewer, contributor, orchestrator)"),
  })
  .optional()
  .describe(
    "Agent identity. Optional — if omitted, resolved from GROVE_AGENT_* env vars or defaults to hostname-pid.",
  );

/** Typed relation to another contribution. */
export const relationSchema: z.ZodTypeAny = z.object({
  targetCid: z.string().describe("CID of the target contribution"),
  relationType: z
    .enum(["derives_from", "responds_to", "reviews", "reproduces", "adopts"])
    .describe("Type of relation"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional relation metadata"),
});

/** Named numeric score with direction. */
export const scoreSchema: z.ZodTypeAny = z.object({
  value: z.number().describe("Numeric score value"),
  direction: z
    .enum(["minimize", "maximize"])
    .describe("Whether lower or higher is better for this metric"),
  unit: z.string().optional().describe("Unit of measurement (e.g., 'ms', 'percent', 'lines')"),
});

/**
 * Artifacts schema — map of file path to CAS content hash.
 *
 * Used by grove_submit_work to attach file artifacts to contributions.
 * Artifacts must be pre-stored in CAS (via grove_cas_put); pass their
 * blake3 content hashes here.
 */
export const artifactsSchema = z
  .record(z.string(), z.string())
  .describe(
    "File artifacts as a map of path to CAS content hash (blake3:<hex64>). " +
      "Artifacts must already exist in CAS — use grove_cas_put to store them first. " +
      'Example: {"src/main.ts": "blake3:a1b2c3..."}. ' +
      "Without artifacts, reviewers cannot inspect your files.",
  );

/**
 * Scores schema for reviews — requires at least one named score.
 *
 * Each score has a numeric value and direction (minimize/maximize).
 * The frontier uses these scores to rank contributions.
 */
export const reviewScoresSchema = z
  .record(z.string(), scoreSchema)
  .refine((scores) => Object.keys(scores).length >= 1, {
    message:
      "Reviews must include at least one score. " +
      'Example: {"correctness": {"value": 0.9, "direction": "maximize"}}',
  })
  .describe(
    "Named scores for the review. At least one score is required so the frontier can rank contributions. " +
      'Example: {"correctness": {"value": 0.9, "direction": "maximize"}, "style": {"value": 0.8, "direction": "maximize"}}',
  );
