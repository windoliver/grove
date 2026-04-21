/**
 * Bare-clone repo cache.
 *
 * Exposes one primary function, `resolveRepo`, which materializes a
 * RepoRef into a bare clone on disk and returns the path. Clones and
 * fetches are serialized per cache entry via `proper-lockfile`; lock
 * files live at `<cacheRoot>/.locks/` (outside the cache entry) so
 * corruption recovery cannot unlink a held lock.
 */

import { join } from "node:path";
import type { RepoRef } from "./repo-ref.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveRepoOptions {
  readonly fresh?: boolean;
  readonly cacheRoot?: string;
  readonly fetchTtlMs?: number;
  readonly timeoutMs?: number;
}

export interface ResolvedRepo {
  readonly ref: RepoRef;
  readonly bareClonePath: string;
  readonly key: string;
  readonly fetched: boolean;
  readonly stale: boolean;
}

interface CacheRootInputs {
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly override?: string;
}

// ---------------------------------------------------------------------------
// Cache-root resolution
// ---------------------------------------------------------------------------

export function resolveCacheRoot(inputs: CacheRootInputs): string {
  if (inputs.override) return inputs.override;
  const explicit = inputs.env.GROVE_REPO_CACHE;
  if (explicit && explicit.length > 0) return explicit;
  const xdg = inputs.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "grove", "repo-cache");
  const home = inputs.home;
  if (!home) throw new Error("cannot resolve cache root: no HOME and no XDG_CACHE_HOME");
  return join(home, ".cache", "grove", "repo-cache");
}

// ---------------------------------------------------------------------------
// resolveRepo — stub (filled in subsequent tasks)
// ---------------------------------------------------------------------------

export async function resolveRepo(
  _ref: RepoRef,
  _opts?: ResolveRepoOptions,
): Promise<ResolvedRepo> {
  throw new Error("resolveRepo: not implemented");
}
