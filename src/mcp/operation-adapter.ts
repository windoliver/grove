/**
 * Adapter utilities for bridging MCP tools to the shared operations layer.
 *
 * toOperationDeps — Convert McpDeps to OperationDeps
 * toMcpResult     — Convert OperationResult to MCP CallToolResult
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { OperationDeps } from "../core/operations/deps.js";
import type { OperationResult } from "../core/operations/result.js";
import type { McpDeps } from "./deps.js";

/**
 * Convert McpDeps to OperationDeps.
 *
 * McpDeps is a structural superset of OperationDeps — this function
 * selects only the fields that operations require, dropping transport-specific
 * dependencies (gossip, topology).
 */
export function toOperationDeps(deps: McpDeps): OperationDeps {
  return {
    contributionStore: deps.contributionStore,
    claimStore: deps.claimStore,
    cas: deps.cas,
    frontier: deps.frontier,
    workspace: deps.workspace,
    ...(deps.contract !== undefined ? { contract: deps.contract } : {}),
    ...(deps.outcomeStore !== undefined ? { outcomeStore: deps.outcomeStore } : {}),
    ...(deps.bountyStore !== undefined ? { bountyStore: deps.bountyStore } : {}),
    ...(deps.creditsService !== undefined ? { creditsService: deps.creditsService } : {}),
    ...(deps.onContributionWrite !== undefined
      ? { onContributionWrite: deps.onContributionWrite }
      : {}),
    ...(deps.eventBus !== undefined ? { eventBus: deps.eventBus } : {}),
    ...(deps.topologyRouter !== undefined ? { topologyRouter: deps.topologyRouter } : {}),
  };
}

/**
 * Convert an OperationResult into a MCP CallToolResult.
 *
 * On success: returns the value as JSON text.
 * On error: returns `[CODE] message` with isError: true (matching existing error-handler.ts format).
 */
export function toMcpResult<T>(result: OperationResult<T>): CallToolResult {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: `[${result.error.code}] ${result.error.message}` }],
  };
}
