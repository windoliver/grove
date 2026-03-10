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

  let current = resolve(process.cwd());

  while (true) {
    const candidate = join(current, GROVE_DIR_NAME);
    if (existsSync(candidate)) {
      return { groveDir: candidate, dbPath: join(candidate, DB_FILENAME) };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

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
