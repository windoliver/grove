/**
 * Workspace isolation protocol for agent sessions.
 *
 * A workspace is an isolated directory where an agent checks out
 * contribution artifacts and works on them. Workspaces enforce:
 *
 * 1. Path containment — all operations stay within the workspace boundary
 * 2. CID-based naming — workspace directory derived from contribution CID
 * 3. Agent tracking — record which agent is working in which workspace
 * 4. Lifecycle management — creation, cleanup, stale detection
 *
 * Inspired by Symphony's strict workspace isolation (proposal §16.1).
 */

import type { AgentIdentity, JsonValue } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a workspace in its lifecycle. */
export const WorkspaceStatus = {
  /** Workspace is active and an agent is working in it. */
  Active: "active",
  /** Workspace has been cleaned up / archived. */
  Cleaned: "cleaned",
  /** Workspace is flagged as stale (no activity for too long). */
  Stale: "stale",
} as const;
export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

/** Information about a workspace. */
export interface WorkspaceInfo {
  /** The contribution CID that was checked out into this workspace. */
  readonly cid: string;
  /** Filesystem path to the workspace root directory. */
  readonly workspacePath: string;
  /** Agent currently assigned to this workspace. */
  readonly agent: AgentIdentity;
  /** Current status. */
  readonly status: WorkspaceStatus;
  /** When the workspace was created. */
  readonly createdAt: string;
  /** Last activity timestamp (updated on checkout, heartbeat, etc.). */
  readonly lastActivityAt: string;
  /** Optional metadata. */
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Options for creating/checking out a workspace. */
export interface CheckoutOptions {
  /** Agent performing the checkout. */
  readonly agent: AgentIdentity;
  /** Optional metadata to attach to the workspace. */
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

/** Options for listing workspaces. */
export interface WorkspaceQuery {
  /** Filter by status. */
  readonly status?: WorkspaceStatus | undefined;
  /** Filter by agent ID. */
  readonly agentId?: string | undefined;
  /** Maximum number of results. */
  readonly limit?: number | undefined;
}

/** Options for stale detection. */
export interface StaleOptions {
  /** Workspaces with no activity for this many milliseconds are stale. */
  readonly maxIdleMs: number;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Workspace manager protocol.
 *
 * Implementations handle the lifecycle of isolated agent workspaces:
 * - checkout: create workspace, materialize artifacts from CAS
 * - list/get: query workspace state
 * - clean: remove workspace directory and mark as cleaned
 * - markStale: flag idle workspaces
 *
 * All path operations MUST enforce containment within the workspace root.
 */
export interface WorkspaceManager {
  /**
   * Check out a contribution's artifacts into an isolated workspace.
   *
   * Creates the workspace directory and copies artifacts from CAS.
   * Idempotent: if a workspace for this CID already exists and is active,
   * returns the existing workspace info.
   *
   * @param cid - The contribution CID to check out.
   * @param options - Agent identity and optional metadata.
   * @returns Information about the created/existing workspace.
   * @throws If the contribution doesn't exist in the store.
   * @throws If artifact materialization fails (workspace is cleaned up).
   */
  checkout(cid: string, options: CheckoutOptions): Promise<WorkspaceInfo>;

  /**
   * Get workspace info by CID.
   * Returns undefined if no workspace exists for this CID.
   */
  getWorkspace(cid: string): Promise<WorkspaceInfo | undefined>;

  /**
   * List workspaces matching optional filters.
   */
  listWorkspaces(query?: WorkspaceQuery): Promise<readonly WorkspaceInfo[]>;

  /**
   * Clean up a workspace — remove its directory and mark as cleaned.
   *
   * Refuses to clean a workspace if its associated claim is still active.
   * Returns true if the workspace was cleaned, false if it didn't exist.
   *
   * @throws If the workspace has an active claim (must release/complete first).
   */
  cleanWorkspace(cid: string): Promise<boolean>;

  /**
   * Find and mark workspaces that have been idle longer than maxIdleMs.
   * Returns the workspaces that were marked stale.
   */
  markStale(options: StaleOptions): Promise<readonly WorkspaceInfo[]>;

  /**
   * Update the lastActivityAt timestamp for a workspace.
   * Used to keep a workspace from being marked stale.
   */
  touchWorkspace(cid: string): Promise<WorkspaceInfo>;

  /** Release resources. */
  close(): void;
}
