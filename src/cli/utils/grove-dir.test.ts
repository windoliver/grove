import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentId, resolveGroveDir } from "./grove-dir.js";

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
