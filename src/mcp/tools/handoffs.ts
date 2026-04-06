/**
 * MCP tools for querying handoff coordination records.
 *
 * grove_list_handoffs — List handoffs, optionally filtered by role or status.
 * grove_get_handoff   — Get a single handoff by ID.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HandoffStatus } from "../../core/handoff.js";
import type { McpDeps } from "../deps.js";

const listHandoffsInputSchema = z.object({
  toRole: z
    .string()
    .optional()
    .describe("Filter by target role (e.g. 'reviewer'). Omit to list all."),
  fromRole: z
    .string()
    .optional()
    .describe("Filter by originating role (e.g. 'coder'). Omit to list all."),
  status: z
    .enum([
      HandoffStatus.PendingPickup,
      HandoffStatus.Delivered,
      HandoffStatus.Replied,
      HandoffStatus.Expired,
    ])
    .optional()
    .describe(
      "Filter by status. Omit to return all statuses. Call this with status='pending_pickup' to find work waiting for your role.",
    ),
  sourceCid: z
    .string()
    .optional()
    .describe(
      "Filter by the source contribution CID. Useful for checking if a contribution was routed.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of handoffs to return. Defaults to 50."),
});

const getHandoffInputSchema = z.object({
  handoffId: z.string().min(1).describe("ID of the handoff to retrieve."),
});

export function registerHandoffTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_list_handoffs",
    {
      description:
        "List topology routing handoffs. Use this to discover work that has been routed to your role (status=pending_pickup), or to check what you have routed to downstream roles. Call expireStale implicitly (fresh status is always returned).",
      inputSchema: listHandoffsInputSchema,
    },
    async (args) => {
      const { handoffStore } = deps;
      if (handoffStore === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "[NOT_CONFIGURED] Handoff store is not available. Topology routing must be active.",
            },
          ],
        };
      }

      // Expire stale handoffs before listing so callers always see fresh status.
      await handoffStore.expireStale();

      const handoffs = await handoffStore.list({
        toRole: args.toRole,
        fromRole: args.fromRole,
        status: args.status,
        sourceCid: args.sourceCid,
        limit: args.limit ?? 50,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ handoffs }) }],
      };
    },
  );

  server.registerTool(
    "grove_get_handoff",
    {
      description: "Get a single handoff coordination record by its ID.",
      inputSchema: getHandoffInputSchema,
    },
    async (args) => {
      const { handoffStore } = deps;
      if (handoffStore === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "[NOT_CONFIGURED] Handoff store is not available.",
            },
          ],
        };
      }

      const handoff = await handoffStore.get(args.handoffId);
      if (handoff === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `[NOT_FOUND] Handoff '${args.handoffId}' not found.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(handoff) }],
      };
    },
  );
}
