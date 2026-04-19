/**
 * Regression test for #315: TUI's findGroveDir must NOT walk past a worktree's
 * own incomplete .grove/ to find a parent's grove.json.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGroveDir } from "./main.js";

let tempDir: string;
let originalCwd: string;

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "grove-tui-fence-test-")));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.GROVE_DIR;
});

test("worktree with .grove/ but no grove.json returns undefined (does NOT inherit parent grove.json)", async () => {
  // Parent: full grove
  const parentGrove = join(tempDir, ".grove");
  await mkdir(parentGrove);
  await writeFile(join(parentGrove, "grove.json"), "{}");

  // Worktree: .grove/ exists but no grove.json
  const wt = join(tempDir, "wt");
  await mkdir(wt);
  await mkdir(join(wt, ".grove"));

  process.chdir(wt);

  // findGroveDir must NOT return parent's .grove/ — that would inherit stale state.
  expect(findGroveDir()).toBeUndefined();
});

test("worktree with .grove/grove.json returns its own .grove/", async () => {
  const parentGrove = join(tempDir, ".grove");
  await mkdir(parentGrove);
  await writeFile(join(parentGrove, "grove.json"), "{}");

  const wt = join(tempDir, "wt");
  await mkdir(wt);
  const wtGrove = join(wt, ".grove");
  await mkdir(wtGrove);
  await writeFile(join(wtGrove, "grove.json"), "{}");

  process.chdir(wt);

  expect(findGroveDir()).toBe(wtGrove);
});

test("plain subdirectory walks up to ancestor's full grove (no fence in the way)", async () => {
  const groveDir = join(tempDir, ".grove");
  await mkdir(groveDir);
  await writeFile(join(groveDir, "grove.json"), "{}");

  const sub = join(tempDir, "src", "deep");
  await mkdir(sub, { recursive: true });

  process.chdir(sub);

  expect(findGroveDir()).toBe(groveDir);
});

test("explicit override with no grove.json returns undefined", async () => {
  const dir = join(tempDir, "bare");
  await mkdir(dir);
  expect(findGroveDir(dir)).toBeUndefined();
});

test("explicit override with grove.json returns it", async () => {
  const dir = join(tempDir, "real");
  await mkdir(dir);
  await writeFile(join(dir, "grove.json"), "{}");
  expect(findGroveDir(dir)).toBe(dir);
});
