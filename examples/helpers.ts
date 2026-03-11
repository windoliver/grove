/**
 * Shared test helpers for Grove example scenarios.
 *
 * Provides grove setup/cleanup and deterministic timestamp generation.
 * Each scenario imports these and passes its own contract.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroveContract } from "../src/core/contract.js";
import { EnforcingClaimStore, EnforcingContributionStore } from "../src/core/enforcing-store.js";
import { DefaultFrontierCalculator } from "../src/core/frontier.js";
import type { ClaimStore, ContributionStore } from "../src/core/store.js";
import { createSqliteStores } from "../src/local/sqlite-store.js";

// ---------------------------------------------------------------------------
// Grove context
// ---------------------------------------------------------------------------

export interface GroveContext {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: DefaultFrontierCalculator;
  readonly dbPath: string;
  readonly close: () => void;
}

let dbCounter = 0;

/**
 * Create a temporary grove with SQLite stores and enforcing wrappers.
 *
 * Also resets the timestamp generator to match the clock hour, so callers
 * don't need a separate `resetTimestamps()` call before generating
 * contribution timestamps.
 *
 * @param contract - GROVE.md contract to enforce.
 * @param label - Optional label for the temp database file name.
 * @param clockIso - ISO timestamp for the enforcing wrapper's clock (must
 *   be close to the scenario's deterministic timestamps to avoid clock-skew
 *   rejection). Defaults to "2026-03-10T10:05:00Z".
 */
export function setupGrove(
  contract: GroveContract,
  label = "e2e",
  clockIso = "2026-03-10T10:05:00Z",
): GroveContext {
  // Auto-sync the timestamp generator's hour with the enforcing clock so
  // generated timestamps don't trip the clock-skew guard.
  const clockHour = clockIso.slice(11, 13);
  resetTimestamps(clockHour);

  dbCounter += 1;
  const dbPath = join(tmpdir(), `grove-${label}-${Date.now()}-${dbCounter}.db`);
  const stores = createSqliteStores(dbPath);
  const clock = () => new Date(clockIso);
  const contributionStore = new EnforcingContributionStore(stores.contributionStore, contract, {
    clock,
  });
  const claimStore = new EnforcingClaimStore(stores.claimStore, contract);
  const frontier = new DefaultFrontierCalculator(contributionStore);
  return { contributionStore, claimStore, frontier, dbPath, close: stores.close };
}

/** Clean up a temporary grove — closes DB and removes files. */
export function cleanupGrove(ctx: GroveContext): void {
  ctx.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${ctx.dbPath}${suffix}`);
    } catch {
      /* ignore missing files */
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic timestamps
// ---------------------------------------------------------------------------

let timestampCounter = 0;
let timestampHourPrefix = "10";

/**
 * Generate the next sequential ISO timestamp.
 * Timestamps are deterministic and monotonically increasing.
 */
export function nextTimestamp(): string {
  timestampCounter += 1;
  const minutes = String(Math.floor(timestampCounter / 60)).padStart(2, "0");
  const seconds = String(timestampCounter % 60).padStart(2, "0");
  return `2026-03-10T${timestampHourPrefix}:${minutes}:${seconds}Z`;
}

/** Reset the timestamp counter and optionally set the hour prefix. */
export function resetTimestamps(hourPrefix = "10"): void {
  timestampCounter = 0;
  timestampHourPrefix = hourPrefix;
}
