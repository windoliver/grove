/**
 * GroveRuntime factory — DRY initialization of all core stores.
 *
 * Replaces duplicated store init logic in CLI context, TUI main,
 * and example helpers with a single factory function.
 */

import { dirname, join } from "node:path";
import type { ContentStore } from "./cas.js";
import type { FrontierCalculator } from "./frontier.js";
import { DefaultFrontierCalculator } from "./frontier.js";
import type { OutcomeStore } from "./outcome.js";
import type { ClaimStore, ContributionStore } from "./store.js";
import type { WorkspaceManager } from "./workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for runtime creation. */
export interface RuntimeConfig {
  /** Backend mode. */
  readonly mode: "local" | "nexus" | "remote";
  /** Path to .grove directory (required for local mode). */
  readonly groveDir?: string | undefined;
  /** Nexus server URL (required for nexus mode). */
  readonly nexusUrl?: string | undefined;
  /** Remote server URL (required for remote mode). */
  readonly remoteUrl?: string | undefined;
}

/** A fully-initialized set of Grove stores and services. */
export interface GroveRuntime {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly workspace?: WorkspaceManager | undefined;
  readonly cas?: ContentStore | undefined;
  readonly outcomeStore?: OutcomeStore | undefined;
  /** The root directory containing .grove/ (parent of groveDir). */
  readonly groveRoot?: string | undefined;
  /** Close all stores and release resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GroveRuntime for the given configuration.
 *
 * For local mode, opens the SQLite database and initializes all stores.
 * Nexus and remote modes are not yet supported (will be added when needed).
 */
export function createRuntime(config: RuntimeConfig): GroveRuntime {
  if (config.mode === "local") {
    return createLocalRuntime(config.groveDir);
  }

  if (config.mode === "nexus") {
    if (!config.nexusUrl) {
      throw new Error("nexusUrl is required for nexus mode");
    }
    // Nexus runtime — lightweight local setup for workspace tracking
    // Full Nexus store initialization is deferred to the provider
    return createLocalRuntime(config.groveDir);
  }

  throw new Error(`Runtime mode '${config.mode}' is not yet supported`);
}

function createLocalRuntime(groveDir: string | undefined): GroveRuntime {
  if (!groveDir) {
    throw new Error("groveDir is required for local mode");
  }

  // Dynamic imports would prevent this from being synchronous,
  // so we use require-style imports (Bun supports this).
  const { initSqliteDb, SqliteContributionStore, SqliteClaimStore } =
    require("../local/sqlite-store.js") as typeof import("../local/sqlite-store.js");
  const { SqliteOutcomeStore } =
    require("../local/sqlite-outcome-store.js") as typeof import("../local/sqlite-outcome-store.js");
  const { FsCas } = require("../local/fs-cas.js") as typeof import("../local/fs-cas.js");
  const { LocalWorkspaceManager } =
    require("../local/workspace.js") as typeof import("../local/workspace.js");

  const dbPath = join(groveDir, "grove.db");
  const casPath = join(groveDir, "cas");
  const groveRoot = dirname(groveDir);

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const outcomeStore = new SqliteOutcomeStore(db);
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore,
    cas,
  });

  return {
    contributionStore,
    claimStore,
    frontier,
    workspace,
    cas,
    outcomeStore,
    groveRoot,
    close() {
      contributionStore.close();
      workspace.close();
    },
  };
}
