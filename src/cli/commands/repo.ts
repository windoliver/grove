/**
 * `grove repo` subcommands — inspect and maintain the bare-clone cache.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { type ResolveRepoOptions, resolveCacheRoot, resolveRepo } from "../../core/repo-cache.js";

const execFileAsync = promisify(execFile);

export interface CacheEntry {
  readonly key: string;
  readonly bareClonePath: string;
  readonly canonicalUrl: string;
  readonly aliases: readonly string[];
  readonly createdAt: string;
  readonly lastFetchedAt: string;
  readonly lastAccessedAt: string;
}

async function walkEntries(cacheRoot: string): Promise<CacheEntry[]> {
  if (!existsSync(cacheRoot)) return [];
  const entries: CacheEntry[] = [];

  async function recurse(dir: string, relParts: string[]): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name === ".locks") continue;
      const child = join(dir, item.name);
      if (item.name.endsWith(".git")) {
        const manifestPath = join(child, ".grove-cache", "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        entries.push({
          key: [...relParts, item.name].join("/"),
          bareClonePath: child,
          canonicalUrl: manifest.canonicalUrl,
          aliases: manifest.aliases,
          createdAt: manifest.createdAt,
          lastFetchedAt: manifest.lastFetchedAt,
          lastAccessedAt: manifest.lastAccessedAt,
        });
      } else {
        await recurse(child, [...relParts, item.name]);
      }
    }
  }

  await recurse(cacheRoot, []);
  return entries;
}

export async function listCache(opts: { cacheRoot: string }): Promise<CacheEntry[]> {
  return walkEntries(opts.cacheRoot);
}

export async function pruneCache(opts: {
  cacheRoot: string;
  key?: string;
  all?: boolean;
}): Promise<void> {
  const entries = await walkEntries(opts.cacheRoot);
  const targets = opts.all ? entries : entries.filter((e) => e.key === opts.key);

  if (!opts.all && targets.length === 0) {
    throw new Error(`no cache entry matches key: ${opts.key}`);
  }

  for (const entry of targets) {
    // Worktree safety: if any worktree outside the bare clone itself references
    // this entry, refuse — pruning would strand it.
    const { stdout } = await execFileAsync("git", [
      "-C",
      entry.bareClonePath,
      "worktree",
      "list",
      "--porcelain",
    ]);
    // Resolve both paths to their real (symlink-resolved) form so that macOS
    // /var → /private/var symlinks don't cause false mismatches.
    const realBareClonePath = await realpath(entry.bareClonePath).catch(() => entry.bareClonePath);
    const rawPaths = stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace(/^worktree /, ""));
    const external: string[] = [];
    for (const p of rawPaths) {
      const realP = await realpath(p).catch(() => p);
      if (realP !== realBareClonePath) external.push(p);
    }
    if (external.length > 0) {
      throw new Error(
        `cannot prune ${entry.key}: ${external.length} worktree(s) still reference it:\n${external.join("\n")}`,
      );
    }
    await rm(entry.bareClonePath, { recursive: true, force: true });
  }

  // Best-effort: remove the matching lockfile(s) too.
  const locksDir = join(opts.cacheRoot, ".locks");
  if (existsSync(locksDir)) {
    for (const entry of targets) {
      const lockFile = join(locksDir, `${entry.key.replace(/\//g, "__")}.lock`);
      if (existsSync(lockFile)) await rm(lockFile, { force: true });
    }
  }
}

export async function fetchCache(opts: {
  cacheRoot: string;
  key: string;
  resolveOpts?: Partial<ResolveRepoOptions>;
}): Promise<{ fetched: boolean; stale: boolean }> {
  const entries = await walkEntries(opts.cacheRoot);
  const entry = entries.find((e) => e.key === opts.key);
  if (!entry) throw new Error(`no cache entry matches key: ${opts.key}`);
  const result = await resolveRepo(
    { kind: "url", url: entry.canonicalUrl },
    { ...(opts.resolveOpts ?? {}), cacheRoot: opts.cacheRoot, fresh: true },
  );
  return { fetched: result.fetched, stale: result.stale };
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

function currentCacheRoot(): string {
  const home = process.env.HOME;
  return resolveCacheRoot({
    env: process.env,
    ...(home !== undefined && { home }),
  });
}

export async function executeRepo(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "list":
      await runList();
      return;
    case "prune":
      await runPrune(rest);
      return;
    case "fetch":
      await runFetch(rest);
      return;
    default:
      console.log(`grove repo <subcommand>

Subcommands:
  list                       List every cached repo with manifest summary
  prune <key>                Remove one cache entry (refuses if worktrees reference it)
  prune --all                Remove every cache entry
  fetch <key>                Force a fetch on an existing cache entry

Cache root:
  ${currentCacheRoot()}`);
  }
}

async function runList(): Promise<void> {
  const cacheRoot = currentCacheRoot();
  const entries = await listCache({ cacheRoot });
  if (entries.length === 0) {
    console.log(`no cached repos (cache root: ${cacheRoot})`);
    return;
  }
  for (const e of entries) {
    console.log(e.key);
    console.log(`  url:         ${e.canonicalUrl}`);
    console.log(`  bareClone:   ${e.bareClonePath}`);
    console.log(`  lastFetched: ${e.lastFetchedAt}`);
    console.log(`  aliases:     ${e.aliases.length}`);
  }
}

async function runPrune(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { all: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const cacheRoot = currentCacheRoot();
  if (values.all) {
    await pruneCache({ cacheRoot, all: true });
    console.log("pruned all cache entries");
    return;
  }
  const key = positionals[0];
  if (!key) {
    console.error("grove repo prune: pass a key or --all");
    process.exitCode = 1;
    return;
  }
  await pruneCache({ cacheRoot, key });
  console.log(`pruned ${key}`);
}

async function runFetch(args: readonly string[]): Promise<void> {
  const key = args[0];
  if (!key) {
    console.error("grove repo fetch: pass a cache key (see `grove repo list`)");
    process.exitCode = 1;
    return;
  }
  const cacheRoot = currentCacheRoot();
  const result = await fetchCache({ cacheRoot, key });
  console.log(`fetch ${key}: fetched=${result.fetched} stale=${result.stale}`);
}
