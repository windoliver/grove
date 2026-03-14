/**
 * Local workspace manager — filesystem + SQLite implementation.
 *
 * Workspaces are created under `{groveRoot}/.grove/workspaces/{cid_hex}/`.
 * Artifacts are materialized from FsCas using copy-on-write (FICLONE)
 * when the filesystem supports it.
 *
 * Workspace state is tracked in the SQLite database for easy querying
 * (stale detection, agent assignment, cleanup).
 *
 * Checkout is transactional: artifacts are materialized into a temp
 * directory first, then atomically renamed into place. If materialization
 * fails, no corrupt workspace is left behind.
 */

import type { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { HookEntry, HookRunner, HooksConfig } from "../core/hooks.js";
import type { AgentIdentity, JsonValue } from "../core/models.js";
import {
  assertWithinBoundary,
  ensureArtifactParentDir,
  sanitizeCidForPath,
  validateArtifactName,
  validateWorkspaceKey,
} from "../core/path-safety.js";
import type { ContributionStore } from "../core/store.js";
import type {
  CheckoutOptions,
  StaleOptions,
  WorkspaceInfo,
  WorkspaceManager,
  WorkspaceQuery,
} from "../core/workspace.js";
import { WorkspaceStatus } from "../core/workspace.js";
import { safeCleanup } from "../shared/safe-cleanup.js";
import type { FsCas } from "./fs-cas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACES_DIR = "workspaces";

// ---------------------------------------------------------------------------
// SQLite workspace table operations
// ---------------------------------------------------------------------------

/** Row shape from the workspaces table. */
interface WorkspaceRow {
  readonly cid: string;
  readonly agent_id: string;
  readonly workspace_path: string;
  readonly agent_json: string;
  readonly status: string;
  readonly created_at: string;
  readonly last_activity_at: string;
  readonly context_json: string | null;
}

function rowToWorkspaceInfo(row: WorkspaceRow): WorkspaceInfo {
  const base: WorkspaceInfo = {
    cid: row.cid,
    workspacePath: row.workspace_path,
    agent: JSON.parse(row.agent_json) as AgentIdentity,
    status: row.status as WorkspaceStatus,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
  if (row.context_json !== null) {
    return {
      ...base,
      context: JSON.parse(row.context_json) as Readonly<Record<string, JsonValue>>,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Options for creating a LocalWorkspaceManager. */
export interface LocalWorkspaceManagerOptions {
  /** Root directory for workspaces (e.g., `{groveRoot}/.grove`). */
  readonly groveRoot: string;
  /** SQLite database (shared with contribution/claim stores). */
  readonly db: Database;
  /** Contribution store for looking up artifacts. */
  readonly contributionStore: ContributionStore;
  /** CAS for reading artifact content. */
  readonly cas: FsCas;
  /** Optional hook runner for lifecycle hooks. */
  readonly hookRunner?: HookRunner | undefined;
  /** Optional hooks config (from GROVE.md). */
  readonly hooksConfig?: HooksConfig | undefined;
}

/**
 * Filesystem + SQLite workspace manager.
 *
 * Enforces path containment, transactional checkout, and lifecycle tracking.
 */
export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly workspacesRoot: string;
  private readonly db: Database;
  private readonly contributionStore: ContributionStore;
  private readonly cas: FsCas;
  private readonly hookRunner: HookRunner | undefined;
  private readonly hooksConfig: HooksConfig | undefined;

  constructor(options: LocalWorkspaceManagerOptions) {
    this.workspacesRoot = join(options.groveRoot, WORKSPACES_DIR);
    this.db = options.db;
    this.contributionStore = options.contributionStore;
    this.cas = options.cas;
    this.hookRunner = options.hookRunner;
    this.hooksConfig = options.hooksConfig;
  }

  async checkout(cid: string, options: CheckoutOptions): Promise<WorkspaceInfo> {
    const agentId = options.agent.agentId;

    // Validate agentId for safe use as a directory name
    validateWorkspaceKey(agentId);

    // Check for existing active workspace for this (cid, agent) pair
    const existing = await this.getWorkspace(cid, agentId);
    if (existing !== undefined && existing.status === WorkspaceStatus.Active) {
      return existing;
    }

    // Look up the contribution to get its artifacts
    const contribution = await this.contributionStore.get(cid);
    if (contribution === undefined) {
      throw new Error(`Contribution '${cid}' not found`);
    }

    // Compute workspace directory path — scoped by CID + agent
    const cidHex = sanitizeCidForPath(cid);
    const workspacePath = join(this.workspacesRoot, `${cidHex}-${agentId}`);

    // Ensure workspaces root exists
    await mkdir(this.workspacesRoot, { recursive: true });

    // Transactional materialization: temp dir → rename
    const tmpDir = `${workspacePath}.tmp.${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    try {
      // Materialize each artifact from CAS into the temp directory
      for (const [name, contentHash] of Object.entries(contribution.artifacts)) {
        // Validate artifact name to prevent path traversal
        validateArtifactName(name);

        const destPath = join(tmpDir, name);

        // Verify the destination stays within the temp directory
        await assertWithinBoundary(destPath, tmpDir);

        // Create parent directories for nested artifact paths (e.g., src/main.py)
        await ensureArtifactParentDir(name, tmpDir);

        // Copy from CAS using FICLONE (CoW when filesystem supports it)
        const found = await this.casGetToFile(contentHash, destPath);
        if (!found) {
          throw new Error(`Artifact '${name}' with hash '${contentHash}' not found in CAS`);
        }
      }

      // Atomic placement: rename temp dir to final location
      // If the workspace directory already exists (e.g., from a cleaned workspace),
      // remove it first
      try {
        await stat(workspacePath);
        await rm(workspacePath, { recursive: true, force: true });
      } catch (err) {
        if (
          !(
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          throw err;
        }
      }
      await rename(tmpDir, workspacePath);
    } catch (err) {
      // Clean up temp directory on failure
      await safeCleanup(rm(tmpDir, { recursive: true, force: true }), "remove temp workspace dir", {
        silent: true,
      });
      throw err;
    }

    // Record workspace in SQLite
    const now = new Date().toISOString();
    this.upsertWorkspaceRow({
      cid,
      agentId,
      workspacePath,
      agent: options.agent,
      status: WorkspaceStatus.Active,
      createdAt: now,
      lastActivityAt: now,
      context: options.context,
    });

    // Run after_checkout hook if configured
    await this.runHook("after_checkout", workspacePath);

    return {
      cid,
      workspacePath,
      agent: options.agent,
      status: WorkspaceStatus.Active,
      createdAt: now,
      lastActivityAt: now,
      ...(options.context !== undefined && { context: options.context }),
    };
  }

  async getWorkspace(cid: string, agentId: string): Promise<WorkspaceInfo | undefined> {
    const row = this.db
      .prepare(
        `SELECT cid, agent_id, workspace_path, agent_json, status, created_at,
                last_activity_at, context_json
         FROM workspaces WHERE cid = ? AND agent_id = ?`,
      )
      .get(cid, agentId) as WorkspaceRow | null;

    if (row === null) return undefined;
    return rowToWorkspaceInfo(row);
  }

  async listWorkspaces(query?: WorkspaceQuery): Promise<readonly WorkspaceInfo[]> {
    let sql = `SELECT cid, agent_id, workspace_path, agent_json, status, created_at,
                      last_activity_at, context_json
               FROM workspaces`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query?.status !== undefined) {
      conditions.push("status = ?");
      params.push(query.status);
    }
    if (query?.agentId !== undefined) {
      conditions.push("json_extract(agent_json, '$.agentId') = ?");
      params.push(query.agentId);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY last_activity_at DESC";
    if (query?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as readonly WorkspaceRow[];
    return rows.map(rowToWorkspaceInfo);
  }

  async cleanWorkspace(cid: string, agentId: string): Promise<boolean> {
    const workspace = await this.getWorkspace(cid, agentId);
    if (workspace === undefined) return false;

    // Check if there's an active claim for this CID
    const activeClaim = this.db
      .prepare(
        `SELECT claim_id FROM claims
         WHERE target_ref = ? AND status = 'active'
         AND lease_expires_at >= ?`,
      )
      .get(cid, new Date().toISOString()) as { claim_id: string } | null;

    if (activeClaim !== null) {
      throw new Error(
        `Cannot clean workspace for '${cid}': claim '${activeClaim.claim_id}' is still active`,
      );
    }

    // Re-validate workspace path is under our workspace root before rm()
    // to protect against corrupted/tampered SQLite rows pointing outside Grove
    await assertWithinBoundary(workspace.workspacePath, this.workspacesRoot);

    // Remove the directory
    try {
      await rm(workspace.workspacePath, { recursive: true, force: true });
    } catch (err) {
      // Directory might already be gone — that's fine
      if (
        !(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
      ) {
        throw err;
      }
    }

    // Update status in SQLite
    this.db
      .prepare(
        "UPDATE workspaces SET status = ?, last_activity_at = ? WHERE cid = ? AND agent_id = ?",
      )
      .run(WorkspaceStatus.Cleaned, new Date().toISOString(), cid, agentId);

    return true;
  }

  async markStale(options: StaleOptions): Promise<readonly WorkspaceInfo[]> {
    const cutoff = new Date(Date.now() - options.maxIdleMs).toISOString();

    const rows = this.db
      .prepare(
        `UPDATE workspaces SET status = ?
         WHERE status = ? AND last_activity_at < ?
         RETURNING cid, agent_id, workspace_path, agent_json, status,
                   created_at, last_activity_at, context_json`,
      )
      .all(WorkspaceStatus.Stale, WorkspaceStatus.Active, cutoff) as readonly WorkspaceRow[];

    return rows.map(rowToWorkspaceInfo);
  }

  async markWorkspaceStale(cid: string, agentId: string): Promise<WorkspaceInfo> {
    const workspace = await this.getWorkspace(cid, agentId);
    if (workspace === undefined) {
      throw new Error(`Workspace for '${cid}' (agent '${agentId}') not found`);
    }

    // Only transition active workspaces — already stale/cleaned is a no-op in terms of effect
    if (workspace.status === WorkspaceStatus.Active) {
      this.db
        .prepare(
          "UPDATE workspaces SET status = ?, last_activity_at = ? WHERE cid = ? AND agent_id = ?",
        )
        .run(WorkspaceStatus.Stale, new Date().toISOString(), cid, agentId);
    }

    const updated = await this.getWorkspace(cid, agentId);
    if (updated === undefined) {
      throw new Error(`Failed to read back workspace for '${cid}'`);
    }
    return updated;
  }

  async createBareWorkspace(key: string, options: CheckoutOptions): Promise<WorkspaceInfo> {
    const agentId = options.agent.agentId;
    validateWorkspaceKey(agentId);
    validateWorkspaceKey(key);

    // Idempotent: return existing active workspace
    const existing = await this.getWorkspace(key, agentId);
    if (existing !== undefined && existing.status === WorkspaceStatus.Active) {
      return existing;
    }

    // Create empty workspace directory
    // Key is a spawnId (not a CID), so use it directly after validation
    const workspacePath = join(this.workspacesRoot, `${key}-${agentId}`);
    await mkdir(this.workspacesRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });

    // Record in SQLite
    const now = new Date().toISOString();
    this.upsertWorkspaceRow({
      cid: key,
      agentId,
      workspacePath,
      agent: options.agent,
      status: WorkspaceStatus.Active,
      createdAt: now,
      lastActivityAt: now,
      context: options.context,
    });

    return {
      cid: key,
      workspacePath,
      agent: options.agent,
      status: WorkspaceStatus.Active,
      createdAt: now,
      lastActivityAt: now,
      ...(options.context !== undefined && { context: options.context }),
    };
  }

  async touchWorkspace(cid: string, agentId: string): Promise<WorkspaceInfo> {
    const now = new Date().toISOString();

    this.db
      .prepare("UPDATE workspaces SET last_activity_at = ? WHERE cid = ? AND agent_id = ?")
      .run(now, cid, agentId);

    const workspace = await this.getWorkspace(cid, agentId);
    if (workspace === undefined) {
      throw new Error(`Workspace for '${cid}' not found`);
    }
    return workspace;
  }

  close(): void {
    // DB lifecycle managed by caller (shared with store)
  }

  // ========================================================================
  // Hook execution
  // ========================================================================

  /**
   * Run a lifecycle hook if configured and a hook runner is available.
   * Logs a warning if the hook fails for non-blocking hooks.
   * Throws for before_contribute (blocking hook).
   */
  async runHook(
    hookName: "after_checkout" | "before_contribute" | "after_contribute",
    cwd: string,
  ): Promise<void> {
    if (this.hookRunner === undefined || this.hooksConfig === undefined) return;

    const entry: HookEntry | undefined = this.hooksConfig[hookName];
    if (entry === undefined) return;

    const result = await this.hookRunner.run(entry, cwd);

    if (!result.success && hookName === "before_contribute") {
      throw new Error(
        `before_contribute hook failed (exit ${result.exitCode}): ${result.stderr}`.trim(),
      );
    }
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Copy an artifact from CAS to a destination path using FICLONE
   * (copy-on-write when filesystem supports it).
   *
   * Validates the content hash format before constructing the CAS path
   * to prevent path traversal via crafted hashes (e.g., "blake3:aa/../../../secret").
   */
  private async casGetToFile(contentHash: string, destPath: string): Promise<boolean> {
    // Validate content hash format to prevent path traversal
    if (!/^blake3:[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error(`Invalid content hash format: '${contentHash}' — expected blake3:<64-hex>`);
    }

    // Safe: hex is guaranteed to be exactly 64 lowercase hex chars
    const hex = contentHash.slice("blake3:".length);
    const blobPath = join(this.cas.rootPath, hex.slice(0, 2), hex.slice(2, 4), hex);

    try {
      await copyFile(blobPath, destPath, constants.COPYFILE_FICLONE);
      return true;
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return false;
      }
      throw err;
    }
  }

  /** Insert or update a workspace row in SQLite. */
  private upsertWorkspaceRow(info: {
    cid: string;
    agentId: string;
    workspacePath: string;
    agent: AgentIdentity;
    status: WorkspaceStatus;
    createdAt: string;
    lastActivityAt: string;
    context?: Readonly<Record<string, JsonValue>> | undefined;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workspaces
           (cid, agent_id, workspace_path, agent_json, status, created_at, last_activity_at, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        info.cid,
        info.agentId,
        info.workspacePath,
        JSON.stringify(info.agent),
        info.status,
        info.createdAt,
        info.lastActivityAt,
        info.context !== undefined ? JSON.stringify(info.context) : null,
      );
  }
}
