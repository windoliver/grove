/**
 * MCP server dependency interfaces.
 *
 * McpDeps extends ServerDeps with workspace support for checkout operations,
 * an optional GROVE.md contract for stop condition evaluation,
 * and optional bounty/credits services.
 * Dependencies are injected into the MCP server factory, enabling testing
 * with real or mock stores.
 */

import type { BountyStore } from "../core/bounty-store.js";
import type { GroveContract } from "../core/contract.js";
import type { DeadlineWatcher } from "../core/deadline-watcher.js";
import type { EventBus } from "../core/event-bus.js";
import type { HandoffStore } from "../core/handoff.js";
import type { OwnerRef } from "../core/lifecycle-metadata.js";
import type { RuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
import type { Session } from "../core/session.js";
import type { TopologyRouter } from "../core/topology-router.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { ServerDeps } from "../server/deps.js";

export function sessionToOwnerRef(
  session: (Pick<Session, "id"> & { readonly uid?: string | undefined }) | undefined,
): OwnerRef | undefined {
  return session !== undefined
    ? { kind: "session" as const, id: session.id, uid: session.uid ?? session.id }
    : undefined;
}

/** Dependencies injected into the MCP server. Extends ServerDeps with workspace and contract. */
export interface McpDeps extends ServerDeps {
  readonly workspace: WorkspaceManager;
  /** GROVE.md contract for stop condition evaluation. Undefined if no contract exists. */
  readonly contract?: GroveContract | undefined;
  /**
   * Optional scope suffix for client-supplied idempotency keys.
   *
   * HTTP MCP multiplexes multiple Grove sessions through one process, so the
   * same raw idempotency key must be decorated with the bound Grove session to
   * avoid cross-session cache collisions inside contributeOperation.
   */
  readonly idempotencyKeyScope?: string | undefined;
  /** Owner stamped onto claims created by this MCP session. */
  readonly sessionOwnerRef?: OwnerRef | undefined;
  /** Called after a contribution is written to invalidate caches (e.g., frontier). */
  readonly onContributionWrite?: (() => void) | undefined;
  /** Called after a contribution is written, receiving its CID (for session tagging). */
  readonly onContributionWritten?: ((cid: string) => void) | undefined;
  /**
   * Called after any Entity (#287) write — drives the watch protocol (#292).
   * MCP wires this to POST /api/watch/notify on the locally-managed
   * grove-server when one is reachable, so cross-process Nexus writes
   * (i.e. agent contributions) propagate to the TUI's WatchHub /
   * EntityStore feed without polling.
   */
  readonly onEntityWrite?:
    | ((event: import("../core/watch-events.js").EntityWriteEvent) => void)
    | undefined;
  /** Namespace under which the MCP process serves; required to fire onEntityWrite. */
  readonly namespace?: string | undefined;
  readonly bountyStore?: BountyStore;
  readonly creditsService?: ServerDeps["creditsService"];
  readonly frontierRewardService?: ServerDeps["frontierRewardService"];
  /** Optional event bus for agent notifications. */
  readonly eventBus?: EventBus | undefined;
  /** Optional topology router for routing contribution events to downstream agents. */
  readonly topologyRouter?: TopologyRouter | undefined;
  /** Optional handoff store for querying routing coordination records. */
  readonly handoffStore?: HandoffStore | undefined;
  /** Optional runtime skill acquisition service for stdio-bound agents. */
  readonly runtimeSkillService?: RuntimeSkillAcquisitionService | undefined;
  /**
   * Workspace boundary root directory. All file-system access from MCP tools
   * (filePath args, git cwd, etc.) must resolve within this directory.
   * Typically the project root containing the .grove/ directory.
   */
  readonly workspaceBoundary: string;
  /** Optional deadline watcher for proactive overdue detection. */
  readonly deadlineWatcher?: DeadlineWatcher | undefined;
  /**
   * True when handoff expiry is managed by a proactive watcher elsewhere,
   * so polling read paths should not run inline expiry sweeps.
   */
  readonly handoffExpiryManaged?: boolean | undefined;
}
