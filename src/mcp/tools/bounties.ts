/**
 * MCP tools for bounty operations.
 *
 * grove_bounty_create  — Create a new bounty with credit reservation
 * grove_bounty_list    — List bounties with filters
 * grove_bounty_claim   — Claim an open bounty
 * grove_bounty_settle  — Settle a completed bounty (distribute credits)
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BountyCriteria, BountyStatus } from "../../core/bounty.js";
import type { JsonValue } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import {
  claimBountyOperation,
  createBountyOperation,
  listBountiesOperation,
  settleBountyOperation,
} from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const agentSchema = z
  .object({
    agentId: z.string().optional().describe("Unique agent identifier"),
    agentName: z.string().optional().describe("Human-readable agent name"),
    provider: z.string().optional().describe("Agent provider"),
    model: z.string().optional().describe("Model identifier"),
  })
  .optional()
  .describe("Agent identity. If omitted, resolved from env vars.");

const criteriaSchema = z.object({
  description: z.string().describe("What the contribution must achieve"),
  metricName: z.string().optional().describe("Metric name to evaluate (e.g., 'val_bpb')"),
  metricThreshold: z.number().optional().describe("Threshold value the metric must reach"),
  metricDirection: z
    .enum(["minimize", "maximize"])
    .optional()
    .describe("Whether lower or higher is better"),
  requiredTags: z.array(z.string()).optional().describe("Tags the contribution must include"),
});

const createBountySchema = z.object({
  title: z.string().describe("Short descriptive title for the bounty"),
  description: z.string().optional().describe("Detailed bounty description"),
  amount: z.number().int().positive().describe("Credit amount to offer"),
  criteria: criteriaSchema.describe("Criteria a contribution must meet to fulfill this bounty"),
  deadlineMs: z
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000)
    .describe("Deadline in ms from now (default: 7 days)"),
  agent: agentSchema,
  zoneId: z.string().optional().describe("Zone scope for multi-tenant deployments"),
  context: z.record(z.string(), z.unknown()).optional().describe("Optional bounty metadata"),
});

const listBountiesSchema = z.object({
  status: z
    .enum(["draft", "open", "claimed", "completed", "settled", "expired", "cancelled"])
    .optional()
    .describe("Filter by bounty status"),
  creatorAgentId: z.string().optional().describe("Filter by creator agent ID"),
  limit: z.number().int().positive().optional().default(20).describe("Max results (default: 20)"),
});

const claimBountySchema = z.object({
  bountyId: z.string().describe("ID of the bounty to claim"),
  agent: agentSchema,
  leaseDurationMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1_800_000)
    .describe("Claim lease duration in ms (default: 30 minutes)"),
});

const settleBountySchema = z.object({
  bountyId: z.string().describe("ID of the bounty to settle"),
  contributionCid: z.string().describe("CID of the contribution that fulfilled the bounty"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBountyTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  // --- grove_bounty_create -------------------------------------------------
  server.registerTool(
    "grove_bounty_create",
    {
      description:
        "Create a new bounty offering credits for specific work. Credits are reserved " +
        "from the creator's balance and held in escrow until the bounty is settled or expires.",
      inputSchema: createBountySchema,
    },
    async (args) => {
      const result = await createBountyOperation(
        {
          title: args.title,
          ...(args.description !== undefined ? { description: args.description } : {}),
          amount: args.amount,
          criteria: args.criteria as BountyCriteria,
          ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
          agent: args.agent as AgentOverrides,
          ...(args.zoneId !== undefined ? { zoneId: args.zoneId } : {}),
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_bounty_list ---------------------------------------------------
  server.registerTool(
    "grove_bounty_list",
    {
      description: "List bounties with optional filters by status or creator.",
      inputSchema: listBountiesSchema,
    },
    async (args) => {
      const result = await listBountiesOperation(
        {
          ...(args.status !== undefined ? { status: args.status as BountyStatus } : {}),
          ...(args.creatorAgentId !== undefined ? { creatorAgentId: args.creatorAgentId } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_bounty_claim --------------------------------------------------
  server.registerTool(
    "grove_bounty_claim",
    {
      description:
        "Claim an open bounty. Creates a claim via the existing claim system " +
        "and transitions the bounty to 'claimed' status.",
      inputSchema: claimBountySchema,
    },
    async (args) => {
      const result = await claimBountyOperation(
        {
          bountyId: args.bountyId,
          agent: args.agent as AgentOverrides,
          ...(args.leaseDurationMs !== undefined ? { leaseDurationMs: args.leaseDurationMs } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_bounty_settle -------------------------------------------------
  server.registerTool(
    "grove_bounty_settle",
    {
      description:
        "Settle a bounty by marking a contribution as fulfilling it. Captures the " +
        "reserved credits and distributes them to the fulfiller.",
      inputSchema: settleBountySchema,
    },
    async (args) => {
      const result = await settleBountyOperation(
        {
          bountyId: args.bountyId,
          contributionCid: args.contributionCid,
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
