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
  direction: z.enum(["minimize", "maximize"]).describe("Whether lower or higher is better"),
  unit: z.string().optional().describe("Unit of measurement"),
});
