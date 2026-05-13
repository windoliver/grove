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
import type { CreditsService } from "../core/credits.js";
import type { FrontierCalculator } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import {
  FrontierRewardService,
  frontierRewardEligibleMetrics,
} from "../core/frontier-reward-service.js";
import type { WatchHub } from "../core/watch-hub.js";
import { CachedFrontierCalculator } from "../gossip/cached-frontier.js";
import { FsCas } from "./fs-cas.js";
import type { SqliteBountyStore } from "./sqlite-bounty-store.js";
import type { SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";
import type { SqliteOutcomeStore } from "./sqlite-outcome-store.js";
import type {
  SqliteAgentTaskStore,
  SqliteClaimStore,
  SqliteContributionStore,
  SqliteIdempotencyStore,
} from "./sqlite-store.js";
import { createSqliteStores } from "./sqlite-store.js";
import { createWatchHubRecorder } from "./watch-hub-recorder.js";
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
  /** Whether to parse the GROVE.md contract. Default: `true`. */
  readonly parseContract?: boolean;
  /**
   * Optional process-local `WatchHub` to which contribution + claim writes
   * are republished as `EntityWriteEvent`s. When provided, the runtime
   * wires `SqliteContributionStore.onContributionWrite` and
   * `SqliteClaimStore.onClaimWrite` to the recorder shipped in #388 PR2.
   * When omitted, no hub plumbing is created — existing CLI / server
   * callers that supply their own `OperationDeps.onEntityWrite` path are
   * unaffected.
   */
  readonly watchHub?: WatchHub | undefined;
  /**
   * Namespace under which entity write events are emitted. Required when
   * `watchHub` is provided. Mirrors the server-side namespace passed to
   * `OperationDeps.namespace`.
   */
  readonly watchNamespace?: string | undefined;
}

/** All local stores, services, and resources. */
export interface LocalRuntime {
  /**
   * Raw SQLite database handle. Exposed for callers that need to construct
   * additional session-scoped store instances after startup (e.g.
   * serve-http.ts building a per-request SqliteHandoffStore once it has
   * resolved the current session ID).
   */
  readonly db: import("bun:sqlite").Database;
  readonly contributionStore: SqliteContributionStore;
  readonly claimStore: SqliteClaimStore;
  readonly agentTaskStore: SqliteAgentTaskStore;
  readonly bountyStore: SqliteBountyStore;
  readonly outcomeStore: SqliteOutcomeStore;
  readonly goalSessionStore: SqliteGoalSessionStore;
  readonly handoffStore: import("./sqlite-handoff-store.js").SqliteHandoffStore;
  readonly idempotencyStore: SqliteIdempotencyStore;
  readonly creditsService: CreditsService;
  readonly frontierRewardService: FrontierRewardService;
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
    parseContract: shouldParseContract = true,
  } = options;

  const dbPath = join(groveDir, "grove.db");
  const casPath = join(groveDir, "cas");
  const groveRoot = resolve(groveDir, "..");

  // Pass GROVE_SESSION_ID to the handoff store so it scopes all
  // reads/writes to the active session. This enables proactive deadline
  // timers and ack receipts safely — session A's watcher cannot flip
  // session B's rows, and a role-bound ack cannot cross session boundaries.
  // When GROVE_SESSION_ID is unset (CLI/tests), the store falls back to
  // unscoped mode for backwards compatibility.
  const envSessionId = process.env.GROVE_SESSION_ID;
  const stores = createSqliteStores(dbPath, {
    ...(envSessionId ? { sessionId: envSessionId } : {}),
  });
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

  // Wire local-mode WatchHub republish (#388 PR2). The recorder projects
  // domain types via `contributionToEntity` / `claimToEntity` and calls
  // `WatchHub.recordWrite`. AgentSession is wired by the TUI main entry
  // (it owns the AgentRuntime), not here.
  if (options.watchHub) {
    if (!options.watchNamespace) {
      throw new Error("createLocalRuntime: watchNamespace is required when watchHub is provided");
    }
    const recorder = createWatchHubRecorder({
      hub: options.watchHub,
      namespace: options.watchNamespace,
    });
    stores.contributionStore.onContributionWrite = (op, c) => recorder.contribution(op, c);
    stores.claimStore.onClaimWrite = (op, c) => recorder.claim(op, c);
  }

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
  try {
    if (shouldParseContract) {
      // Session-scoped config: when GROVE_SESSION_ID is set, prefer the frozen
      // contract snapshot from the session record. Configless sessions are valid
      // legacy/current state and should fall back to live GROVE.md.
      if (envSessionId) {
        const result = stores.goalSessionStore.resolveSessionConfigSync(envSessionId);
        if (result.kind === "ok") {
          contract = result.config;
        } else if (result.kind === "not-found") {
          throw new Error(
            `Session ${envSessionId} not found. GROVE_SESSION_ID points at a ` +
              `session that does not exist in this grove's session store.`,
          );
        } else if (result.kind === "malformed") {
          throw new Error(
            `Session ${envSessionId} has malformed config_json: ${result.reason}. ` +
              `Refusing to proceed with unknown enforcement state.`,
          );
        }
      }
      if (contract === undefined) {
        const contractPath = join(groveRoot, "GROVE.md");
        if (existsSync(contractPath)) {
          contract = parseGroveContract(readFileSync(contractPath, "utf-8"));
        }
      }
    }
  } catch (err) {
    workspace?.close();
    cas.close();
    stores.close();
    throw err;
  }

  const frontierRewardService = new FrontierRewardService({
    frontier,
    bountyStore: stores.bountyStore,
    creditsService: stores.creditsService,
    eligibleMetrics: frontierRewardEligibleMetrics(contract),
  });

  return {
    db: stores.db,
    contributionStore: stores.contributionStore,
    claimStore: stores.claimStore,
    agentTaskStore: stores.agentTaskStore,
    bountyStore: stores.bountyStore,
    outcomeStore: stores.outcomeStore,
    goalSessionStore: stores.goalSessionStore,
    handoffStore: stores.handoffStore,
    idempotencyStore: stores.idempotencyStore,
    creditsService: stores.creditsService,
    frontierRewardService,
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
