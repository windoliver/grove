/**
 * Bare-clone repo cache.
 *
 * Exposes one primary function, `resolveRepo`, which materializes a
 * RepoRef into a bare clone on disk and returns the path. Clones and
 * fetches are serialized per cache entry via `proper-lockfile`; lock
 * files live at `<cacheRoot>/.locks/` (outside the cache entry) so
 * corruption recovery cannot unlink a held lock.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
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
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function readOriginUrl(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", localPath, "remote", "get-url", "origin"],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolveRepo
// ---------------------------------------------------------------------------

export async function resolveRepo(
  ref: RepoRef,
  opts: ResolveRepoOptions = {},
): Promise<ResolvedRepo> {
  if (ref.kind === "local") {
    const origin = await readOriginUrl(ref.path);
    if (origin === null) {
      return {
        ref,
        bareClonePath: ref.path,
        key: "local",
        fetched: false,
        stale: false,
      };
    }
    // origin-present case handled in Task 11 — delegate to URL path
    return resolveRepo({ kind: "url", url: origin }, opts);
  }
  throw new Error("resolveRepo: URL path not yet implemented");
}
