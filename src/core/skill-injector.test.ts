/**
 * Tests for skill-injector.
 *
 * Exercises real file I/O against a temporary directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectSkills, SkillResolutionError } from "./skill-injector.js";

let root: string;
let bundledRoot: string;
let overrideRoot: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grove-skill-injector-"));
  bundledRoot = join(root, "bundled");
  overrideRoot = join(root, "override");
  workspace = join(root, "workspace");
  mkdirSync(bundledRoot, { recursive: true });
  mkdirSync(overrideRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBundledSkill(name: string, files: Record<string, string>): void {
  const dir = join(bundledRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

function writeOverrideSkill(name: string, files: Record<string, string>): void {
  const dir = join(overrideRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

describe("injectSkills", () => {
  test("copies a single bundled skill to both native paths", async () => {
    writeBundledSkill("grove", { "SKILL.md": "bundled-content" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    expect(report.injected).toHaveLength(1);
    expect(report.injected[0]?.source).toBe("bundled");

    const claudePath = join(workspace, ".claude/skills/grove/SKILL.md");
    const codexPath = join(workspace, ".codex/skills/grove/SKILL.md");
    expect(readFileSync(claudePath, "utf-8")).toBe("bundled-content");
    expect(readFileSync(codexPath, "utf-8")).toBe("bundled-content");
  });

  test("sets injected files read-only (0o444)", async () => {
    writeBundledSkill("grove", { "SKILL.md": "x" });

    await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    const mode = statSync(join(workspace, ".claude/skills/grove/SKILL.md")).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  test("workspace override wins over bundled", async () => {
    writeBundledSkill("grove", { "SKILL.md": "bundled" });
    writeOverrideSkill("grove", { "SKILL.md": "override" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      workspaceOverrideRoot: overrideRoot,
    });

    expect(report.injected[0]?.source).toBe("override");
    expect(readFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "override",
    );
  });

  test("unknown skill throws SkillResolutionError and writes nothing", async () => {
    writeBundledSkill("grove", { "SKILL.md": "x" });

    await expect(
      injectSkills({
        workspacePath: workspace,
        skills: ["grove", "missing"],
        bundledSkillsRoot: bundledRoot,
      }),
    ).rejects.toBeInstanceOf(SkillResolutionError);

    expect(existsSync(join(workspace, ".claude/skills/grove"))).toBe(false);
    expect(existsSync(join(workspace, ".codex/skills/grove"))).toBe(false);
  });

  test("skill dir without SKILL.md throws", async () => {
    mkdirSync(join(bundledRoot, "broken"), { recursive: true });
    writeFileSync(join(bundledRoot, "broken", "README.md"), "no skill.md here");

    await expect(
      injectSkills({
        workspacePath: workspace,
        skills: ["broken"],
        bundledSkillsRoot: bundledRoot,
      }),
    ).rejects.toBeInstanceOf(SkillResolutionError);
  });

  test("dir-shaped skill with siblings copies every file", async () => {
    writeBundledSkill("multi", {
      "SKILL.md": "root",
      "helper.md": "helper",
      "nested/note.md": "deep",
    });

    await injectSkills({
      workspacePath: workspace,
      skills: ["multi"],
      bundledSkillsRoot: bundledRoot,
    });

    const base = join(workspace, ".claude/skills/multi");
    expect(readFileSync(join(base, "SKILL.md"), "utf-8")).toBe("root");
    expect(readFileSync(join(base, "helper.md"), "utf-8")).toBe("helper");
    expect(readFileSync(join(base, "nested/note.md"), "utf-8")).toBe("deep");

    const codexBase = join(workspace, ".codex/skills/multi");
    expect(readFileSync(join(codexBase, "nested/note.md"), "utf-8")).toBe("deep");
  });

  test("empty skills list is a no-op", async () => {
    const report = await injectSkills({
      workspacePath: workspace,
      skills: [],
      bundledSkillsRoot: bundledRoot,
    });

    expect(report.injected).toHaveLength(0);
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    expect(existsSync(join(workspace, ".codex"))).toBe(false);
  });

  test("missing override root falls back to bundled without error", async () => {
    writeBundledSkill("grove", { "SKILL.md": "b" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      workspaceOverrideRoot: join(root, "does-not-exist"),
    });

    expect(report.injected[0]?.source).toBe("bundled");
  });

  test("overwrites existing target dir (reattach / workspace reuse)", async () => {
    writeBundledSkill("grove", { "SKILL.md": "new" });
    mkdirSync(join(workspace, ".claude/skills/grove"), { recursive: true });
    writeFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "stale", "utf-8");

    await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    expect(readFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe("new");
  });
});
