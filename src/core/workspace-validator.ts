/**
 * Validates workspace mutations against contract-defined path constraints.
 *
 * After a contribution, checks the git diff to ensure the agent only
 * modified allowed paths. Violations are reported as flags. Optionally
 * stashes the offending changes.
 */

import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Workspace path constraints from the contract. */
export interface WorkspaceConstraints {
  /** Paths the agent is allowed to modify (glob patterns). */
  readonly mutablePaths?: readonly string[] | undefined;
  /** Paths that must not be modified. Takes precedence over mutablePaths. */
  readonly immutablePaths?: readonly string[] | undefined;
  /** Maximum file size in bytes. */
  readonly maxFileSize?: number | undefined;
}

/** Result of workspace validation. */
export interface WorkspaceValidationResult {
  readonly valid: boolean;
  readonly violations: readonly WorkspaceViolation[];
  /** Whether offending changes were stashed. */
  readonly stashed: boolean;
  /** Git stash ref if changes were stashed. */
  readonly stashRef?: string | undefined;
}

/** A single workspace violation. */
export interface WorkspaceViolation {
  readonly type: "immutable_path" | "outside_mutable" | "file_too_large";
  readonly path: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the workspace directory.
 * Returns trimmed stdout. Throws on non-zero exit.
 */
function git(workspacePath: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: workspacePath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Check whether a file path matches any of the given prefix patterns.
 *
 * A pattern like `"src/"` matches any file starting with `src/`.
 * A pattern like `".mcp.json"` matches the exact file `.mcp.json`.
 * A pattern like `".grove/"` matches any file starting with `.grove/`.
 */
function matchesAnyPattern(filePath: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (filePath === pattern) return true;
    // Directory-style pattern (ends with /): match prefix
    if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;
    // File-style pattern: exact match only (already handled above)
    // But also match as directory prefix for cases like ".grove" matching ".grove/foo"
    if (!pattern.endsWith("/") && filePath.startsWith(`${pattern}/`)) return true;
  }
  return false;
}

/**
 * Get the list of changed files in the workspace (staged + unstaged + untracked).
 * Uses `git status --porcelain` for a comprehensive view.
 * Returns relative paths from the workspace root.
 */
function getChangedFiles(workspacePath: string): string[] {
  let output: string;
  try {
    // Do NOT use the git() helper here — it trims the output, which strips
    // the leading space from porcelain status indicators like " M file.txt".
    output = execSync("git status --porcelain", {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Not a git repo or git not available — nothing to validate
    return [];
  }

  // Remove only trailing whitespace/newlines, preserving leading spaces
  // that are part of the porcelain status format.
  const trimmed = output.replace(/\s+$/, "");
  if (trimmed.length === 0) return [];

  const files: string[] = [];
  for (const line of trimmed.split("\n")) {
    // porcelain format: XY <path> or XY <path> -> <newpath> (for renames)
    // XY is exactly 2 characters, followed by a space, then the path.
    if (line.length < 4) continue;
    const rest = line.slice(3);
    // Handle renames: "R  old -> new" — we care about the new path
    const arrowIndex = rest.indexOf(" -> ");
    const filePath = arrowIndex >= 0 ? rest.slice(arrowIndex + 4) : rest;
    if (filePath.length > 0) {
      files.push(filePath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

/**
 * Validate workspace mutations against constraints.
 *
 * @param workspacePath - Absolute path to the git worktree
 * @param constraints - Path constraints from the contract
 * @param stashOnViolation - Whether to git stash offending changes (default: false)
 */
export function validateWorkspaceMutations(
  workspacePath: string,
  constraints: WorkspaceConstraints,
  stashOnViolation = false,
): WorkspaceValidationResult {
  const { mutablePaths, immutablePaths, maxFileSize } = constraints;

  // If no constraints at all, everything is valid
  const hasImmutable = immutablePaths !== undefined && immutablePaths.length > 0;
  const hasMutable = mutablePaths !== undefined && mutablePaths.length > 0;
  const hasMaxSize = maxFileSize !== undefined;

  if (!hasImmutable && !hasMutable && !hasMaxSize) {
    return { valid: true, violations: [], stashed: false };
  }

  // Get changed files
  const changedFiles = getChangedFiles(workspacePath);

  if (changedFiles.length === 0) {
    return { valid: true, violations: [], stashed: false };
  }

  // Check each file against constraints
  const violations: WorkspaceViolation[] = [];
  const violatingFiles: string[] = [];

  for (const filePath of changedFiles) {
    // 1. Immutable path check (takes precedence)
    if (hasImmutable && matchesAnyPattern(filePath, immutablePaths)) {
      violations.push({
        type: "immutable_path",
        path: filePath,
        message: `File '${filePath}' is in an immutable path`,
      });
      if (!violatingFiles.includes(filePath)) {
        violatingFiles.push(filePath);
      }
      continue; // Skip further checks for this file
    }

    // 2. Mutable path check (only if mutablePaths is defined)
    if (hasMutable && !matchesAnyPattern(filePath, mutablePaths)) {
      violations.push({
        type: "outside_mutable",
        path: filePath,
        message: `File '${filePath}' is outside allowed mutable paths`,
      });
      if (!violatingFiles.includes(filePath)) {
        violatingFiles.push(filePath);
      }
      continue;
    }

    // 3. File size check
    if (hasMaxSize) {
      try {
        const fullPath = join(workspacePath, filePath);
        const stat = statSync(fullPath);
        if (stat.size > maxFileSize) {
          violations.push({
            type: "file_too_large",
            path: filePath,
            message: `File '${filePath}' is ${stat.size} bytes, exceeds max ${maxFileSize} bytes`,
          });
          if (!violatingFiles.includes(filePath)) {
            violatingFiles.push(filePath);
          }
        }
      } catch {
        // File may have been deleted — skip size check
      }
    }
  }

  const valid = violations.length === 0;

  // Stash offending files if requested
  let stashed = false;
  let stashRef: string | undefined;

  if (!valid && stashOnViolation && violatingFiles.length > 0) {
    try {
      // Stash only the violating files
      const fileArgs = violatingFiles.map((f) => `"${f}"`).join(" ");
      git(workspacePath, `stash push -m "grove: workspace constraint violation" -- ${fileArgs}`);
      stashed = true;

      // Get the stash ref
      try {
        stashRef = git(workspacePath, "stash list -1 --format=%H");
      } catch {
        // stash ref is optional — failing to get it is not critical
        stashRef = "stash@{0}";
      }
    } catch {
      // Stash failed — report but don't block
      stashed = false;
    }
  }

  return {
    valid,
    violations,
    stashed,
    ...(stashRef !== undefined ? { stashRef } : {}),
  };
}
