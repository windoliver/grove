import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCacheRoot, resolveRepo } from "./repo-cache.js";

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
