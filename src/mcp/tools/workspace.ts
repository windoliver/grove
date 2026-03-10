/**
 * MCP tool for workspace operations.
 *
 * grove_checkout — Materialize a contribution's artifacts to a local workspace
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue } from "../../core/models.js";
import type { AgentInput } from "../agent-identity.js";
import { resolveAgentIdentity } from "../agent-identity.js";
import type { McpDeps } from "../deps.js";
import { handleToolError, notFoundError } from "../error-handler.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const agentSchema = z
  .object({
    agentId: z
      .string()
      .optional()
      .describe("Unique agent identifier (default: GROVE_AGENT_ID env var or hostname-pid)"),
    agentName: z.string().optional().describe("Human-readable agent name"),
    provider: z.string().optional().describe("Agent provider"),
    model: z.string().optional().describe("Model identifier"),
    platform: z.string().optional().describe("Platform"),
    version: z.string().optional().describe("Agent version"),
    toolchain: z.string().optional().describe("Toolchain"),
    runtime: z.string().optional().describe("Runtime environment"),
  })
  .optional()
  .describe(
    "Agent identity. Optional — if omitted, resolved from GROVE_AGENT_* env vars or defaults to hostname-pid.",
  );

const checkoutInputSchema = z.object({
  cid: z.string().describe("CID of the contribution to check out"),
  agent: agentSchema,
  context: z.record(z.string(), z.unknown()).optional().describe("Optional workspace metadata"),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerWorkspaceTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_checkout",
    {
      description:
        "Materialize a contribution's artifacts into an isolated local workspace directory. " +
        "Returns the workspace path where artifacts have been placed. Different agents " +
        "checking out the same contribution get separate workspaces. Idempotent — " +
        "checking out the same contribution again returns the existing workspace.",
      inputSchema: checkoutInputSchema,
    },
    async (args) => {
      try {
        const { contributionStore, workspace } = deps;

        // Verify contribution exists
        const contribution = await contributionStore.get(args.cid);
        if (contribution === undefined) {
          return notFoundError("Contribution", args.cid);
        }

        const agent = resolveAgentIdentity(args.agent as AgentInput);

        const wsInfo = await workspace.checkout(args.cid, {
          agent,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                cid: wsInfo.cid,
                workspacePath: wsInfo.workspacePath,
                status: wsInfo.status,
                agentId: wsInfo.agent.agentId,
                artifactCount: Object.keys(contribution.artifacts).length,
                createdAt: wsInfo.createdAt,
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
