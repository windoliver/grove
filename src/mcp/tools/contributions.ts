/**
 * MCP tools for contribution operations.
 *
 * grove_contribute — Submit a contribution with artifacts
 * grove_review     — Submit a review of a contribution (sugar over contribute)
 * grove_reproduce  — Submit a reproduction of a contribution (sugar over contribute)
 * grove_discuss    — Post a discussion or reply (sugar over contribute)
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue, Relation, Score } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import {
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";
import { agentSchema, relationSchema, scoreSchema } from "../schemas.js";

const contributeInputSchema = z.object({
  kind: z
    .enum([
      "work",
      "review",
      "discussion",
      "adoption",
      "reproduction",
      "plan",
      "ask_user",
      "response",
    ])
    .describe("Contribution kind"),
  mode: z
    .enum(["evaluation", "exploration"])
    .default("evaluation")
    .describe("Whether this contribution has measurable scores (evaluation) or is exploratory"),
  summary: z.string().describe("Short summary of the contribution"),
  description: z.string().optional().describe("Longer description"),
  artifacts: z
    .record(z.string(), z.string())
    .optional()
    .default({})
    .describe(
      "Map of artifact name to content hash (blake3:<hex64>). Artifacts must already exist in CAS.",
    ),
  relations: z
    .array(relationSchema)
    .optional()
    .default([])
    .describe("Typed edges to other contributions"),
  scores: z.record(z.string(), scoreSchema).optional().describe("Named numeric scores"),
  tags: z.array(z.string()).optional().default([]).describe("Free-form labels for filtering"),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Execution/evaluation context metadata"),
  agent: agentSchema,
});

const reviewInputSchema = z.object({
  targetCid: z.string().describe("CID of the contribution being reviewed"),
  summary: z.string().describe("Review summary"),
  description: z.string().optional().describe("Detailed review"),
  scores: z.record(z.string(), scoreSchema).optional().describe("Review scores"),
  tags: z.array(z.string()).optional().default([]).describe("Tags"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Relation metadata (e.g., {score: 0.8})"),
});

const reproduceInputSchema = z.object({
  targetCid: z.string().describe("CID of the contribution being reproduced"),
  summary: z.string().describe("Reproduction summary"),
  description: z.string().optional().describe("Detailed reproduction report"),
  result: z
    .enum(["confirmed", "challenged", "partial"])
    .default("confirmed")
    .describe("Reproduction result"),
  scores: z.record(z.string(), scoreSchema).optional().describe("Reproduction scores"),
  artifacts: z
    .record(z.string(), z.string())
    .optional()
    .default({})
    .describe("Reproduction artifacts (content hashes)"),
  tags: z.array(z.string()).optional().default([]).describe("Tags"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
});

const discussInputSchema = z.object({
  targetCid: z
    .string()
    .optional()
    .describe("CID of the contribution to reply to. Omit for root discussions (topic anchors)."),
  summary: z.string().describe("Discussion message"),
  description: z.string().optional().describe("Longer description"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for channel semantics"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Inject GROVE_AGENT_ROLE into agent overrides if not already set.
 * Falls back to extracting role from agentId pattern "role-timestamp".
 */
function withDefaultRole(agent: AgentOverrides | undefined): AgentOverrides {
  if (agent?.role) return agent;
  const envRole = process.env.GROVE_AGENT_ROLE;
  if (envRole) return { ...agent, role: envRole } as AgentOverrides;
  // Fallback: extract role from agentId if it matches "role-xxx" pattern
  const agentId = agent?.agentId;
  if (agentId?.includes("-")) {
    const role = agentId.replace(/-[a-z0-9]+$/i, "");
    if (role && role !== agentId) return { ...agent, role } as AgentOverrides;
  }
  return agent ?? {};
}

export function registerContributionTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  // --- grove_contribute ---------------------------------------------------
  server.registerTool(
    "grove_contribute",
    {
      description:
        "Submit a contribution to the grove. Contributions are immutable units of work " +
        "(code, reviews, discussions, adoptions, reproductions) that form a DAG. " +
        "Artifacts must be pre-stored in CAS; pass their content hashes in the artifacts map.",
      inputSchema: contributeInputSchema,
    },
    async (args) => {
      const result = await contributeOperation(
        {
          kind: args.kind as
            | "work"
            | "review"
            | "discussion"
            | "adoption"
            | "reproduction"
            | "plan"
            | "ask_user"
            | "response",
          ...(args.mode !== undefined ? { mode: args.mode as "evaluation" | "exploration" } : {}),
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          artifacts: args.artifacts,
          relations: args.relations as unknown as readonly Relation[],
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: withDefaultRole(args.agent as AgentOverrides),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_review -------------------------------------------------------
  server.registerTool(
    "grove_review",
    {
      description:
        "Submit a review of an existing contribution. This is a convenience tool that creates " +
        "a contribution with kind=review and a 'reviews' relation to the target.",
      inputSchema: reviewInputSchema,
    },
    async (args) => {
      const result = await reviewOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: withDefaultRole(args.agent as AgentOverrides),
          ...(args.metadata !== undefined
            ? { metadata: args.metadata as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_reproduce ----------------------------------------------------
  server.registerTool(
    "grove_reproduce",
    {
      description:
        "Submit a reproduction attempt of an existing contribution. Reports whether the " +
        "result was confirmed, challenged, or partial. Adds a 'reproduces' relation to the target.",
      inputSchema: reproduceInputSchema,
    },
    async (args) => {
      const result = await reproduceOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.result !== undefined
            ? { result: args.result as "confirmed" | "challenged" | "partial" }
            : {}),
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          artifacts: args.artifacts,
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: withDefaultRole(args.agent as AgentOverrides),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_discuss ------------------------------------------------------
  server.registerTool(
    "grove_discuss",
    {
      description:
        "Post a discussion or reply to an existing contribution. Creates a contribution with " +
        "kind=discussion and mode=exploration. If targetCid is provided, adds a 'responds_to' " +
        "relation (reply). If omitted, creates a root discussion (topic anchor).",
      inputSchema: discussInputSchema,
    },
    async (args) => {
      const result = await discussOperation(
        {
          summary: args.summary,
          ...(args.targetCid !== undefined ? { targetCid: args.targetCid } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: withDefaultRole(args.agent as AgentOverrides),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
