/**
 * MCP tools for contribution operations.
 *
 * grove_contribute — Submit a contribution with artifacts
 * grove_review     — Submit a review of a contribution (sugar over contribute)
 * grove_reproduce  — Submit a reproduction of a contribution (sugar over contribute)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createContribution } from "../../core/manifest.js";
import type { ContributionInput, JsonValue, Relation, Score } from "../../core/models.js";
import { ContributionKind, ContributionMode, RelationType } from "../../core/models.js";
import type { AgentInput } from "../agent-identity.js";
import { resolveAgentIdentity } from "../agent-identity.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError, validationError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const agentSchema = z
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

const relationSchema = z.object({
  targetCid: z.string().describe("CID of the target contribution"),
  relationType: z
    .enum(["derives_from", "responds_to", "reviews", "reproduces", "adopts"])
    .describe("Type of relation"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional relation metadata"),
});

const scoreSchema = z.object({
  value: z.number().describe("Numeric score value"),
  direction: z.enum(["minimize", "maximize"]).describe("Whether lower or higher is better"),
  unit: z.string().optional().describe("Unit of measurement"),
});

const contributeInputSchema = z.object({
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction"])
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerContributionTools(server: McpServer, deps: McpDeps): void {
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
      try {
        const { contributionStore, cas } = deps;

        // Validate artifact hashes exist in CAS
        for (const [name, hash] of Object.entries(args.artifacts)) {
          const exists = await cas.exists(hash);
          if (!exists) {
            return validationError(`Artifact '${name}' references non-existent hash: ${hash}`);
          }
        }

        // Validate relation target CIDs exist
        for (const rel of args.relations) {
          const target = await contributionStore.get(rel.targetCid);
          if (target === undefined) {
            return validationError(`Relation target not found: ${rel.targetCid}`);
          }
        }

        const now = new Date().toISOString();
        const input: ContributionInput = {
          kind: args.kind as ContributionInput["kind"],
          mode: args.mode as ContributionInput["mode"],
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          artifacts: args.artifacts,
          relations: args.relations as readonly Relation[],
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: resolveAgentIdentity(args.agent as AgentInput),
          createdAt: now,
        };

        const contribution = createContribution(input);
        await contributionStore.put(contribution);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid: contribution.cid,
                kind: contribution.kind,
                mode: contribution.mode,
                summary: contribution.summary,
                artifactCount: Object.keys(contribution.artifacts).length,
                relationCount: contribution.relations.length,
                createdAt: contribution.createdAt,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
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
      try {
        const { contributionStore } = deps;

        // Validate target exists
        const target = await contributionStore.get(args.targetCid);
        if (target === undefined) {
          return notFoundError("Contribution", args.targetCid);
        }

        const relations: Relation[] = [
          {
            targetCid: args.targetCid,
            relationType: RelationType.Reviews,
            ...(args.metadata !== undefined
              ? { metadata: args.metadata as Readonly<Record<string, JsonValue>> }
              : {}),
          },
        ];

        const now = new Date().toISOString();
        const input: ContributionInput = {
          kind: ContributionKind.Review,
          mode: ContributionMode.Evaluation,
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          artifacts: {},
          relations,
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: resolveAgentIdentity(args.agent as AgentInput),
          createdAt: now,
        };

        const contribution = createContribution(input);
        await contributionStore.put(contribution);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid: contribution.cid,
                kind: "review",
                targetCid: args.targetCid,
                summary: contribution.summary,
                createdAt: contribution.createdAt,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
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
      try {
        const { contributionStore, cas } = deps;

        // Validate target exists
        const target = await contributionStore.get(args.targetCid);
        if (target === undefined) {
          return notFoundError("Contribution", args.targetCid);
        }

        // Validate artifact hashes
        for (const [name, hash] of Object.entries(args.artifacts)) {
          const exists = await cas.exists(hash);
          if (!exists) {
            return validationError(`Artifact '${name}' references non-existent hash: ${hash}`);
          }
        }

        const relations: Relation[] = [
          {
            targetCid: args.targetCid,
            relationType: RelationType.Reproduces,
            metadata: { result: args.result } as Readonly<Record<string, JsonValue>>,
          },
        ];

        const now = new Date().toISOString();
        const input: ContributionInput = {
          kind: ContributionKind.Reproduction,
          mode: ContributionMode.Evaluation,
          summary: args.summary,
          ...(args.description !== undefined ? { description: args.description } : {}),
          artifacts: args.artifacts,
          relations,
          ...(args.scores !== undefined
            ? { scores: args.scores as Readonly<Record<string, Score>> }
            : {}),
          tags: args.tags,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          agent: resolveAgentIdentity(args.agent as AgentInput),
          createdAt: now,
        };

        const contribution = createContribution(input);
        await contributionStore.put(contribution);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid: contribution.cid,
                kind: "reproduction",
                targetCid: args.targetCid,
                result: args.result,
                summary: contribution.summary,
                createdAt: contribution.createdAt,
              }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
