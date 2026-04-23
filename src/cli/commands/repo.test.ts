import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepo } from "../../core/repo-cache.js";
import { fetchCache, listCache, pruneCache } from "./repo.js";

function makeFixtureBare(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-repo-fx-"));
  execSync("git -c init.defaultBranch=main init --bare", { cwd: dir, stdio: "pipe" });
  const scratch = mkdtempSync(join(tmpdir(), "grove-repo-scratch-"));
  execSync(`git clone "${dir}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });
  return dir;
}

describe("grove repo CLI helpers", () => {
  let cacheRoot: string;
  let fixtures: string[];

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "grove-repo-cli-"));
    fixtures = [];
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f, { recursive: true, force: true });
  });

  test("list returns zero entries on empty cache", async () => {
    const entries = await listCache({ cacheRoot });
    expect(entries).toEqual([]);
  });

  test("list returns entries after a resolve", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    const entries = await listCache({ cacheRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonicalUrl).toBe(`file://${f}`);
    expect(entries[0]!.key).toBe(`local/${f.replace(/^\//, "")}.git`);
  });

  test("prune removes a specific entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    await pruneCache({ cacheRoot, key: resolved.key });
    expect(existsSync(resolved.bareClonePath)).toBe(false);
  });

  test("prune --all removes every entry", async () => {
    const f1 = makeFixtureBare();
    const f2 = makeFixtureBare();
    fixtures.push(f1, f2);
    await resolveRepo({ kind: "url", url: `file://${f1}` }, { cacheRoot });
    await resolveRepo({ kind: "url", url: `file://${f2}` }, { cacheRoot });

    await pruneCache({ cacheRoot, all: true });
    const entries = await listCache({ cacheRoot });
    expect(entries).toEqual([]);
  });

  test("prune refuses when a worktree still references the entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });
    const wt = mkdtempSync(join(tmpdir(), "grove-repo-wt-"));
    try {
      execSync(`git -C "${resolved.bareClonePath}" worktree add "${wt}"`, { stdio: "pipe" });
      await expect(pruneCache({ cacheRoot, key: resolved.key })).rejects.toThrow(/worktree/);
      expect(existsSync(resolved.bareClonePath)).toBe(true);
    } finally {
      try {
        execSync(`git -C "${resolved.bareClonePath}" worktree remove --force "${wt}"`, {
          stdio: "pipe",
        });
      } catch {
        // best-effort
      }
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("fetch forces a fetch on the cache entry", async () => {
    const f = makeFixtureBare();
    fixtures.push(f);
    const resolved = await resolveRepo({ kind: "url", url: `file://${f}` }, { cacheRoot });

    const result = await fetchCache({ cacheRoot, key: resolved.key });
    expect(result.fetched).toBe(true);
  });
});
