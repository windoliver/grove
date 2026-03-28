/**
 * MCP tools for contribution operations.
 *
 * grove_submit_work   — Submit a work contribution (replaces grove_contribute kind=work)
 * grove_submit_review — Submit a review of a contribution (replaces grove_review + kind=review)
 * grove_discuss       — Post a discussion or reply (replaces grove_contribute kind=discussion + grove_send_message)
 * grove_reproduce     — Submit a reproduction of a contribution (replaces grove_contribute kind=reproduction)
 * grove_done          — Signal that this agent has finished its work (replaces grove_contribute done=true)
 *
 * grove_contribute has been REMOVED to force agents to use structured per-kind tools.
 * Agents can no longer bypass required fields by calling grove_contribute with minimal args.
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

// ---------------------------------------------------------------------------
//grove_submit_work — replaces grove_contribute(kind=work)
// ---------------------------------------------------------------------------
const submitWorkInputSchema = z.object({
  summary: z.string().describe("Short summary of the work completed"),
  description: z.string().optional().describe("Longer description of the work"),
  artifacts: z
    .record(z.string(), z.string())
    .describe(
      "File artifacts produced by this work. Map of path to content hash (blake3:<hex64>). " +
        'Example: {"src/index.ts": "blake3:abc123...", "README.md": "blake3:def456..."}. ' +
        "Without artifacts, reviewers cannot see your files and will reject the work.",
    ),
  relations: z
    .array(relationSchema)
    .optional()
    .default([])
    .describe("Typed edges to other contributions (e.g., derives_from a previous work)"),
  scores: z.record(z.string(), scoreSchema).optional().describe("Named numeric scores"),
  tags: z.array(z.string()).optional().default([]).describe("Free-form labels for filtering"),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Execution/evaluation context metadata"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
//grove_submit_review — replaces grove_review + grove_contribute(kind=review)
// ---------------------------------------------------------------------------
const submitReviewInputSchema = z.object({
  targetCid: z.string().describe("CID of the contribution being reviewed"),
  summary: z.string().describe("Review summary — what did you find?"),
  description: z.string().optional().describe("Detailed review with specific feedback"),
  scores: z
    .record(z.string(), scoreSchema)
    .describe(
      "Review scores. At least one score is required. " +
        'Example: {"correctness": {"value": 0.9, "direction": "maximize"}, "clarity": {"value": 0.8, "direction": "maximize"}}',
    ),
  tags: z.array(z.string()).optional().default([]).describe("Tags"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Relation metadata (e.g., {score: 0.8})"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
//grove_discuss — replaces grove_contribute(kind=discussion) + grove_send_message
// ---------------------------------------------------------------------------
const discussInputSchema = z.object({
  targetCid: z
    .string()
    .optional()
    .describe("CID of the contribution to reply to. Omit for root discussions (topic anchors)."),
  summary: z.string().describe("Discussion message or reply text"),
  description: z.string().optional().describe("Longer description"),
  tags: z.array(z.string()).optional().default([]).describe("Tags for channel semantics"),
  recipients: z
    .array(z.string())
    .optional()
    .describe("Recipient handles for mentions (e.g., @claude-eng). Use @all for broadcast."),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
//grove_reproduce — replaces grove_contribute(kind=reproduction)
// ---------------------------------------------------------------------------
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

  // --- grove_submit_work ---------------------------------------------------
  server.registerTool(
    "grove_submit_work",
    {
      description:
        "Submit a work contribution. This is the ONLY way to submit completed work. " +
        "You MUST include artifacts (file hashes) so reviewers can inspect your code. " +
        "Without artifacts, reviewers cannot see your work and will not approve it. " +
        "Use this when you have finished implementing something.",
      inputSchema: submitWorkInputSchema,
    },
    async (args) => {
      const result = await contributeOperation(
        {
          kind: "work",
          mode: "evaluation",
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

  // --- grove_submit_review -------------------------------------------------
  server.registerTool(
    "grove_submit_review",
    {
      description:
        "Submit a review of an existing contribution. This is the ONLY way to submit a review. " +
        "You MUST include at least one score and the target CID. " +
        "Scores are required so the frontier can rank contributions by quality. " +
        "Use this when you have reviewed someone's work and want to give feedback.",
      inputSchema: submitReviewInputSchema,
    },
    async (args) => {
      const result = await reviewOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          scores: args.scores as Readonly<Record<string, Score>>,
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

  // --- grove_discuss ------------------------------------------------------
  server.registerTool(
    "grove_discuss",
    {
      description:
        "Post a discussion or reply to an existing contribution. Creates a contribution with " +
        "kind=discussion and mode=exploration. If targetCid is provided, adds a 'responds_to' " +
        "relation (reply). If omitted, creates a root discussion (topic anchor). " +
        "Use 'recipients' for @mentions (e.g., @all for broadcast). " +
        "This also replaces grove_send_message — use this for messaging other agents.",
      inputSchema: discussInputSchema,
    },
    async (args) => {
      const result = await discussOperation(
        {
          summary: args.summary,
          ...(args.targetCid !== undefined ? { targetCid: args.targetCid } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          tags: args.tags,
          ...(args.recipients !== undefined ? { recipients: args.recipients } : {}),
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

  // --- grove_reproduce ----------------------------------------------------
  server.registerTool(
    "grove_reproduce",
    {
      description:
        "Submit a reproduction attempt of an existing contribution. Reports whether the " +
        "result was confirmed, challenged, or partial. Adds a 'reproduces' relation to the target. " +
        "Use this when you need to verify that someone's work can be reproduced.",
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
}
