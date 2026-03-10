/**
 * Shared test utilities for MCP tests.
 *
 * Provides McpDeps backed by real SQLite (in-memory via temp dir)
 * following the same pattern as CLI command tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentStore } from "../core/cas.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { FsCas } from "../local/fs-cas.js";
import { initSqliteDb, SqliteClaimStore, SqliteContributionStore } from "../local/sqlite-store.js";
import { LocalWorkspaceManager } from "../local/workspace.js";
import type { McpDeps } from "./deps.js";

/** A test McpDeps instance with cleanup function. */
export interface TestMcpDeps {
  readonly deps: McpDeps;
  readonly tempDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Create McpDeps backed by real SQLite and filesystem CAS in a temp directory.
 * Call cleanup() in afterEach to remove the temp directory.
 */
export async function createTestMcpDeps(): Promise<TestMcpDeps> {
  const tempDir = await mkdtemp(join(tmpdir(), "grove-mcp-test-"));
  const dbPath = join(tempDir, "test.db");
  const casPath = join(tempDir, "cas");
  const groveRoot = tempDir;

  const db = initSqliteDb(dbPath);
  const contributionStore = new SqliteContributionStore(db);
  const claimStore = new SqliteClaimStore(db);
  const cas = new FsCas(casPath);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  const workspace = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore,
    cas,
  });

  const deps: McpDeps = {
    contributionStore,
    claimStore,
    cas,
    frontier,
    workspace,
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
 * Convenience for tests that need artifact content hashes.
 */
export async function storeTestContent(cas: ContentStore, content: string): Promise<string> {
  return cas.put(new TextEncoder().encode(content));
}
