/**
 * MCP server dependency interfaces.
 *
 * McpDeps extends ServerDeps with workspace support for checkout operations.
 * Dependencies are injected into the MCP server factory, enabling testing
 * with real or mock stores.
 */

import type { WorkspaceManager } from "../core/workspace.js";
import type { ServerDeps } from "../server/deps.js";

/** Dependencies injected into the MCP server. Extends ServerDeps with workspace. */
export interface McpDeps extends ServerDeps {
  readonly workspace: WorkspaceManager;
}
