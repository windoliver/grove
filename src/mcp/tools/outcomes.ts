/**
 * MCP tools for outcome operations.
 *
 * grove_set_outcome  — Set the outcome (accepted/rejected/crashed/invalidated) for a contribution
 * grove_get_outcome  — Get the outcome for a contribution CID
 * grove_list_outcomes — List outcomes with optional filters
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentOverrides } from "../../core/operations/agent.js";
import {
  getOutcomeOperation,
  listOutcomesOperation,
  setOutcomeOperation,
} from "../../core/operations/index.js";
import type { OutcomeStatus } from "../../core/outcome.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";
import { agentSchema } from "../schemas.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const setOutcomeSchema = z.object({
  cid: z.string().describe("Contribution CID to set the outcome for"),
  status: z.enum(["accepted", "rejected", "crashed", "invalidated"]).describe("Outcome status"),
  reason: z.string().optional().describe("Explanation for the outcome decision"),
  baselineCid: z.string().optional().describe("Baseline CID for comparison"),
  agent: agentSchema,
});

const getOutcomeSchema = z.object({
  cid: z.string().describe("Contribution CID to retrieve the outcome for"),
});

const listOutcomesSchema = z.object({
  status: z
    .enum(["accepted", "rejected", "crashed", "invalidated"])
    .optional()
    .describe("Filter by outcome status"),
  limit: z.number().int().positive().optional().default(20).describe("Max results (default: 20)"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerOutcomeTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  // --- grove_set_outcome ---------------------------------------------------
  server.registerTool(
    "grove_set_outcome",
    {
      description:
        "Set the outcome (accepted/rejected/crashed/invalidated) for a contribution. " +
        "Outcomes are local operator annotations that do not affect CIDs or gossip.",
      inputSchema: setOutcomeSchema,
    },
    async (args) => {
      const result = await setOutcomeOperation(
        {
          cid: args.cid,
          status: args.status as OutcomeStatus,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.baselineCid !== undefined ? { baselineCid: args.baselineCid } : {}),
          agent: args.agent as AgentOverrides,
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );

  // --- grove_get_outcome ---------------------------------------------------
  server.registerTool(
    "grove_get_outcome",
    {
      description: "Get the outcome record for a contribution CID.",
      inputSchema: getOutcomeSchema,
    },
    async (args) => {
      const result = await getOutcomeOperation({ cid: args.cid }, opDeps);
      return toMcpResult(result);
    },
  );

  // --- grove_list_outcomes -------------------------------------------------
  server.registerTool(
    "grove_list_outcomes",
    {
      description: "List outcome records with optional filters by status.",
      inputSchema: listOutcomesSchema,
    },
    async (args) => {
      const result = await listOutcomesOperation(
        {
          ...(args.status !== undefined ? { status: args.status as OutcomeStatus } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
