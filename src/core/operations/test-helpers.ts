/**
 * Shared test utilities for operation tests.
 *
 * Provides OperationDeps backed by real SQLite and filesystem CAS.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsCas } from "../../local/fs-cas.js";
import { SqliteBountyStore } from "../../local/sqlite-bounty-store.js";
import {
  initSqliteDb,
  SqliteClaimStore,
  SqliteContributionStore,
} from "../../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../../local/workspace.js";
import type { ContentStore } from "../cas.js";
import type { GroveContract } from "../contract.js";
import { DefaultFrontierCalculator } from "../frontier.js";
import { InMemoryCreditsService } from "../in-memory-credits.js";
import type { OutcomeStore } from "../outcome.js";
import type { OperationDeps } from "./deps.js";

/** OperationDeps with all fields guaranteed present (for tests). */
export type FullOperationDeps = {
  readonly [K in keyof Required<OperationDeps>]: NonNullable<OperationDeps[K]>;
};

/** A test OperationDeps instance with cleanup function. */
export interface TestOperationDeps {
  readonly deps: FullOperationDeps;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Create OperationDeps backed by real SQLite and filesystem CAS.
 * Call cleanup() in afterEach to remove the temp directory.
 */
export async function createTestOperationDeps(): Promise<TestOperationDeps> {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-ops-test-"));
  const dbPath = join(tempDir, "test.db");
  const casPath = join(tempDir, "cas");
  const groveRoot = tempDir;

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const bountyStore = new SqliteBountyStore(db);
  const creditsService = new InMemoryCreditsService();
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore,
    cas,
  });

  const deps: FullOperationDeps = {
    contributionStore,
    claimStore,
    bountyStore,
    creditsService,
    cas,
    frontier,
    workspace,
    contract: undefined as unknown as GroveContract,
    outcomeStore: undefined as unknown as OutcomeStore,
    onContributionWrite: () => {
      /* no-op for tests */
    },
    eventBus: undefined as unknown as NonNullable<OperationDeps["eventBus"]>,
    topologyRouter: undefined as unknown as NonNullable<OperationDeps["topologyRouter"]>,
    hookRunner: undefined as unknown as NonNullable<OperationDeps["hookRunner"]>,
    hookCwd: undefined as unknown as string,
  };

  return {
    deps,
    tempDir,
    cleanup: async () => {
      workspace.close();
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Store test content in CAS and return its hash.
 */
export async function storeTestContent(cas: ContentStore, content: string): Promise<string> {
  return cas.put(new TextEncoder().encode(content));
}
