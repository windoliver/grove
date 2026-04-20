import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeInit } from "../../src/cli/commands/init.js";

let tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-init-bare-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs = [];
});

describe("grove init (bare, no --preset)", () => {
  test("creates .grove/ structure without writing GROVE.md", async () => {
    const dir = await createTempDir("no-preset");
    await executeInit({
      name: "bare-grove",
      mode: "evaluation",
      seed: [],
      metric: [],
      force: false,
      agentOverrides: {},
      cwd: dir,
    });

    expect(existsSync(join(dir, ".grove"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "workspaces"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);
    expect(existsSync(join(dir, "GROVE.md"))).toBe(false);
  });

  test("does not overwrite a user-authored GROVE.md when no preset is given", async () => {
    const dir = await createTempDir("preserve-user-md");
    const { writeFile } = await import("node:fs/promises");
    const userContent = "# my custom contract\n";
    await writeFile(join(dir, "GROVE.md"), userContent, "utf-8");

    await executeInit({
      name: "bare-grove",
      mode: "evaluation",
      seed: [],
      metric: [],
      force: true,
      agentOverrides: {},
      cwd: dir,
    });

    const { readFile } = await import("node:fs/promises");
    const after = await readFile(join(dir, "GROVE.md"), "utf-8");
    expect(after).toBe(userContent);
  });
});
