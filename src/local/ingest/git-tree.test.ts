/**
 * Tests for git working tree ingestion into CAS.
 *
 * Uses real temporary git repos for accurate testing.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsCas } from "../fs-cas.js";
import { ingestGitTree } from "./git-tree.js";

async function createTempGitRepo(): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-git-tree-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });

  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };

  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@grove.dev"]);
  await run(["git", "config", "user.name", "Test"]);

  return dir;
}

describe("ingestGitTree", () => {
  test("ingests tracked files from git working tree", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      // Create tracked files
      await writeFile(join(repoDir, "src.ts"), "export {}");
      await writeFile(join(repoDir, "test.ts"), "test()");

      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      const artifacts = await ingestGitTree(cas, repoDir);

      expect(Object.keys(artifacts).sort()).toEqual(["src.ts", "test.ts"]);
      for (const hash of Object.values(artifacts)) {
        expect(hash).toMatch(/^blake3:[0-9a-f]{64}$/);
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("respects .gitignore", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      await writeFile(join(repoDir, ".gitignore"), "node_modules/\n*.log\n");
      await writeFile(join(repoDir, "src.ts"), "export {}");
      await mkdir(join(repoDir, "node_modules"), { recursive: true });
      await writeFile(join(repoDir, "node_modules", "dep.js"), "module");
      await writeFile(join(repoDir, "debug.log"), "log content");

      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      const artifacts = await ingestGitTree(cas, repoDir);

      const names = Object.keys(artifacts);
      expect(names).toContain("src.ts");
      expect(names).toContain(".gitignore");
      expect(names).not.toContain("node_modules/dep.js");
      expect(names).not.toContain("debug.log");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("skips .grove directory", async () => {
    const repoDir = await createTempGitRepo();
    try {
      const casDir = join(repoDir, ".cas");
      const cas = new FsCas(casDir);

      await writeFile(join(repoDir, "src.ts"), "export {}");
      await mkdir(join(repoDir, ".grove"), { recursive: true });
      await writeFile(join(repoDir, ".grove", "grove.db"), "db");

      const run = async (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
        await proc.exited;
      };
      await run(["git", "add", "."]);
      await run(["git", "commit", "-m", "initial"]);

      const artifacts = await ingestGitTree(cas, repoDir);

      const names = Object.keys(artifacts);
      expect(names).toContain("src.ts");
      expect(names).not.toContain(".grove/grove.db");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
