/**
 * MCP tools for querying handoff coordination records.
 *
 * grove_list_handoffs    — List handoffs, optionally filtered by role or status.
 * grove_get_handoff      — Get a single handoff by ID.
 * grove_list_dead_letters — List handoffs that failed IPC delivery (DLQ).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HandoffStatus, canTransition } from "../../core/handoff.js";
import type { McpDeps } from "../deps.js";
import { toolError } from "../error-handler.js";

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
      HandoffStatus.Processed,
      HandoffStatus.Replied,
      HandoffStatus.Expired,
      HandoffStatus.DeadLettered,
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
        "List topology routing handoffs with IPC delivery state. Use this to discover work routed to your role (status=pending_pickup), check what you have routed downstream, or monitor delivery status (delivered, processed, dead_lettered). Stale handoffs are expired automatically before listing.",
      inputSchema: listHandoffsInputSchema,
    },
    async (args) => {
      const { handoffStore } = deps;
      if (handoffStore === undefined) {
        return toolError(
          "NOT_CONFIGURED",
          "Handoff store is not available. Topology routing must be active.",
        );
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
        return toolError("NOT_CONFIGURED", "Handoff store is not available.");
      }

      const handoff = await handoffStore.get(args.handoffId);
      if (handoff === undefined) {
        return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(handoff) }],
      };
    },
  );

  // --- grove_list_dead_letters -----------------------------------------------
  const listDeadLettersInputSchema = z.object({
    toRole: z
      .string()
      .optional()
      .describe("Filter dead-lettered handoffs by target role. Omit to list all."),
    fromRole: z
      .string()
      .optional()
      .describe("Filter dead-lettered handoffs by originating role. Omit to list all."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Maximum number of dead-lettered handoffs to return. Defaults to 50."),
  });

  server.registerTool(
    "grove_list_dead_letters",
    {
      description:
        "List handoffs that failed IPC delivery after retries (dead letter queue). " +
        "These represent routing failures that may require operator attention — " +
        "the source contribution was committed but the target agent was never notified. " +
        "Use this to diagnose delivery gaps in topology-driven routing.",
      inputSchema: listDeadLettersInputSchema,
    },
    async (args) => {
      const { handoffStore } = deps;
      if (handoffStore === undefined) {
        return toolError(
          "NOT_CONFIGURED",
          "Handoff store is not available. Topology routing must be active.",
        );
      }

      const handoffs = await handoffStore.list({
        toRole: args.toRole,
        fromRole: args.fromRole,
        status: HandoffStatus.DeadLettered,
        limit: args.limit ?? 50,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: handoffs.length,
              handoffs,
            }),
          },
        ],
      };
    },
  );

  // --- grove_ack_handoff -----------------------------------------------------
  const ackHandoffInputSchema = z.object({
    handoffId: z.string().min(1).describe("ID of the handoff to acknowledge."),
  });

  server.registerTool(
    "grove_ack_handoff",
    {
      description:
        "Acknowledge receipt of a handoff, transitioning it from delivered to processed. " +
        "Call this when your agent has received a routed handoff and is beginning to act on it. " +
        "This signals to the orchestrator that the handoff was successfully received and is being worked on.",
      inputSchema: ackHandoffInputSchema,
    },
    async (args) => {
      const { handoffStore } = deps;
      if (handoffStore === undefined) {
        return toolError("NOT_CONFIGURED", "Handoff store is not available.");
      }

      const handoff = await handoffStore.get(args.handoffId);
      if (handoff === undefined) {
        return toolError("NOT_FOUND", `Handoff '${args.handoffId}' not found.`);
      }

      if (!canTransition(handoff.status, HandoffStatus.Processed)) {
        return toolError(
          "INVALID_STATE",
          `Cannot acknowledge handoff in status '${handoff.status}'. ` +
            `Only 'delivered' handoffs can be acknowledged.`,
        );
      }

      await handoffStore.markProcessed(args.handoffId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              handoffId: args.handoffId,
              previousStatus: handoff.status,
              status: HandoffStatus.Processed,
            }),
          },
        ],
      };
    },
  );
}
