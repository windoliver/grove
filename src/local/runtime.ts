/**
 * Local runtime factory — single entry point for initializing all local stores,
 * CAS, frontier calculator, workspace, and contract from a .grove directory.
 *
 * Consolidates the store initialization pattern previously duplicated across
 * server/serve.ts, mcp/serve.ts, mcp/serve-http.ts, and cli/context.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GroveContract } from "../core/contract.js";
import { parseGroveContract } from "../core/contract.js";
import type { FrontierCalculator } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { CachedFrontierCalculator } from "../gossip/cached-frontier.js";
import { FsCas } from "./fs-cas.js";
import type { SqliteBountyStore } from "./sqlite-bounty-store.js";
import type { SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
import type { SqliteOutcomeStore } from "./sqlite-outcome-store.js";
import type { SqliteClaimStore, SqliteContributionStore } from "./sqlite-store.js";
import { createSqliteStores } from "./sqlite-store.js";
import { LocalWorkspaceManager } from "./workspace.js";

/** Options for creating a local runtime. */
export interface LocalRuntimeOptions {
  /** Absolute path to the .grove directory. */
  readonly groveDir: string;
  /**
   * Frontier cache TTL in milliseconds.
   * - `0` disables caching (used by CLI for single-shot commands).
   * - Default: `30_000` (30 seconds).
   */
  readonly frontierCacheTtlMs?: number;
  /** Whether to initialize a workspace manager. Default: `true`. */
  readonly workspace?: boolean;
  /** Whether to parse the GROVE.md contract. Default: `false`. */
  readonly parseContract?: boolean;
}

/** All local stores, services, and resources. */
export interface LocalRuntime {
  readonly contributionStore: SqliteContributionStore;
  readonly claimStore: SqliteClaimStore;
  readonly bountyStore: SqliteBountyStore;
  readonly outcomeStore: SqliteOutcomeStore;
  readonly goalSessionStore: SqliteGoalSessionStore;
  readonly cas: FsCas;
  readonly frontier: FrontierCalculator;
  readonly workspace: LocalWorkspaceManager | undefined;
  readonly contract: GroveContract | undefined;
  /** Call after writing a contribution to invalidate the frontier cache. */
  readonly onContributionWrite: () => void;
  /** Absolute path to the project root (parent of .grove). */
  readonly groveRoot: string;
  /** Close all resources (database, CAS, workspace). */
  readonly close: () => void;
}

/**
 * Create a fully initialized local runtime from a .grove directory path.
 *
 * This is the canonical way to bootstrap Grove's local storage layer.
 * All entry points (server, MCP, CLI, TUI) should use this factory
 * instead of manually constructing stores.
 */
export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntime {
  const {
    groveDir,
    frontierCacheTtlMs = 30_000,
    workspace: createWorkspace = true,
    parseContract: shouldParseContract = false,
  } = options;

  const dbPath = join(groveDir, "grove.db");
  const casPath = join(groveDir, "cas");
  const groveRoot = resolve(groveDir, "..");

  const stores = createSqliteStores(dbPath);
  const cas = new FsCas(casPath);

  const baseFrontier = new DefaultFrontierCalculator(stores.contributionStore);
  const frontier: FrontierCalculator =
    frontierCacheTtlMs > 0
      ? new CachedFrontierCalculator(baseFrontier, frontierCacheTtlMs)
      : baseFrontier;

  const onContributionWrite =
    frontier instanceof CachedFrontierCalculator
      ? () => frontier.invalidate()
      : () => {
          /* no-op when caching is disabled */
        };

  // Wire write-driven cache invalidation: when a contribution is written,
  // the frontier cache is invalidated so the next read recomputes.
  stores.contributionStore.onWrite = onContributionWrite;

  let workspace: LocalWorkspaceManager | undefined;
  if (createWorkspace) {
    workspace = new LocalWorkspaceManager({
      groveRoot: groveDir,
      db: stores.db,
      contributionStore: stores.contributionStore,
      cas,
    });
  }

  let contract: GroveContract | undefined;
  if (shouldParseContract) {
    const contractPath = join(groveRoot, "GROVE.md");
    if (existsSync(contractPath)) {
      contract = parseGroveContract(readFileSync(contractPath, "utf-8"));
    }
  }

  return {
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    bountyStore: stores.bountyStore,
    outcomeStore: stores.outcomeStore,
    goalSessionStore: stores.goalSessionStore,
    cas,
    frontier,
    workspace,
    contract,
    onContributionWrite,
    groveRoot,
    close: () => {
      workspace?.close();
      cas.close();
      stores.close();
    },
  };
}
