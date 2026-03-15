/**
 * MCP tools for boardroom messaging and cost tracking.
 *
 * grove_send_message  — Send a message to other agents
 * grove_read_inbox    — Read inbox messages with optional filters
 * grove_report_usage  — Report token/cost usage for the session
 *
 * Messages and usage reports are stored as ephemeral discussion contributions,
 * reusing the existing contribution graph. Business logic is delegated to
 * the shared operations layer (messaging.ts, cost-tracking.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { computeCid } from "../../core/manifest.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import { resolveAgent } from "../../core/operations/agent.js";
import type { UsageReport } from "../../core/operations/cost-tracking.js";
import { reportUsage } from "../../core/operations/cost-tracking.js";
import { readInbox, sendMessage } from "../../core/operations/messaging.js";
import type { McpDeps } from "../deps.js";
import { agentSchema } from "../schemas.js";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const sendMessageInputSchema = z.object({
  body: z.string().min(1).describe("Message body text"),
  recipients: z
    .array(z.string())
    .min(1)
    .describe('Recipient handles (e.g., "@claude-eng", "@all" for broadcast)'),
  in_reply_to: z
    .string()
    .optional()
    .describe("CID of the message being replied to (creates responds_to relation)"),
  tags: z.array(z.string()).optional().default([]).describe("Free-form labels for filtering"),
  agent: agentSchema,
});

const readInboxInputSchema = z.object({
  recipient: z
    .string()
    .optional()
    .describe('Filter to messages addressed to this handle (e.g., "@claude-eng")'),
  from_agent_id: z.string().optional().describe("Filter to messages from this agent ID"),
  since: z.string().optional().describe("Only return messages after this ISO timestamp"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe("Maximum number of messages to return (default: 50)"),
});

const reportUsageInputSchema = z.object({
  input_tokens: z.number().int().min(0).describe("Number of input tokens consumed"),
  output_tokens: z.number().int().min(0).describe("Number of output tokens consumed"),
  model: z
    .string()
    .max(128)
    .optional()
    .describe("Model identifier (e.g., claude-sonnet-4-20250514)"),
  cost_usd: z.number().min(0).optional().describe("Estimated cost in USD"),
  cache_read_tokens: z.number().int().min(0).optional().describe("Cache read tokens"),
  cache_write_tokens: z.number().int().min(0).optional().describe("Cache write tokens"),
  context_window_percent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Percentage of context window used (0-100)"),
  agent: agentSchema,
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerMessagingTools(server: McpServer, deps: McpDeps): void {
  // --- grove_send_message --------------------------------------------------
  server.registerTool(
    "grove_send_message",
    {
      description:
        "Send a message to other agents in the boardroom. Messages are stored as ephemeral " +
        "discussion contributions. Use @all to broadcast, or specify individual agent handles " +
        "as recipients. Supports threaded replies via in_reply_to.",
      inputSchema: sendMessageInputSchema,
    },
    async (args) => {
      const agent = resolveAgent(args.agent as AgentOverrides | undefined);

      const contribution = await sendMessage(
        deps.contributionStore,
        {
          agent,
          body: args.body,
          recipients: args.recipients,
          ...(args.in_reply_to !== undefined ? { inReplyTo: args.in_reply_to } : {}),
          tags: args.tags,
        },
        computeCid,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              cid: contribution.cid,
              summary: contribution.summary,
              recipients: args.recipients,
            }),
          },
        ],
      };
    },
  );

  // --- grove_read_inbox ----------------------------------------------------
  server.registerTool(
    "grove_read_inbox",
    {
      description:
        "Read inbox messages from other agents. Supports filtering by recipient, sender, " +
        "and timestamp. Returns messages sorted by most recent first.",
      inputSchema: readInboxInputSchema,
    },
    async (args) => {
      const messages = await readInbox(deps.contributionStore, {
        ...(args.recipient !== undefined ? { recipient: args.recipient } : {}),
        ...(args.from_agent_id !== undefined ? { fromAgentId: args.from_agent_id } : {}),
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: messages.length,
              messages,
            }),
          },
        ],
      };
    },
  );

  // --- grove_report_usage --------------------------------------------------
  server.registerTool(
    "grove_report_usage",
    {
      description:
        "Report token and cost usage for the current session. Usage reports are stored as " +
        "ephemeral contributions and aggregated for the boardroom cost display. " +
        "Call this periodically to keep the orchestrator informed of resource consumption.",
      inputSchema: reportUsageInputSchema,
    },
    async (args) => {
      const agent = resolveAgent(args.agent as AgentOverrides | undefined);

      const report: UsageReport = {
        inputTokens: args.input_tokens,
        outputTokens: args.output_tokens,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.cost_usd !== undefined ? { costUsd: args.cost_usd } : {}),
        ...(args.cache_read_tokens !== undefined
          ? { cacheReadTokens: args.cache_read_tokens }
          : {}),
        ...(args.cache_write_tokens !== undefined
          ? { cacheWriteTokens: args.cache_write_tokens }
          : {}),
        ...(args.context_window_percent !== undefined
          ? { contextWindowPercent: args.context_window_percent }
          : {}),
      };

      const contribution = await reportUsage(deps.contributionStore, agent, report, computeCid);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              cid: contribution.cid,
              summary: contribution.summary,
              agent: agent.agentId,
            }),
          },
        ],
      };
    },
  );
}
