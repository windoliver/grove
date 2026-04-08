/**
 * Periodic storage cleanup — expires stale claims, removes completed claims,
 * garbage-collects unreferenced CAS blobs, and archives stale sessions.
 *
 * Designed to be called on a timer from `grove up` (headless mode).
 */

import type { ClaimStore } from "../core/store.js";
import type { FsCas } from "./fs-cas.js";
import type { GoalSessionStore } from "./sqlite-goal-session-store.js";
import type { SqliteContributionStore } from "./sqlite-store.js";

/** Result of a single cleanup pass. */
export interface CleanupResult {
  readonly expiredClaims: number;
  readonly cleanedClaims: number;
}

/** Result of an artifact GC pass. */
export interface ArtifactGcResult {
  readonly deletedBlobs: number;
}

/** Default retention period for completed/expired/released claims (7 days). */
const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Run claim cleanup: expire stale leases and delete old terminal claims.
 */
export async function runCleanup(deps: { claimStore: ClaimStore }): Promise<CleanupResult> {
  const expired = await deps.claimStore.expireStale();
  const cleaned = await deps.claimStore.cleanCompleted(CLAIM_RETENTION_MS);
  return { expiredClaims: expired.length, cleanedClaims: cleaned };
}

/**
 * Run artifact garbage collection: delete CAS blobs not referenced by any
 * contribution's artifacts.
 */
export async function runArtifactGc(deps: {
  contributionStore: SqliteContributionStore;
  cas: FsCas;
}): Promise<ArtifactGcResult> {
  const referencedHashes = deps.contributionStore.allContentHashes();
  const deletedBlobs = await deps.cas.gc(referencedHashes);
  return { deletedBlobs };
}

/** Result of a session GC pass. */
export interface SessionGcResult {
  readonly archivedSessions: number;
}

/**
 * Archive sessions that have been inactive longer than the TTL and are not
 * in an active or pending state. Safe to call repeatedly — already-archived
 * sessions are skipped.
 */
export function runSessionGc(deps: {
  goalSessionStore: Pick<GoalSessionStore, "gcStaleSessions">;
  ttlMs?: number;
}): SessionGcResult {
  const archivedSessions = deps.goalSessionStore.gcStaleSessions(deps.ttlMs);
  return { archivedSessions };
}
