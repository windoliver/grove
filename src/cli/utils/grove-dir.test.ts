import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGroveDir, resolveAgentId, resolveGroveDir } from "./grove-dir.js";

describe("resolveGroveDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Use realpath to resolve macOS /var -> /private/var symlink
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "grove-dir-test-")));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.GROVE_DIR;
  });

  test("finds .grove in explicit override path", async () => {
    const groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
    const result = resolveGroveDir(groveDir);
    expect(result.groveDir).toBe(groveDir);
    expect(result.dbPath).toBe(join(groveDir, "grove.db"));
  });

  test("finds .grove via GROVE_DIR env var", async () => {
    const groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
    process.env.GROVE_DIR = groveDir;
    const result = resolveGroveDir();
    expect(result.groveDir).toBe(groveDir);
  });

  test("explicit override takes priority over GROVE_DIR", async () => {
    const dir1 = join(tempDir, "one");
    const dir2 = join(tempDir, "two");
    await mkdir(dir1);
    await mkdir(dir2);
    process.env.GROVE_DIR = dir2;
    const result = resolveGroveDir(dir1);
    expect(result.groveDir).toBe(dir1);
  });

  test("throws when no .grove found", () => {
    // Use a temp dir with no .grove anywhere in its ancestry
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      expect(() => resolveGroveDir()).toThrow(/No grove found/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("walks up from cwd to find .grove", async () => {
    const groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
    const subDir = join(tempDir, "a", "b", "c");
    await mkdir(subDir, { recursive: true });

    const originalCwd = process.cwd();
    process.chdir(subDir);
    try {
      const result = resolveGroveDir();
      expect(result.groveDir).toBe(groveDir);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("findGroveDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "grove-find-test-")));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns undefined when no .grove anywhere up to FS root", () => {
    expect(findGroveDir(tempDir)).toBeUndefined();
  });

  test("returns startDir's .grove when it exists directly", async () => {
    const groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
    expect(findGroveDir(tempDir)).toBe(groveDir);
  });

  test("walks up to find ancestor .grove", async () => {
    const groveDir = join(tempDir, ".grove");
    await mkdir(groveDir);
    const subDir = join(tempDir, "a", "b", "c");
    await mkdir(subDir, { recursive: true });
    expect(findGroveDir(subDir)).toBe(groveDir);
  });

  test("fence semantics: child .grove wins over ancestor .grove", async () => {
    // parent .grove at tempDir
    await mkdir(join(tempDir, ".grove"));
    // child .grove at tempDir/wt
    const wt = join(tempDir, "wt");
    await mkdir(wt);
    const wtGrove = join(wt, ".grove");
    await mkdir(wtGrove);
    expect(findGroveDir(wt)).toBe(wtGrove);
  });

  test("fence semantics: child .grove wins even when incomplete (no grove.json)", async () => {
    // Parent has full grove
    const parentGrove = join(tempDir, ".grove");
    await mkdir(parentGrove);
    await Bun.write(join(parentGrove, "grove.json"), "{}");
    // Child has bare .grove (no grove.json)
    const wt = join(tempDir, "wt");
    await mkdir(wt);
    const wtGrove = join(wt, ".grove");
    await mkdir(wtGrove);
    // findGroveDir is artifact-agnostic — child wins regardless of grove.json
    expect(findGroveDir(wt)).toBe(wtGrove);
  });

  test("REGRESSION: walks past a regular FILE named .grove (not a fence)", async () => {
    // Parent has real grove
    const parentGrove = join(tempDir, ".grove");
    await mkdir(parentGrove);
    // Child has a regular file named .grove — should NOT fence
    const wt = join(tempDir, "wt");
    await mkdir(wt);
    await Bun.write(join(wt, ".grove"), "not a directory");
    // Walk-up must skip past the file and reach parent
    expect(findGroveDir(wt)).toBe(parentGrove);
  });

  test("REGRESSION: walks past a broken symlink named .grove (not a fence)", async () => {
    const parentGrove = join(tempDir, ".grove");
    await mkdir(parentGrove);
    const wt = join(tempDir, "wt");
    await mkdir(wt);
    // Create a broken symlink (target does not exist)
    const { symlink } = await import("node:fs/promises");
    await symlink(join(tempDir, "nonexistent-target"), join(wt, ".grove"));
    expect(findGroveDir(wt)).toBe(parentGrove);
  });

  test("REGRESSION: follows a symlink that resolves to a directory (fence)", async () => {
    // Real directory elsewhere
    const realGrove = join(tempDir, "real-grove-dir");
    await mkdir(realGrove);
    const wt = join(tempDir, "wt");
    await mkdir(wt);
    // .grove in wt is a symlink to the real directory
    const { symlink } = await import("node:fs/promises");
    await symlink(realGrove, join(wt, ".grove"));
    // Symlink resolves to a dir → fence applies, returns the symlink path
    expect(findGroveDir(wt)).toBe(join(wt, ".grove"));
  });
});

describe("resolveAgentId", () => {
  afterEach(() => {
    delete process.env.GROVE_AGENT_ID;
  });

  test("returns explicit override", () => {
    expect(resolveAgentId("my-agent")).toBe("my-agent");
  });

  test("returns GROVE_AGENT_ID env var", () => {
    process.env.GROVE_AGENT_ID = "env-agent";
    expect(resolveAgentId()).toBe("env-agent");
  });

  test("explicit override takes priority over env var", () => {
    process.env.GROVE_AGENT_ID = "env-agent";
    expect(resolveAgentId("explicit")).toBe("explicit");
  });

  test("falls back to user@hostname format", () => {
    const result = resolveAgentId();
    expect(result).toContain("@");
  });
});
