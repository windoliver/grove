/**
 * Tests for git diff ingestion into CAS.
 *
 * Uses real temporary git repos for accurate testing.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsCas } from "../fs-cas.js";
import { ingestGitDiff } from "./git-diff.js";

async function createTempGitRepo(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-git-diff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });

  // Initialize git repo
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };

  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@grove.dev"]);
  await run(["git", "config", "user.name", "Test"]);

  return dir;
}

describe("ingestGitDiff", () => {
  test("ingests a git diff as a single artifact", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      // Create initial commit
      await writeFile(join(repoDir, "file.txt"), "original");
      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      // Make a change
      await writeFile(join(repoDir, "file.txt"), "modified");

      const artifacts = await ingestGitDiff(cas, "HEAD", repoDir);

      expect(Object.keys(artifacts)).toEqual(["diff"]);
      const hash = artifacts.diff as string;
      expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);

      // Verify the diff content is in CAS
      const data = await cas.get(hash);
      expect(data).toBeDefined();
      expect(data).not.toBeUndefined();
      const diffText = new TextDecoder().decode(data as Uint8Array);
      expect(diffText).toContain("original");
      expect(diffText).toContain("modified");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns empty map when no diff", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      // Create commit with no uncommitted changes
      await writeFile(join(repoDir, "file.txt"), "content");
      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      const artifacts = await ingestGitDiff(cas, "HEAD", repoDir);

      expect(Object.keys(artifacts)).toEqual([]);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("throws on invalid ref", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      // Create a commit so repo is not empty
      await writeFile(join(repoDir, "file.txt"), "content");
      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      await expect(ingestGitDiff(cas, "nonexistent-ref", repoDir)).rejects.toThrow(
        /git diff failed/,
      );
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("rejects refs starting with dash to prevent option injection", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      // A ref like --output=/tmp/out.diff would be parsed as a git option
      await expect(ingestGitDiff(cas, "--output=/tmp/out.diff", repoDir)).rejects.toThrow(
        /must not start with/,
      );

      // Also reject single-dash options
      await expect(ingestGitDiff(cas, "-p", repoDir)).rejects.toThrow(/must not start with/);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
