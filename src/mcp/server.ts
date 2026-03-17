/**
 * MCP server factory.
 *
 * createMcpServer(deps) creates a McpServer with all grove tools registered.
 * The server is transport-agnostic — callers connect it to stdio, HTTP, or
 * in-memory transports.
 */

import { registerAskUserTools } from "@grove/ask-user";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpDeps } from "./deps.js";
import { registerBountyTools } from "./tools/bounties.js";
import { registerClaimTools } from "./tools/claims.js";
import { registerContributionTools } from "./tools/contributions.js";
import { registerGoalTools } from "./tools/goal.js";
import { registerIngestTools } from "./tools/ingest.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerOutcomeTools } from "./tools/outcomes.js";
import { registerQueryTools } from "./tools/queries.js";
import { registerSessionTools } from "./tools/session.js";
import { registerStopTools } from "./tools/stop.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

/**
 * Create a McpServer with all grove tools registered.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier, workspace).
 * @returns Configured McpServer ready to connect to a transport.
 */
export async function createMcpServer(deps: McpDeps): Promise<McpServer> {
  const server = new McpServer(
    { name: "grove-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerContributionTools(server, deps);
  registerClaimTools(server, deps);
  registerQueryTools(server, deps);
  registerWorkspaceTools(server, deps);
  registerStopTools(server, deps);
  registerBountyTools(server, deps);
  registerOutcomeTools(server, deps);
  registerIngestTools(server, deps);
  registerMessagingTools(server, deps);
  registerGoalTools(server, deps);
  registerSessionTools(server, deps);
  await registerAskUserTools(server);

  return server;
}
