/**
 * MCP tools for contribution operations.
 *
 * grove_contribute — Submit a contribution with artifacts
 * grove_review     — Submit a review of a contribution (sugar over contribute)
 * grove_reproduce  — Submit a reproduction of a contribution (sugar over contribute)
 * grove_discuss    — Post a discussion or reply (sugar over contribute)
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
import { agentSchema, relationSchema, scoreSchema } from "../schemas.js";

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
// Shared sugar helper
// ---------------------------------------------------------------------------

/** Options for creating a sugar contribution (review, reproduce, discuss). */
interface SugarContributionOptions {
  readonly kind: ContributionInput["kind"];
  readonly mode: ContributionInput["mode"];
  readonly summary: string;
  readonly description?: string | undefined;
  readonly relations: readonly Relation[];
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: AgentInput | undefined;
}

/**
 * Create and store a sugar contribution. Shared logic for review, reproduce, discuss.
 * Validates target CIDs exist, builds ContributionInput, creates contribution, stores it.
 */
async function createSugarContribution(
  deps: McpDeps,
  options: SugarContributionOptions,
): Promise<{ cid: string; contribution: ReturnType<typeof createContribution> }> {
  const { contributionStore, cas } = deps;

  // Validate relation target CIDs exist
  for (const rel of options.relations) {
    const target = await contributionStore.get(rel.targetCid);
    if (target === undefined) {
      throw new TargetNotFoundError(rel.targetCid);
    }
  }

  // Validate artifact hashes exist in CAS
  if (options.artifacts) {
    for (const [name, hash] of Object.entries(options.artifacts)) {
      const exists = await cas.exists(hash);
      if (!exists) {
        throw new ArtifactNotFoundError(name, hash);
      }
    }
  }

  const now = new Date().toISOString();
  const input: ContributionInput = {
    kind: options.kind,
    mode: options.mode,
    summary: options.summary,
    ...(options.description !== undefined ? { description: options.description } : {}),
    artifacts: options.artifacts ?? {},
    relations: options.relations,
    ...(options.scores !== undefined ? { scores: options.scores } : {}),
    tags: [...options.tags],
    ...(options.context !== undefined ? { context: options.context } : {}),
    agent: resolveAgentIdentity(options.agent),
    createdAt: now,
  };

  const contribution = createContribution(input);
  await contributionStore.put(contribution);
  deps.onContributionWrite?.();

  return { cid: contribution.cid, contribution };
}

/** Sentinel error for target-not-found in sugar contributions. */
class TargetNotFoundError extends Error {
  readonly targetCid: string;
  constructor(targetCid: string) {
    super(`Contribution not found: ${targetCid}`);
    this.targetCid = targetCid;
  }
}

/** Sentinel error for artifact-not-found in sugar contributions. */
class ArtifactNotFoundError extends Error {
  readonly artifactName: string;
  readonly hash: string;
  constructor(name: string, hash: string) {
    super(`Artifact '${name}' references non-existent hash: ${hash}`);
    this.artifactName = name;
    this.hash = hash;
  }
}

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
        for (const rel of args.relations as Array<{ targetCid: string }>) {
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
          relations: args.relations as unknown as readonly Relation[],
          ...(args.scores !== undefined
            ? { scores: args.scores as unknown as Readonly<Record<string, Score>> }
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
        deps.onContributionWrite?.();

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
        const relations: Relation[] = [
          {
            targetCid: args.targetCid,
            relationType: RelationType.Reviews,
            ...(args.metadata !== undefined
              ? { metadata: args.metadata as Readonly<Record<string, JsonValue>> }
              : {}),
          },
        ];

        const { cid, contribution } = await createSugarContribution(deps, {
          kind: ContributionKind.Review,
          mode: ContributionMode.Evaluation,
          summary: args.summary,
          description: args.description,
          relations,
          scores: args.scores as Readonly<Record<string, Score>> | undefined,
          tags: args.tags,
          context: args.context as Readonly<Record<string, JsonValue>> | undefined,
          agent: args.agent as AgentInput,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid,
                kind: "review",
                targetCid: args.targetCid,
                summary: contribution.summary,
                createdAt: contribution.createdAt,
              }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof TargetNotFoundError) {
          return notFoundError("Contribution", error.targetCid);
        }
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
        const relations: Relation[] = [
          {
            targetCid: args.targetCid,
            relationType: RelationType.Reproduces,
            metadata: { result: args.result } as Readonly<Record<string, JsonValue>>,
          },
        ];

        const { cid, contribution } = await createSugarContribution(deps, {
          kind: ContributionKind.Reproduction,
          mode: ContributionMode.Evaluation,
          summary: args.summary,
          description: args.description,
          relations,
          artifacts: args.artifacts,
          scores: args.scores as Readonly<Record<string, Score>> | undefined,
          tags: args.tags,
          context: args.context as Readonly<Record<string, JsonValue>> | undefined,
          agent: args.agent as AgentInput,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid,
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
        if (error instanceof TargetNotFoundError) {
          return notFoundError("Contribution", error.targetCid);
        }
        if (error instanceof ArtifactNotFoundError) {
          return validationError(error.message);
        }
        return handleToolError(error);
      }
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
      try {
        const relations: Relation[] = [];
        if (args.targetCid !== undefined) {
          relations.push({
            targetCid: args.targetCid,
            relationType: RelationType.RespondsTo,
          });
        }

        const { cid, contribution } = await createSugarContribution(deps, {
          kind: ContributionKind.Discussion,
          mode: ContributionMode.Exploration,
          summary: args.summary,
          description: args.description,
          relations,
          tags: args.tags,
          context: args.context as Readonly<Record<string, JsonValue>> | undefined,
          agent: args.agent as AgentInput,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid,
                kind: "discussion",
                ...(args.targetCid !== undefined ? { targetCid: args.targetCid } : {}),
                summary: contribution.summary,
                createdAt: contribution.createdAt,
              }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof TargetNotFoundError) {
          return notFoundError("Contribution", error.targetCid);
        }
        return handleToolError(error);
      }
    },
  );
}
