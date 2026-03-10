/**
 * Tests for SqliteStore using conformance test suites.
 *
 * Creates a fresh SQLite database in a temp directory for each test,
 * and tears it down after.
 *
 * Tests the legacy SqliteStore (combined), SqliteContributionStore,
 * and SqliteClaimStore independently.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClaimStoreTests } from "../core/claim-store.conformance.js";
import { runContributionStoreTests } from "../core/store.conformance.js";
import { createSqliteStores, SqliteStore } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Legacy SqliteStore — ContributionStore conformance
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-store-contrib-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);

  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Legacy SqliteStore — ClaimStore conformance
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-store-claim-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);

  return {
    store,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Split stores — ContributionStore conformance
// ---------------------------------------------------------------------------

runContributionStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-split-contrib-"));
  const dbPath = join(dir, "test.db");
  const { contributionStore, close } = createSqliteStores(dbPath);

  return {
    store: contributionStore,
    cleanup: async () => {
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Split stores — ClaimStore conformance
// ---------------------------------------------------------------------------

runClaimStoreTests(async () => {
  const dir = await mkdtemp(join(tmpdir(), "sqlite-split-claim-"));
  const dbPath = join(dir, "test.db");
  const { claimStore, close } = createSqliteStores(dbPath);

  return {
    store: claimStore,
    cleanup: async () => {
      close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
