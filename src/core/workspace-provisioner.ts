/**
 * Provisions git worktrees for agent roles at session start.
 *
 * Creates worktrees in parallel via Promise.allSettled for fast startup.
 * Each agent gets an isolated copy of the repo with its own branch.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How an agent's workspace was provisioned.
 *
 * - `isolated_worktree`: dedicated git worktree with all config files written.
 * - `fallback_workspace`: worktree creation failed; agent runs from an
 *   alternative path (project root or provider workspace). Config files may
 *   be missing.
 * - `bootstrap_failed`: worktree was created but config file writes failed;
 *   agent has a clean git checkout but no .mcp.json / CLAUDE.md.
 */
export type WorkspaceMode =
  | { readonly status: "isolated_worktree"; readonly path: string; readonly branch: string }
  | { readonly status: "fallback_workspace"; readonly path: string; readonly reason: string }
  | { readonly status: "bootstrap_failed"; readonly path: string; readonly reason: string };

/** Controls whether workspace provisioning failures cause a spawn to fail. */
export type WorkspaceIsolationPolicy = "strict" | "allow-fallback";

/** Options for provisioning a single workspace. */
export interface WorkspaceProvisionOptions {
  /** Role name (used in worktree path and branch name). */
  readonly role: string;
  /** Session ID for branch naming. */
  readonly sessionId: string;
  /** Base directory for worktrees (e.g., .grove/workspaces). */
  readonly baseDir: string;
  /** Path to the bare clone to create worktrees from (from `resolveRepo(ref).bareClonePath`). */
  readonly bareClonePath: string;
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
 *
 * Uses `execFile` (not `execSync`) so it does not block the event loop and
 * is safe against shell injection in role names or paths.
 */
export async function provisionWorkspace(
  options: WorkspaceProvisionOptions,
): Promise<ProvisionedWorkspace> {
  const { role, sessionId, baseDir, bareClonePath, mcpConfig, baseBranch } = options;

  const worktreePath = join(baseDir, `${role}-${sessionId.slice(0, 8)}`);
  const branch = `grove/${sessionId}/${role}`;

  // Ensure base directory exists. safe to call concurrently — recursive:true is idempotent.
  await mkdir(baseDir, { recursive: true });

  // Create the git worktree. execFile avoids a shell invocation, preventing
  // injection via role name or path and allowing true async execution.
  const base = baseBranch ?? "HEAD";
  await execFileAsync("git", ["worktree", "add", worktreePath, "-b", branch, base], {
    cwd: bareClonePath,
  });

  // Write .mcp.json if provided
  if (mcpConfig !== undefined) {
    await writeFile(join(worktreePath, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));
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
  bareClonePath: string,
  mcpConfig?: Record<string, unknown>,
  baseBranch?: string,
): Promise<SessionWorkspaces> {
  const start = Date.now();

  // Pre-create baseDir once before the parallel loop to avoid N concurrent
  // mkdir calls racing on the same path.
  await mkdir(baseDir, { recursive: true });

  // Create all worktrees in parallel
  const results = await Promise.allSettled(
    roles.map((role) =>
      provisionWorkspace({ role, sessionId, baseDir, bareClonePath, mcpConfig, baseBranch }),
    ),
  );

  const workspaces: ProvisionedWorkspace[] = [];
  const errors: WorkspaceProvisionError[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result) continue;
    if (result.status === "fulfilled") {
      workspaces.push(result.value);
    } else {
      errors.push({
        role: roles[i] ?? `role-${i}`,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
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
 * Removes each worktree directory and deletes the associated branch in
 * parallel. Errors are silently ignored (best-effort cleanup).
 */
export async function cleanupSessionWorkspaces(
  workspaces: readonly ProvisionedWorkspace[],
  bareClonePath: string,
): Promise<void> {
  await Promise.allSettled(
    workspaces.map(async (ws) => {
      try {
        await execFileAsync("git", ["worktree", "remove", ws.path, "--force"], {
          cwd: bareClonePath,
        });
      } catch {
        // Best effort — worktree may already be removed
      }

      try {
        await execFileAsync("git", ["branch", "-D", ws.branch], { cwd: bareClonePath });
      } catch {
        // Best effort
      }
    }),
  );
}
