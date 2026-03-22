/**
 * MCP tools for read-only query operations.
 *
 * grove_frontier — Get current frontier (multi-signal ranking)
 * grove_search   — Search contributions by text and filters
 * grove_log      — Recent contributions
 * grove_tree     — View DAG structure (children/ancestors)
 * grove_thread   — View a discussion thread
 * grove_threads  — Hot threads ranked by activity
 *
 * All business logic is delegated to the shared operations layer.
 * List operations return trimmed summaries to minimize token usage.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ContributionKind, ContributionMode, JsonValue } from "../../core/models.js";
import {
  frontierOperation,
  logOperation,
  searchOperation,
  threadOperation,
  threadsOperation,
  treeOperation,
} from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const frontierInputSchema = z.object({
  metric: z.string().optional().describe("Filter to a specific metric name"),
  tags: z.array(z.string()).optional().describe("Filter by tags (all must match)"),
  kind: z
    .enum(["work", "review", "discussion", "adoption", "reproduction", "plan", "ask_user", "response"])
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
    .enum(["work", "review", "discussion", "adoption", "reproduction", "plan", "ask_user", "response"])
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
    .enum(["work", "review", "discussion", "adoption", "reproduction", "plan", "ask_user", "response"])
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

const threadInputSchema = z.object({
  cid: z.string().describe("CID of the thread root contribution"),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(50)
    .describe("Maximum depth to traverse (default: 50)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(100)
    .describe("Maximum number of nodes to return (default: 100)"),
});

const threadsInputSchema = z.object({
  tags: z.string().optional().describe("Comma-separated tags to filter threads (all must match)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max threads to return (default: 10)"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerQueryTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

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
      const result = await frontierOperation(
        {
          ...(args.metric !== undefined ? { metric: args.metric } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.kind !== undefined ? { kind: args.kind as ContributionKind } : {}),
          ...(args.mode !== undefined ? { mode: args.mode as ContributionMode } : {}),
          ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
          ...(args.agentName !== undefined ? { agentName: args.agentName } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
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
      const result = await searchOperation(
        {
          query: args.query,
          ...(args.kind !== undefined ? { kind: args.kind as ContributionKind } : {}),
          ...(args.mode !== undefined ? { mode: args.mode as ContributionMode } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
          ...(args.agentName !== undefined ? { agentName: args.agentName } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
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
      const result = await logOperation(
        {
          ...(args.kind !== undefined ? { kind: args.kind as ContributionKind } : {}),
          ...(args.mode !== undefined ? { mode: args.mode as ContributionMode } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
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
      const result = await treeOperation(
        {
          cid: args.cid,
          ...(args.direction !== undefined ? { direction: args.direction } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_thread -------------------------------------------------------
  server.registerTool(
    "grove_thread",
    {
      description:
        "View a discussion thread rooted at a contribution. Returns thread nodes with depth, " +
        "ordered so parents appear before children and siblings are chronological. " +
        "Trimmed summaries to save tokens.",
      inputSchema: threadInputSchema,
    },
    async (args) => {
      const result = await threadOperation(
        {
          cid: args.cid,
          ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_threads ------------------------------------------------------
  server.registerTool(
    "grove_threads",
    {
      description:
        "List hot discussion threads ranked by activity. " +
        "Returns thread summaries with reply counts and latest activity timestamps.",
      inputSchema: threadsInputSchema,
    },
    async (args) => {
      const tags = args.tags !== undefined ? args.tags.split(",").map((t) => t.trim()) : undefined;
      const result = await threadsOperation(
        {
          ...(tags !== undefined ? { tags } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
