import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveCacheRoot } from "./repo-cache.js";

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
