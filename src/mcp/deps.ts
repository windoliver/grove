/**
 * MCP server dependency interfaces.
 *
 * McpDeps extends ServerDeps with workspace support for checkout operations
 * and an optional GROVE.md contract for stop condition evaluation.
 * Dependencies are injected into the MCP server factory, enabling testing
 * with real or mock stores.
 */

import type { GroveContract } from "../core/contract.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { ServerDeps } from "../server/deps.js";

/** Dependencies injected into the MCP server. Extends ServerDeps with workspace and contract. */
export interface McpDeps extends ServerDeps {
  readonly workspace: WorkspaceManager;
  /** GROVE.md contract for stop condition evaluation. Undefined if no contract exists. */
  readonly contract?: GroveContract | undefined;
  /** Called after a contribution is written to invalidate caches (e.g., frontier). */
  readonly onContributionWrite?: (() => void) | undefined;
}
