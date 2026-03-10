/**
 * MCP server factory.
 *
 * createMcpServer(deps) creates a McpServer with all grove tools registered.
 * The server is transport-agnostic — callers connect it to stdio, HTTP, or
 * in-memory transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpDeps } from "./deps.js";
import { registerClaimTools } from "./tools/claims.js";
import { registerContributionTools } from "./tools/contributions.js";
import { registerQueryTools } from "./tools/queries.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

/**
 * Create a McpServer with all grove tools registered.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier, workspace).
 * @returns Configured McpServer ready to connect to a transport.
 */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "grove-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerContributionTools(server, deps);
  registerClaimTools(server, deps);
  registerQueryTools(server, deps);
  registerWorkspaceTools(server, deps);

  return server;
}
