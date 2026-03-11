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
import { agentSchema } from "../schemas.js";

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
