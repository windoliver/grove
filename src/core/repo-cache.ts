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
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import type { RepoRef } from "./repo-ref.js";
import { deriveCachePath, normalizeUrl } from "./repo-ref.js";

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
// Helpers
// ---------------------------------------------------------------------------

interface Manifest {
  canonicalUrl: string;
  aliases: string[];
  createdAt: string;
  lastFetchedAt: string;
  lastAccessedAt: string;
}

function encodeLockName(key: string): string {
  return key.replace(/\//g, "__");
}

async function runGit(
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    await execFileAsync("git", args as string[], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

async function writeOkSentinel(metaDir: string): Promise<void> {
  const tmp = join(metaDir, ".ok.tmp");
  const final = join(metaDir, ".ok");
  await writeFile(tmp, "", "utf-8");
  await rename(tmp, final);
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

  const cacheRoot = resolveCacheRoot({
    env: process.env,
    ...(process.env.HOME !== undefined && { home: process.env.HOME }),
    ...(opts.cacheRoot !== undefined && { override: opts.cacheRoot }),
  });
  const normalized = normalizeUrl(ref.url);
  const key = deriveCachePath(normalized);
  const cacheDir = join(cacheRoot, key);
  const metaDir = join(cacheDir, ".grove-cache");
  const locksDir = join(cacheRoot, ".locks");
  const lockFile = join(locksDir, `${encodeLockName(key)}.lock`);

  await mkdir(locksDir, { recursive: true });
  // proper-lockfile requires the target to exist
  if (!existsSync(lockFile)) await writeFile(lockFile, "", "utf-8");

  const release = await lockfile.lock(lockFile, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 500 },
  });
  try {
    const okPath = join(metaDir, ".ok");
    const okPresent = existsSync(okPath);

    if (!okPresent) {
      // Fresh clone (or recovery from a prior crash; Task 8 covers recovery branch).
      if (existsSync(cacheDir)) {
        await rm(cacheDir, { recursive: true, force: true });
      }
      await mkdir(cacheDir, { recursive: true });
      await runGit(["clone", "--bare", ref.url, cacheDir], {
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      await mkdir(metaDir, { recursive: true });
      const now = new Date().toISOString();
      const manifest: Manifest = {
        canonicalUrl: ref.url,
        aliases: [ref.url],
        createdAt: now,
        lastFetchedAt: now,
        lastAccessedAt: now,
      };
      await writeManifest(metaDir, manifest);
      await writeFile(join(metaDir, "last-fetch"), "", "utf-8");
      await writeOkSentinel(metaDir);
      return { ref, bareClonePath: cacheDir, key, fetched: true, stale: false };
    }

    // Cache-hit path fills in Task 6.
    throw new Error("resolveRepo: cache-hit path not yet implemented");
  } finally {
    await release();
  }
}
