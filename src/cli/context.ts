/**
 * Grove CLI context — discovers the .grove directory and initializes stores.
 *
 * Walks up from the current working directory to find the nearest .grove/
 * directory, opens the SQLite database, and returns all stores needed by
 * CLI commands.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FrontierCalculator } from "../core/frontier.js";
import type { OutcomeStore } from "../core/outcome.js";
import type { ClaimStore, ContributionStore } from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { FsCas } from "../local/fs-cas.js";
import { createLocalRuntime } from "../local/runtime.js";

const GROVE_DIR = ".grove";

/** All dependencies a CLI command needs. */
export interface CliDeps {
  readonly store: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly workspace: WorkspaceManager;
  readonly cas: FsCas;
  readonly groveRoot: string;
  readonly outcomeStore?: OutcomeStore | undefined;
  readonly close: () => void;
}

/** Writer function for testable output. */
export type Writer = (text: string) => void;

/**
 * Walk up from `startDir` to find the nearest directory containing `.grove/`.
 * Returns the absolute path to the `.grove` directory, or undefined.
 */
export function findGroveDir(startDir: string): string | undefined {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : undefined;

  while (true) {
    const candidate = join(dir, GROVE_DIR);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Check filesystem root
  if (root !== undefined) {
    const candidate = join(root, GROVE_DIR);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Discover the grove and initialize all stores.
 * Throws with a user-friendly message if no .grove directory is found.
 */
export function initCliDeps(cwd: string, groveOverride?: string): CliDeps {
  const groveDir = groveOverride ? resolve(groveOverride) : findGroveDir(cwd);
  if (groveDir === undefined) {
    throw new Error(
      "Not inside a grove. Run 'grove init' to create one, or navigate to an existing grove.",
    );
  }

  const runtime = createLocalRuntime({
    groveDir,
    frontierCacheTtlMs: 0, // CLI commands are single-shot; no caching needed
    workspace: true,
  });

  if (!runtime.workspace) {
    throw new Error("Workspace manager failed to initialize");
  }

  return {
    store: runtime.contributionStore,
    claimStore: runtime.claimStore,
    frontier: runtime.frontier,
    workspace: runtime.workspace,
    cas: runtime.cas,
    groveRoot: runtime.groveRoot,
    outcomeStore: runtime.outcomeStore,
    close: runtime.close,
  };
}
