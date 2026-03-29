/**
 * MCP tools for contribution operations — per-kind tools with strict required fields.
 *
 * grove_submit_work   — Submit work with artifacts (required)
 * grove_submit_review — Submit a review with scores (required, min 1)
 * grove_discuss       — Post a discussion or reply
 * grove_reproduce     — Submit a reproduction attempt
 * grove_adopt         — Adopt an existing contribution
 *
 * There is no generic "grove_contribute" tool. Each kind has its own tool
 * with strict required fields to prevent agents from skipping structured
 * data. The shared contributeOperation in the operations layer remains
 * as the internal backend — agents cannot call it directly.
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue, Relation, Score } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import {
  adoptOperation,
  contributeOperation,
  discussOperation,
  reproduceOperation,
  reviewOperation,
} from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps, toolValidationError } from "../operation-adapter.js";
import {
  agentSchema,
  artifactsSchema,
  relationSchema,
  reviewScoresSchema,
  scoreSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const submitWorkInputSchema = z.object({
  summary: z.string().describe("Short summary of the work performed"),
  description: z.string().optional().describe("Longer description of the work"),
  artifacts: artifactsSchema,
  mode: z
    .enum(["evaluation", "exploration"])
    .default("evaluation")
    .describe("Whether this work has measurable scores (evaluation) or is exploratory"),
  relations: z
    .array(relationSchema)
    .optional()
    .default([])
    .describe("Typed edges to other contributions (e.g., derives_from a parent contribution)"),
  scores: z
    .record(z.string(), scoreSchema)
    .optional()
    .describe("Named numeric scores for this work"),
  tags: z.array(z.string()).optional().default([]).describe("Free-form labels for filtering"),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Execution/evaluation context metadata (e.g., hardware, dataset)"),
  agent: agentSchema,
});

const submitReviewInputSchema = z.object({
  targetCid: z
    .string()
    .describe("CID of the contribution being reviewed. Find this via grove_frontier or grove_log."),
  summary: z.string().describe("Review summary — what you found, whether the work is acceptable"),
  description: z.string().optional().describe("Detailed review with specific feedback"),
  scores: reviewScoresSchema,
  tags: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Tags (e.g., 'code-review', 'security')"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Relation metadata attached to the 'reviews' edge (e.g., {score: 0.8})"),
});

const reproduceInputSchema = z.object({
  targetCid: z
    .string()
    .describe(
      "CID of the contribution being reproduced. Find this via grove_frontier or grove_log.",
    ),
  summary: z.string().describe("Reproduction summary — what you did and what happened"),
  description: z.string().optional().describe("Detailed reproduction report"),
  result: z
    .enum(["confirmed", "challenged", "partial"])
    .default("confirmed")
    .describe(
      "Reproduction result: confirmed (matches), challenged (differs), partial (some match)",
    ),
  scores: z.record(z.string(), scoreSchema).optional().describe("Reproduction measurement scores"),
  artifacts: z
    .record(z.string(), z.string())
    .optional()
    .default({})
    .describe("Reproduction artifacts — CAS content hashes of files produced during reproduction"),
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

const adoptInputSchema = z.object({
  targetCid: z
    .string()
    .describe("CID of the contribution being adopted. Find this via grove_frontier or grove_log."),
  summary: z
    .string()
    .describe("Why you are adopting this contribution — what you intend to build on it"),
  description: z.string().optional().describe("Detailed adoption rationale"),
  tags: z.array(z.string()).optional().default([]).describe("Tags"),
  context: z.record(z.string(), z.unknown()).optional().describe("Context metadata"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerContributionTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  // --- grove_submit_work ----------------------------------------------------
  server.registerTool(
    "grove_submit_work",
    {
      description:
        "Submit a work contribution with file artifacts. Use this after writing code, creating files, " +
        "running experiments, or completing any task that produces output. Artifacts are required — " +
        "without them, reviewers cannot inspect your files and the contribution has no checkable content. " +
        "If your work produced no files (e.g., configuration, benchmarks), pass an empty artifacts map " +
        "but include scores to capture measurements. Do NOT use grove_discuss or grove_submit_review " +
        "for submitting work — use this tool.",
      inputSchema: submitWorkInputSchema,
    },
    async (args) => {
      const artifacts = args.artifacts as Record<string, string>;
      const warning =
        Object.keys(artifacts).length === 0
          ? "No artifacts provided. Reviewers cannot inspect your work without file artifacts. " +
            "If you produced files, use grove_cas_put to store them in CAS first, then re-submit with their hashes."
          : undefined;

      const result = await contributeOperation(
        {
          kind: "work",
          summary: args.summary,
          artifacts,
          ...(args.mode !== undefined ? { mode: args.mode as "evaluation" | "exploration" } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          relations: args.relations as unknown as readonly Relation[],
          tags: args.tags,
          agent: withDefaultRole(args.agent as AgentOverrides),
        },
        opDeps,
      );
      return toMcpResult(result, warning);
    },
  );

  // --- grove_submit_review --------------------------------------------------
  server.registerTool(
    "grove_submit_review",
    {
      description:
        "Submit a review of an existing work contribution. Use this to evaluate another agent's work — " +
        "provide feedback, rate quality, and approve or request changes. You MUST provide a targetCid " +
        "(the CID of the contribution you are reviewing) and at least one score so the frontier can " +
        "rank contributions. Without scores, the frontier ranks by recency only and cannot distinguish " +
        "quality. Do NOT use grove_discuss for reviews — use this tool. Do NOT use grove_submit_work " +
        "to submit review feedback.",
      inputSchema: submitReviewInputSchema,
    },
    async (args) => {
      // Tool-level pre-validation: scores must have at least one entry
      const scores = args.scores as Readonly<Record<string, Score>>;
      if (scores === undefined || Object.keys(scores).length === 0) {
        return toolValidationError(
          "Reviews must include at least one score so the frontier can rank contributions. " +
            'Example: scores: {"correctness": {"value": 0.9, "direction": "maximize"}}',
        );
      }

      const result = await reviewOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          scores,
          tags: args.tags,
          agent: withDefaultRole(args.agent as AgentOverrides),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          ...(args.metadata !== undefined
            ? { metadata: args.metadata as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_reproduce ------------------------------------------------------
  server.registerTool(
    "grove_reproduce",
    {
      description:
        "Submit a reproduction attempt of an existing contribution. Use this when you have independently " +
        "re-run an experiment, re-tested code, or otherwise verified another agent's work. Reports " +
        "whether the result was confirmed (matches), challenged (differs), or partial (some matches). " +
        "Adds a 'reproduces' relation to the target. Do NOT use grove_submit_review for reproduction " +
        "attempts — use this tool.",
      inputSchema: reproduceInputSchema,
    },
    async (args) => {
      const result = await reproduceOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          artifacts: args.artifacts,
          tags: args.tags,
          agent: withDefaultRole(args.agent as AgentOverrides),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.result !== undefined
            ? { result: args.result as "confirmed" | "challenged" | "partial" }
            : {}),
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_discuss --------------------------------------------------------
  server.registerTool(
    "grove_discuss",
    {
      description:
        "Post a discussion message or reply to an existing contribution. Creates a contribution with " +
        "kind=discussion and mode=exploration. If targetCid is provided, adds a 'responds_to' relation " +
        "(threaded reply). If targetCid is omitted, creates a root discussion (topic anchor). " +
        "Use this for questions, clarifications, and open-ended discussion. Do NOT use grove_discuss " +
        "for code reviews — use grove_submit_review instead. For direct agent-to-agent messaging, " +
        "use grove_send_message.",
      inputSchema: discussInputSchema,
    },
    async (args) => {
      const result = await discussOperation(
        {
          summary: args.summary,
          tags: args.tags,
          agent: withDefaultRole(args.agent as AgentOverrides),
          ...(args.targetCid !== undefined ? { targetCid: args.targetCid } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_adopt ----------------------------------------------------------
  server.registerTool(
    "grove_adopt",
    {
      description:
        "Adopt an existing contribution to build upon it. Use this when you want to take another agent's " +
        "work as a starting point for your own. Creates an 'adopts' relation to the target, signaling " +
        "to the frontier that this contribution has been picked up. Adoption increases the target's " +
        "frontier rank. You MUST provide a targetCid — find it via grove_frontier or grove_log.",
      inputSchema: adoptInputSchema,
    },
    async (args) => {
      const result = await adoptOperation(
        {
          targetCid: args.targetCid,
          summary: args.summary,
          tags: args.tags,
          agent: withDefaultRole(args.agent as AgentOverrides),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
