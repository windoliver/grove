/**
 * Shared paginated listing helper for Nexus store adapters.
 *
 * Extracts the common `listAllPages` logic that was duplicated across
 * NexusBountyStore, NexusContributionStore, NexusClaimStore, and
 * NexusOutcomeStore.
 *
 * CRIT-3 fix: instead of swallowing all errors with `.catch(() => [])`,
 * only returns an empty array when the directory does not exist
 * (NexusNotFoundError). All other errors — auth failures, network
 * errors, etc. — propagate to the caller.
 */

import type { ListEntry, ListOptions, NexusClient } from "./client.js";
import type { ResolvedNexusConfig } from "./config.js";
import { NexusNotFoundError } from "./errors.js";
import { withRetry, withSemaphore } from "./retry.js";
import type { Semaphore } from "./semaphore.js";

/**
 * Paginate through all pages of a `client.list()` call, collecting
 * every entry into a single array.
 *
 * @param client    - The Nexus VFS client.
 * @param semaphore - Concurrency limiter shared by the calling store.
 * @param config    - Resolved config (supplies retry parameters).
 * @param dir       - Directory path to list.
 * @param opts      - Optional listing options (recursive, details, limit).
 * @returns All entries across all pages, or `[]` if the directory does
 *          not exist (NexusNotFoundError).
 * @throws Any error other than "directory not found" after retry
 *         exhaustion — auth errors, network errors, etc.
 */
export async function listAllPages(
  client: NexusClient,
  semaphore: Semaphore,
  config: ResolvedNexusConfig,
  dir: string,
  opts?: Omit<ListOptions, "cursor">,
): Promise<readonly ListEntry[]> {
  const entries: ListEntry[] = [];
  let cursor: string | undefined;

  try {
    do {
      const listing = await withRetry(
        () => withSemaphore(semaphore, () => client.list(dir, { ...opts, cursor })),
        "listAllPages",
        config,
      );

      for (const entry of listing.files) {
        entries.push(entry);
      }
      cursor = listing.hasMore ? listing.nextCursor : undefined;
    } while (cursor !== undefined);
  } catch (error: unknown) {
    if (error instanceof NexusNotFoundError) {
      return [];
    }
    throw error;
  }

  return entries;
}
