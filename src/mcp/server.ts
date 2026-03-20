/**
 * MCP server factory.
 *
 * createMcpServer(deps) creates a McpServer with all grove tools registered.
 * The server is transport-agnostic — callers connect it to stdio, HTTP, or
 * in-memory transports.
 *
 * An optional McpPresetConfig can be passed to scope which tool groups are
 * registered. When omitted every group is registered (backwards compatible).
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
import { registerPlanTools } from "./tools/plans.js";
import { registerQueryTools } from "./tools/queries.js";
import { registerSessionTools } from "./tools/session.js";
import { registerStopTools } from "./tools/stop.js";
import { registerWorkspaceTools } from "./tools/workspace.js";

// ---------------------------------------------------------------------------
// Preset-scoped tool configuration
// ---------------------------------------------------------------------------

/** Preset-based tool scoping configuration. */
export interface McpPresetConfig {
  /** Register frontier/search/log/tree/thread query tools. Default: true. */
  readonly queries?: boolean;
  /** Register claim/release tools. Default: true. */
  readonly claims?: boolean;
  /** Register bounty tools. Default: true. */
  readonly bounties?: boolean;
  /** Register outcome tools. Default: true. */
  readonly outcomes?: boolean;
  /** Register workspace/checkout tools. Default: true. */
  readonly workspace?: boolean;
  /** Register stop condition tools. Default: true. */
  readonly stop?: boolean;
  /** Register ingest (CAS) tools. Default: true. */
  readonly ingest?: boolean;
  /** Register messaging tools. Default: true. */
  readonly messaging?: boolean;
  /** Register plan tools. Default: true. */
  readonly plans?: boolean;
  /** Register goal/session tools. Default: true. */
  readonly goals?: boolean;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a McpServer with grove tools registered.
 *
 * When `preset` is omitted every tool group is registered (backwards
 * compatible). When provided, each flag defaults to `true` — only groups
 * explicitly set to `false` are excluded.
 *
 * Contribution tools and ask_user are **always** registered regardless of
 * preset because they represent core functionality.
 *
 * @param deps   - Injected dependencies (stores, CAS, frontier, workspace).
 * @param preset - Optional tool-scoping configuration.
 * @returns Configured McpServer ready to connect to a transport.
 */
export async function createMcpServer(deps: McpDeps, preset?: McpPresetConfig): Promise<McpServer> {
  const server = new McpServer(
    { name: "grove-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Contribution tools are always registered (core functionality).
  registerContributionTools(server, deps);

  if (preset?.claims !== false) registerClaimTools(server, deps);
  if (preset?.queries !== false) registerQueryTools(server, deps);
  if (preset?.workspace !== false) registerWorkspaceTools(server, deps);
  if (preset?.stop !== false) registerStopTools(server, deps);
  if (preset?.bounties !== false) registerBountyTools(server, deps);
  if (preset?.outcomes !== false) registerOutcomeTools(server, deps);
  if (preset?.ingest !== false) registerIngestTools(server, deps);
  if (preset?.messaging !== false) registerMessagingTools(server, deps);
  if (preset?.plans !== false) registerPlanTools(server, deps);
  if (preset?.goals !== false) {
    registerGoalTools(server, deps);
    registerSessionTools(server, deps);
  }

  // ask_user is always registered (core functionality).
  await registerAskUserTools(server);

  return server;
}
