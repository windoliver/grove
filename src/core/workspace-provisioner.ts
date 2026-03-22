/**
 * Provisions git worktrees for agent roles at session start.
 *
 * Creates worktrees in parallel via Promise.allSettled for fast startup.
 * Each agent gets an isolated copy of the repo with its own branch.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for provisioning a single workspace. */
export interface WorkspaceProvisionOptions {
  /** Role name (used in worktree path and branch name). */
  readonly role: string;
  /** Session ID for branch naming. */
  readonly sessionId: string;
  /** Base directory for worktrees (e.g., .grove/workspaces). */
  readonly baseDir: string;
  /** Root of the source repo to create worktrees from. */
  readonly repoRoot: string;
  /** MCP config to write into the worktree. */
  readonly mcpConfig?: Record<string, unknown> | undefined;
  /** Base branch to create worktree from (default: HEAD). */
  readonly baseBranch?: string | undefined;
}

/** Result of provisioning a single workspace. */
export interface ProvisionedWorkspace {
  readonly role: string;
  readonly path: string;
  readonly branch: string;
  readonly sessionId: string;
}

/** Result of provisioning all workspaces for a session. */
export interface SessionWorkspaces {
  readonly sessionId: string;
  readonly workspaces: readonly ProvisionedWorkspace[];
  readonly errors: readonly WorkspaceProvisionError[];
  readonly durationMs: number;
}

/** Error during workspace provisioning. */
export interface WorkspaceProvisionError {
  readonly role: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Provision a single worktree for an agent role.
 *
 * Creates a git worktree at `<baseDir>/<role>-<sessionId prefix>` on a new
 * branch named `grove/<sessionId>/<role>`. Optionally writes an `.mcp.json`
 * config file into the worktree root.
 */
export function provisionWorkspace(
  options: WorkspaceProvisionOptions,
): ProvisionedWorkspace {
  const { role, sessionId, baseDir, repoRoot, mcpConfig, baseBranch } =
    options;

  const worktreePath = join(baseDir, `${role}-${sessionId.slice(0, 8)}`);
  const branch = `grove/${sessionId}/${role}`;

  // Create base directory if needed
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Create the git worktree
  const base = baseBranch ?? "HEAD";
  execSync(`git worktree add "${worktreePath}" -b "${branch}" ${base}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });

  // Write .mcp.json if provided
  if (mcpConfig !== undefined) {
    writeFileSync(
      join(worktreePath, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2),
    );
  }

  return { role, path: worktreePath, branch, sessionId };
}

/**
 * Provision worktrees for all roles in parallel.
 *
 * Uses `Promise.allSettled` so that if one role fails the others still get
 * created. Returns both the successfully created workspaces and any errors.
 */
export async function provisionSessionWorkspaces(
  roles: readonly string[],
  sessionId: string,
  baseDir: string,
  repoRoot: string,
  mcpConfig?: Record<string, unknown>,
  baseBranch?: string,
): Promise<SessionWorkspaces> {
  const start = Date.now();

  // Create all worktrees in parallel
  const results = await Promise.allSettled(
    roles.map(
      (role) =>
        // Wrap sync operation in a microtask to allow parallel scheduling
        new Promise<ProvisionedWorkspace>((resolve, reject) => {
          try {
            const result = provisionWorkspace({
              role,
              sessionId,
              baseDir,
              repoRoot,
              mcpConfig,
              baseBranch,
            });
            resolve(result);
          } catch (error) {
            reject(error);
          }
        }),
    ),
  );

  const workspaces: ProvisionedWorkspace[] = [];
  const errors: WorkspaceProvisionError[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      workspaces.push(result.value);
    } else {
      errors.push({
        role: roles[i]!,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  }

  return {
    sessionId,
    workspaces,
    errors,
    durationMs: Date.now() - start,
  };
}

/**
 * Clean up worktrees for a session.
 *
 * Removes each worktree directory and deletes the associated branch.
 * Errors are silently ignored (best-effort cleanup).
 */
export function cleanupSessionWorkspaces(
  workspaces: readonly ProvisionedWorkspace[],
  repoRoot: string,
): void {
  for (const ws of workspaces) {
    try {
      execSync(`git worktree remove "${ws.path}" --force`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Best effort — worktree may already be removed
    }

    // Also delete the branch
    try {
      execSync(`git branch -D "${ws.branch}"`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }
  }
}
