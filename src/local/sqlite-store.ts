/**
 * SQLite-backed contribution graph store.
 *
 * Uses Bun's built-in bun:sqlite for zero-dependency local storage.
 * Implements both ContributionStore and ClaimStore protocols.
 */

import type { ClaimStore, ContributionStore } from "../core/store.js";

/**
 * SQLite-backed store for contributions, relations, and claims.
 *
 * TODO: Implement in #8
 */
export class SqliteStore implements ContributionStore, ClaimStore {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ContributionStore — stub implementations
  put = async (): Promise<void> => {
    throw new Error("Not implemented");
  };
  get = async (): Promise<undefined> => {
    throw new Error("Not implemented");
  };
  list = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  children = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  ancestors = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  relationsOf = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  relatedTo = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  search = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  count = async (): Promise<number> => {
    throw new Error("Not implemented");
  };

  // ClaimStore — stub implementations
  createClaim = async (): Promise<void> => {
    throw new Error("Not implemented");
  };
  getClaim = async (): Promise<undefined> => {
    throw new Error("Not implemented");
  };
  heartbeat = async (): Promise<void> => {
    throw new Error("Not implemented");
  };
  release = async (): Promise<void> => {
    throw new Error("Not implemented");
  };
  complete = async (): Promise<void> => {
    throw new Error("Not implemented");
  };
  expireStale = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
  activeClaims = async (): Promise<readonly []> => {
    throw new Error("Not implemented");
  };
}
