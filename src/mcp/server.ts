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
import { registerDoneTools } from "./tools/done.js";
import { registerEvalTools } from "./tools/eval.js";
import { registerGoalTools } from "./tools/goal.js";
import { registerHandoffTools } from "./tools/handoffs.js";
import { registerIngestTools } from "./tools/ingest.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerOutcomeTools } from "./tools/outcomes.js";
import { registerPlanTools } from "./tools/plans.js";
import { registerQueryTools } from "./tools/queries.js";
import { registerRuntimeSkillTools } from "./tools/runtime-skills.js";
import { registerSessionTools } from "./tools/session.js";
import { registerStopTools } from "./tools/stop.js";
import { registerTrajectoryTools } from "./tools/trajectory.js";
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
  /** Register eval harness tool (grove_eval). Default: false (opt-in via GROVE_MCP_EVAL_ENABLED). */
  readonly eval?: boolean;
  /**
   * Transport the server is being attached to. Some tools are unsafe on
   * shared transports where one process role is shared across all clients
   * (HTTP MCP): receipt mutations (grove_ack_handoff) require a per-agent
   * role binding that only the stdio transport provides.
   * Default: "stdio" (backwards-compatible for existing callers).
   */
  readonly transport?: "stdio" | "http";
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

  // Contribution + done tools are always registered (core functionality).
  registerContributionTools(server, deps);
  registerDoneTools(server, deps);
  // Handoff tools are always registered when topology is active (agents need
  // to query pending work). grove_ack_handoff (receipt mutation) is gated on
  // transport: only stdio has per-process role binding via GROVE_AGENT_ROLE.
  // On HTTP the tool is omitted because all clients would share one role.
  if (deps.handoffStore !== undefined) {
    registerHandoffTools(server, deps, { includeAckTool: preset?.transport !== "http" });
  }
  if (preset?.transport !== "http") registerRuntimeSkillTools(server, deps);

  if (preset?.claims !== false) registerClaimTools(server, deps);
  if (preset?.queries !== false) {
    registerQueryTools(server, deps);
    registerTrajectoryTools(server, deps);
  }
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
  if (preset?.eval === true) registerEvalTools(server, deps);

  // ask_user is always registered (core functionality).
  await registerAskUserTools(server);

  return server;
}
