/**
 * Tests for bootstrapWorkspace.
 *
 * Exercises real file I/O against a temporary directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWorkspace } from "./workspace-bootstrap.js";

describe("bootstrapWorkspace", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "grove-bootstrap-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("writes CLAUDE.md and CODEX.md with role and goal", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build the auth module",
    });

    const claudeMd = readFileSync(join(workspaceDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("coder");
    expect(claudeMd).toContain("Build the auth module");

    const codexMd = readFileSync(join(workspaceDir, "CODEX.md"), "utf-8");
    expect(codexMd).toContain("coder");
    expect(codexMd).toContain("mcp__grove__grove_submit_work");
    expect(codexMd).toContain("do not run `bun --eval`");
    expect(codexMd).toContain("do not read or");
  });

  test("writes .mcp.json when mcpServePath and groveDir are provided", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "reviewer",
      goal: "Review the PR",
      mcpServePath: "/path/to/serve.ts",
      groveDir: "/path/to/.grove",
    });

    const mcpPath = join(workspaceDir, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(mcp.mcpServers.grove.command).toBe(process.execPath);
    expect(mcp.mcpServers.grove.env.GROVE_AGENT_ROLE).toBe("reviewer");
    expect(mcp.mcpServers.grove.env.GROVE_DIR).toBe("/path/to/.grove");

    const acpx = JSON.parse(readFileSync(join(workspaceDir, ".acpxrc.json"), "utf-8"));
    expect(acpx.mcpServers[0].command).toBe(process.execPath);
  });

  test("skips .mcp.json when mcpServePath is absent", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build something",
    });

    expect(existsSync(join(workspaceDir, ".mcp.json"))).toBe(false);
  });

  test("includes nexusUrl and nexusApiKey in .mcp.json env", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      mcpServePath: "/serve.ts",
      groveDir: "/.grove",
      nexusUrl: "https://nexus.example.com",
      nexusApiKey: "secret-key",
    });

    const mcp = JSON.parse(readFileSync(join(workspaceDir, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.grove.env.GROVE_NEXUS_URL).toBe("https://nexus.example.com");
    expect(mcp.mcpServers.grove.env.NEXUS_API_KEY).toBe("secret-key");
  });

  test("instructions contain agent identity and role", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "architect",
      goal: "Design the system",
      roleDescription: "You design high-level architecture",
      rolePrompt: "Focus on scalability",
    });

    const claudeMd = readFileSync(join(workspaceDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("architect");
    expect(claudeMd).toContain("You design high-level architecture");
    expect(claudeMd).toContain("Focus on scalability");
  });

  test("creates .grove context directory", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
    });

    expect(existsSync(join(workspaceDir, ".grove"))).toBe(true);
  });

  test("throws when workspacePath does not exist", async () => {
    await expect(
      bootstrapWorkspace({
        workspacePath: "/nonexistent/path/that/cannot/exist",
        roleId: "coder",
        goal: "Build",
      }),
    ).rejects.toThrow();
  });

  test("injects skills when role declares them", async () => {
    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
    const skillDir = join(bundledRoot, "grove");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "catalog-grove", "utf-8");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    const claudePath = join(workspaceDir, ".claude/skills/grove/SKILL.md");
    const codexPath = join(workspaceDir, ".codex/skills/grove/SKILL.md");
    expect(existsSync(claudePath)).toBe(true);
    expect(existsSync(codexPath)).toBe(true);
    expect(readFileSync(claudePath, "utf-8")).toBe("catalog-grove");

    rmSync(bundledRoot, { recursive: true, force: true });
  });

  test("injects skills from resolver-provided catalog root before local fallback", async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), "grove-remote-skills-"));
    const skillDir = join(remoteRoot, "grove");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "remote-grove", "utf-8");

    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
    const bundledSkillDir = join(bundledRoot, "grove");
    mkdirSync(bundledSkillDir, { recursive: true });
    writeFileSync(join(bundledSkillDir, "SKILL.md"), "bundled-grove", "utf-8");

    const overrideRoot = mkdtempSync(join(tmpdir(), "grove-override-"));
    const overrideSkillDir = join(overrideRoot, "grove");
    mkdirSync(overrideSkillDir, { recursive: true });
    writeFileSync(join(overrideSkillDir, "SKILL.md"), "override-grove", "utf-8");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      workspaceOverrideRoot: overrideRoot,
      skillCatalogResolver: async (skills) => ({
        root: remoteRoot,
        warnings: skills.map((skillName) => ({
          skillName,
          attemptedSource: "nexus",
          fallbackSource: undefined,
          reason: "verified",
        })),
      }),
    });

    expect(readFileSync(join(workspaceDir, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "remote-grove",
    );

    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(bundledRoot, { recursive: true, force: true });
    rmSync(overrideRoot, { recursive: true, force: true });
  });

  test("falls back to local injection when resolver returns undefined", async () => {
    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
    const skillDir = join(bundledRoot, "grove");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "bundled-grove", "utf-8");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      skillCatalogResolver: async () => undefined,
    });

    expect(readFileSync(join(workspaceDir, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "bundled-grove",
    );

    rmSync(bundledRoot, { recursive: true, force: true });
  });

  test("does not create .claude/.codex dirs when role has no skills", async () => {
    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
    });

    expect(existsSync(join(workspaceDir, ".claude"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".codex"))).toBe(false);
  });

  test("propagates skill resolution errors as bootstrap failures", async () => {
    const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));

    await expect(
      bootstrapWorkspace({
        workspacePath: workspaceDir,
        roleId: "coder",
        goal: "Build",
        skills: ["missing"],
        bundledSkillsRoot: bundledRoot,
      }),
    ).rejects.toThrow(/missing/);

    rmSync(bundledRoot, { recursive: true, force: true });
  });

  test("throws when skills non-empty but bundledSkillsRoot missing", async () => {
    await expect(
      bootstrapWorkspace({
        workspacePath: workspaceDir,
        roleId: "coder",
        goal: "Build",
        skills: ["grove"],
      }),
    ).rejects.toThrow(/bundledSkillsRoot/);
  });

  test("bundled grove catalog resolves via default root in repo", async () => {
    // Resolve the repo-root skills/ dir via import.meta.url, same trick as production.
    const here = new URL(import.meta.url).pathname;
    const repoSkills = join(here, "..", "..", "..", "skills");

    await bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
      bundledSkillsRoot: repoSkills,
    });

    const claudePath = join(workspaceDir, ".claude/skills/grove/SKILL.md");
    const content = readFileSync(claudePath, "utf-8");
    expect(content).toContain("name: grove");
    expect(content).toContain("grove_submit_work");
  });
});
