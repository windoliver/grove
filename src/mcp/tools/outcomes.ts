/**
 * MCP tools for outcome operations.
 *
 * grove_set_outcome  — Set the outcome (accepted/rejected/crashed/invalidated) for a contribution
 * grove_get_outcome  — Get the outcome for a contribution CID
 * grove_list_outcomes — List outcomes with optional filters
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { OutcomeInput, OutcomeStatus } from "../../core/outcome.js";
import type { AgentInput } from "../agent-identity.js";
import { resolveAgentIdentity } from "../agent-identity.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError } from "../error-handler.js";
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
      try {
        const { outcomeStore } = deps;
        if (!outcomeStore) {
          return errorResult("Outcome store not configured");
        }

        const agent = resolveAgentIdentity(args.agent as AgentInput);

        const input: OutcomeInput = {
          status: args.status as OutcomeStatus,
          evaluatedBy: agent.agentId,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.baselineCid !== undefined ? { baselineCid: args.baselineCid } : {}),
        };

        const record = await outcomeStore.set(args.cid, input);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(record),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
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
      try {
        const { outcomeStore } = deps;
        if (!outcomeStore) {
          return errorResult("Outcome store not configured");
        }

        const record = await outcomeStore.get(args.cid);
        if (!record) {
          return notFoundError("Outcome", args.cid);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(record),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
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
      try {
        const { outcomeStore } = deps;
        if (!outcomeStore) {
          return errorResult("Outcome store not configured");
        }

        const records = await outcomeStore.list({
          status: args.status as OutcomeStatus | undefined,
          limit: args.limit,
        });

        if (records.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No outcomes found",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(records),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
