/**
 * Grove directory discovery and agent identity resolution.
 *
 * Walks up from cwd() looking for a .grove/ directory, similar to
 * how git finds .git/. Supports explicit override via --grove flag
 * or GROVE_DIR environment variable.
 */

import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

const GROVE_DIR_NAME = ".grove";
const DB_FILENAME = "grove.db";

export interface GroveLocation {
  readonly groveDir: string;
  readonly dbPath: string;
}

/**
 * Walk up from `startDir` looking for the nearest ancestor (or startDir itself)
 * containing a `.grove/` subdirectory. Returns the absolute path to the
 * `.grove/` directory, or undefined if none is found before the FS root.
 *
 * Fence semantics: this function ONLY checks `.grove/` directory existence.
 * Callers that require additional artifacts (grove.json, grove.db, etc.)
 * MUST validate them after resolution and treat "found .grove/ but missing
 * artifact" as "not initialized at this level" — they MUST NOT silently walk
 * past an incomplete grove to find a more-complete parent. That behavior
 * causes git worktrees to inherit stale parent state (#315).
 */
export function findGroveDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, GROVE_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolve the grove directory path.
 *
 * Priority: overridePath > GROVE_DIR env > walk-up from cwd().
 * Throws with a user-friendly message if no grove is found.
 */
export function resolveGroveDir(overridePath?: string): GroveLocation {
  const target = overridePath ?? process.env.GROVE_DIR;
  if (target) {
    const resolved = resolve(target);
    return { groveDir: resolved, dbPath: join(resolved, DB_FILENAME) };
  }

  const found = findGroveDir(process.cwd());
  if (found) return { groveDir: found, dbPath: join(found, DB_FILENAME) };

  throw new Error("No grove found. Run 'grove init' to create one, or set GROVE_DIR.");
}

/**
 * Resolve the agent ID for CLI operations.
 *
 * Priority: override > GROVE_AGENT_ID env > USER@HOSTNAME fallback.
 */
export function resolveAgentId(override?: string): string {
  if (override) return override;
  const envId = process.env.GROVE_AGENT_ID;
  if (envId) return envId;

  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return "cli-user";
  }
}
