import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCacheRoot, resolveRepo } from "./repo-cache.js";

function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-rc-fx-"));
  execSync("git -c init.defaultBranch=main init --bare", { cwd: dir, stdio: "pipe" });
  // Push an initial commit via a scratch clone
  const scratch = mkdtempSync(join(tmpdir(), "grove-rc-scratch-"));
  execSync(`git clone "${dir}" "${scratch}"`, { stdio: "pipe" });
  execSync('git config user.email "t@t"', { cwd: scratch, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: scratch, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: scratch, stdio: "pipe" });
  execSync("git branch -M main", { cwd: scratch, stdio: "pipe" });
  execSync("git push origin main", { cwd: scratch, stdio: "pipe" });
  rmSync(scratch, { recursive: true, force: true });
  return dir;
}

describe("resolveCacheRoot", () => {
  test("honors GROVE_REPO_CACHE when set", () => {
    const env = { GROVE_REPO_CACHE: "/tmp/custom-cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env })).toBe("/tmp/custom-cache");
  });

  test("honors explicit option over env", () => {
    const env = { GROVE_REPO_CACHE: "/tmp/env-cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, override: "/tmp/opt-cache" })).toBe("/tmp/opt-cache");
  });

  test("uses XDG_CACHE_HOME when set", () => {
    const env = { XDG_CACHE_HOME: "/xdg/cache" } as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, home: "/home/me" })).toBe("/xdg/cache/grove/repo-cache");
  });

  test("falls back to ~/.cache/grove/repo-cache", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveCacheRoot({ env, home: "/home/me" })).toBe(
      join("/home/me", ".cache/grove/repo-cache"),
    );
  });

  test("rejects empty HOME with no env overrides", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => resolveCacheRoot({ env, home: "" })).toThrow(/HOME/);
  });
});

describe("resolveRepo — local path without origin", () => {
  test("returns the local path verbatim and skips the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-rc-local-"));
    try {
      execSync("git init", { cwd: dir, stdio: "pipe" });
      execSync('git config user.email "t@t"', { cwd: dir, stdio: "pipe" });
      execSync('git config user.name "t"', { cwd: dir, stdio: "pipe" });
      execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "pipe" });

      const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
      try {
        const result = await resolveRepo({ kind: "local", path: dir }, { cacheRoot });
        expect(result.bareClonePath).toBe(dir);
        expect(result.fetched).toBe(false);
        expect(result.stale).toBe(false);
        expect(result.key).toBe("local");
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepo — fresh clone", () => {
  test("clones into cache, writes .ok, manifest, last-fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const result = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });

      expect(result.fetched).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.key).toBe(`local/${fixture.replace(/^\//, "")}.git`);
      expect(existsSync(join(result.bareClonePath, "HEAD"))).toBe(true);
      expect(existsSync(join(result.bareClonePath, ".grove-cache", ".ok"))).toBe(true);
      expect(existsSync(join(result.bareClonePath, ".grove-cache", "last-fetch"))).toBe(true);

      const manifest = JSON.parse(
        readFileSync(join(result.bareClonePath, ".grove-cache", "manifest.json"), "utf-8"),
      );
      expect(manifest.canonicalUrl).toBe(`file://${fixture}`);
      expect(manifest.aliases).toEqual([`file://${fixture}`]);
      expect(typeof manifest.createdAt).toBe("string");
      expect(typeof manifest.lastFetchedAt).toBe("string");
      expect(typeof manifest.lastAccessedAt).toBe("string");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("resolveRepo — cache hit", () => {
  test("second call within TTL does not fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(first.fetched).toBe(true);

      const second = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(second.fetched).toBe(false);
      expect(second.stale).toBe(false);
      expect(second.bareClonePath).toBe(first.bareClonePath);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("TTL expiry triggers fetch", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 0 },
      );
      expect(first.fetched).toBe(true);

      // Backdate last-fetch by 10s
      const lastFetch = join(first.bareClonePath, ".grove-cache", "last-fetch");
      const past = new Date(Date.now() - 10_000);
      utimesSync(lastFetch, past, past);

      const second = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 1000 },
      );
      expect(second.fetched).toBe(true);
      expect(second.stale).toBe(false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("appends new alias on URL-form change", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      await resolveRepo({ kind: "url", url: `file://${fixture}/` }, { cacheRoot }); // trailing slash → same key

      const manifestPath = join(
        cacheRoot,
        `local/${fixture.replace(/^\//, "")}.git`,
        ".grove-cache",
        "manifest.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.aliases).toContain(`file://${fixture}`);
      expect(manifest.aliases).toContain(`file://${fixture}/`);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("resolveRepo — fresh hard-fail", () => {
  test("opts.fresh + unreachable remote throws", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      // Prime the cache against the fixture.
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      // Nuke the fixture so the next fetch fails.
      rmSync(fixture, { recursive: true, force: true });

      await expect(
        resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot, fresh: true }),
      ).rejects.toThrow(/--fresh fetch failed/);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("stale path (no --fresh) proceeds with stale=true when fetch fails", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      rmSync(fixture, { recursive: true, force: true });

      const result = await resolveRepo(
        { kind: "url", url: `file://${fixture}` },
        { cacheRoot, fetchTtlMs: 0 },
      );
      expect(result.stale).toBe(true);
      expect(result.fetched).toBe(false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveRepo — corruption recovery", () => {
  test("absent .ok triggers nuke + re-clone", async () => {
    const fixture = makeFixtureRepo();
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      const first = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(first.fetched).toBe(true);

      // Simulate crash: remove .ok, leave garbage behind.
      rmSync(join(first.bareClonePath, ".grove-cache", ".ok"));
      writeFileSync(join(first.bareClonePath, "garbage"), "x");

      const second = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
      expect(second.fetched).toBe(true);
      expect(existsSync(join(second.bareClonePath, "garbage"))).toBe(false);
      expect(existsSync(join(second.bareClonePath, ".grove-cache", ".ok"))).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("resolveRepo — timeout", () => {
  test("clone timeout throws and leaves the entry recoverable", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "grove-rc-cache-"));
    try {
      // Use a non-existent remote to force a slow git failure; 1ms timeout ensures abort.
      await expect(
        resolveRepo(
          { kind: "url", url: "https://example.invalid/does/not/exist" },
          { cacheRoot, timeoutMs: 1 },
        ),
      ).rejects.toBeDefined();

      // Next call (with a working fixture) must still succeed — the failed
      // cacheDir must either not exist or be recoverable.
      const fixture = makeFixtureRepo();
      try {
        // Different URL → different cache entry; just prove the cache root itself is usable.
        const result = await resolveRepo({ kind: "url", url: `file://${fixture}` }, { cacheRoot });
        expect(result.fetched).toBe(true);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
