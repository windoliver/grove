/**
 * MCP server dependency interfaces.
 *
 * McpDeps extends ServerDeps with workspace support for checkout operations
 * and optional bounty/credits services.
 * Dependencies are injected into the MCP server factory, enabling testing
 * with real or mock stores.
 */

import type { BountyStore } from "../core/bounty-store.js";
import type { CreditsService } from "../core/credits.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { ServerDeps } from "../server/deps.js";

/** Dependencies injected into the MCP server. Extends ServerDeps with workspace. */
export interface McpDeps extends ServerDeps {
  readonly workspace: WorkspaceManager;
  readonly bountyStore?: BountyStore;
  readonly creditsService?: CreditsService;
}
