/**
 * MCP tool for stop condition evaluation.
 *
 * grove_check_stop — Check if grove stop conditions are met
 *
 * All business logic is delegated to the shared operations layer.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { checkStopOperation } from "../../core/operations/index.js";
import type { McpDeps } from "../deps.js";
import { toMcpResult, toOperationDeps } from "../operation-adapter.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerStopTools(server: McpServer, deps: McpDeps): void {
  const opDeps = toOperationDeps(deps);

  server.registerTool(
    "grove_check_stop",
    {
      description:
        "Check whether the grove's stop conditions are met. Returns a structured result " +
        "with each condition's status, reason, and details. The grove is considered stopped " +
        "if ANY condition is met. Call this after each contribution to decide whether to continue. " +
        "Returns {stopped: false} if no GROVE.md contract is defined.",
      inputSchema: {},
    },
    async () => {
      const result = await checkStopOperation(opDeps);
      return toMcpResult(result);
    },
  );
}
