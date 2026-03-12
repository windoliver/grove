/**
 * MCP tool for workspace operations.
 *
 * grove_checkout — Materialize a contribution's artifacts to a local workspace
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { JsonValue } from "../../core/models.js";
import type { AgentOverrides } from "../../core/operations/agent.js";
import { checkoutOperation } from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";
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
  const opDeps = toOperationDeps(deps);

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
      const result = await checkoutOperation(
        {
          cid: args.cid,
          agent: args.agent as AgentOverrides,
          ...(args.context !== undefined
            ? { context: args.context as Readonly<Record<string, JsonValue>> }
            : {}),
        },
        opDeps,
      );
      return toMcpResult(result);
    },
  );
}
