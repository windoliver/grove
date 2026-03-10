/**
 * MCP tools for read-only query operations.
 *
 * grove_frontier — Get current frontier (multi-signal ranking)
 * grove_search   — Search contributions by text and filters
 * grove_log      — Recent contributions
 * grove_tree     — View DAG structure (children/ancestors)
 *
 * All list operations return trimmed summaries to minimize token usage.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FrontierEntry } from "../../core/frontier.js";
import type { Contribution, ContributionKind, ContributionMode } from "../../core/models.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Trimmed contribution summary for list responses — saves agent tokens. */
interface ContributionSummary {
  readonly cid: string;
  readonly summary: string;
  readonly kind: string;
  readonly mode: string;
  readonly tags: readonly string[];
  readonly scores?: Readonly<Record<string, { value: number; direction: string }>> | undefined;
  readonly agentId: string;
  readonly createdAt: string;
}

function toSummary(c: Contribution): ContributionSummary {
  return {
    cid: c.cid,
    summary: c.summary,
    kind: c.kind,
    mode: c.mode,
    tags: c.tags,
    ...(c.scores !== undefined ? { scores: c.scores } : {}),
    agentId: c.agent.agentId,
    createdAt: c.createdAt,
  };
}

/** Trimmed frontier entry — includes ranking value. */
interface FrontierEntrySummary {
  readonly cid: string;
  readonly summary: string;
  readonly value: number;
  readonly kind: string;
  readonly mode: string;
  readonly agentId: string;
}

function toFrontierSummary(e: FrontierEntry): FrontierEntrySummary {
  return {
    cid: e.cid,
    summary: e.summary,
    value: e.value,
    kind: e.contribution.kind,
    mode: e.contribution.mode,
    agentId: e.contribution.agent.agentId,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const frontierInputSchema = z.object({
  metric: z.string().optional().describe("Filter to a specific metric name"),
  tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction"])
    .optional()
    .describe("Filter by contribution kind"),
  mode: z.enum(["evaluation", "exploration"]).optional().describe("Filter by contribution mode"),
  agentId: z.string().optional().describe("Filter by agent ID"),
  agentName: z.string().optional().describe("Filter by agent name"),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Filter by context fields (exact match). Example: { hardware: 'H100' } for best results on H100",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("Max results per signal (default: 5)"),
});

const searchInputSchema = z.object({
  query: z.string().describe("Full-text search query"),
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction"])
    .optional()
    .describe("Filter by contribution kind"),
  mode: z.enum(["evaluation", "exploration"]).optional().describe("Filter by contribution mode"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  agentId: z.string().optional().describe("Filter by agent ID"),
  agentName: z.string().optional().describe("Filter by agent name"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max results (default: 10)"),
  offset: z.number().int().min(0).optional().default(0).describe("Pagination offset"),
});

const logInputSchema = z.object({
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction"])
    .optional()
    .describe("Filter by contribution kind"),
  mode: z.enum(["evaluation", "exploration"]).optional().describe("Filter by contribution mode"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  agentId: z.string().optional().describe("Filter by agent ID"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max results (default: 10)"),
  offset: z.number().int().min(0).optional().default(0).describe("Pagination offset"),
});

const treeInputSchema = z.object({
  cid: z.string().describe("CID of the contribution to explore"),
  direction: z
    .enum(["children", "ancestors", "both"])
    .default("both")
    .describe(
      "Which direction to traverse: children (incoming edges), ancestors (outgoing), or both",
    ),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerQueryTools(server: McpServer, deps: McpDeps): void {
  // --- grove_frontier -----------------------------------------------------
  server.registerTool(
    "grove_frontier",
    {
      description:
        "Get the current frontier — the best contributions ranked by multiple signals: " +
        "metric scores, adoption count, recency, review quality, and reproduction count. " +
        "Use this to discover the most promising work to build on.",
      inputSchema: frontierInputSchema,
    },
    async (args) => {
      try {
        const { frontier } = deps;

        const result = await frontier.compute({
          metric: args.metric,
          tags: args.tags,
          kind: args.kind as ContributionKind | undefined,
          mode: args.mode as ContributionMode | undefined,
          agentId: args.agentId,
          agentName: args.agentName,
          context: args.context as
            | Record<string, import("../../core/models.js").JsonValue>
            | undefined,
          limit: args.limit,
        });

        // Trim frontier entries for token efficiency
        const trimmed = {
          byMetric: Object.fromEntries(
            Object.entries(result.byMetric).map(([k, v]) => [k, v.map(toFrontierSummary)]),
          ),
          byAdoption: result.byAdoption.map(toFrontierSummary),
          byRecency: result.byRecency.map(toFrontierSummary),
          byReviewScore: result.byReviewScore.map(toFrontierSummary),
          byReproduction: result.byReproduction.map(toFrontierSummary),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(trimmed) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_search -------------------------------------------------------
  server.registerTool(
    "grove_search",
    {
      description:
        "Search contributions by full-text query with optional filters. " +
        "Returns trimmed summaries to save tokens. Use grove_tree to explore relationships.",
      inputSchema: searchInputSchema,
    },
    async (args) => {
      try {
        const { contributionStore } = deps;

        const results = await contributionStore.search(args.query, {
          kind: args.kind as ContributionKind | undefined,
          mode: args.mode as ContributionMode | undefined,
          tags: args.tags,
          agentId: args.agentId,
          agentName: args.agentName,
          limit: args.limit,
          offset: args.offset,
        });

        const summaries = results.map(toSummary);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results: summaries, count: summaries.length }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_log ----------------------------------------------------------
  server.registerTool(
    "grove_log",
    {
      description:
        "List recent contributions with optional filters. Returns trimmed summaries " +
        "ordered by creation time (newest first).",
      inputSchema: logInputSchema,
    },
    async (args) => {
      try {
        const { contributionStore } = deps;

        const results = await contributionStore.list({
          kind: args.kind as ContributionKind | undefined,
          mode: args.mode as ContributionMode | undefined,
          tags: args.tags,
          agentId: args.agentId,
          limit: args.limit,
          offset: args.offset,
        });

        // Store returns oldest-first; reverse for newest-first as promised by the tool contract
        const summaries = results.map(toSummary).reverse();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results: summaries, count: summaries.length }),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  // --- grove_tree ---------------------------------------------------------
  server.registerTool(
    "grove_tree",
    {
      description:
        "View the DAG structure around a contribution. Shows children (contributions that " +
        "reference this one) and/or ancestors (contributions this one references). " +
        "Useful for understanding the lineage and impact of a contribution.",
      inputSchema: treeInputSchema,
    },
    async (args) => {
      try {
        const { contributionStore } = deps;

        // Verify CID exists
        const contribution = await contributionStore.get(args.cid);
        if (contribution === undefined) {
          return notFoundError("Contribution", args.cid);
        }

        const result: {
          cid: string;
          summary: string;
          kind: string;
          children?: ContributionSummary[];
          ancestors?: ContributionSummary[];
        } = {
          cid: contribution.cid,
          summary: contribution.summary,
          kind: contribution.kind,
        };

        if (args.direction === "children" || args.direction === "both") {
          const children = await contributionStore.children(args.cid);
          result.children = children.map(toSummary);
        }

        if (args.direction === "ancestors" || args.direction === "both") {
          const ancestors = await contributionStore.ancestors(args.cid);
          result.ancestors = ancestors.map(toSummary);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
