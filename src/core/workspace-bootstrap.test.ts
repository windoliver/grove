/**
 * Tests for bootstrapWorkspace.
 *
 * Exercises real file I/O against a temporary directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(mcp.mcpServers.grove.command).toBe("bun");
    expect(mcp.mcpServers.grove.env.GROVE_AGENT_ROLE).toBe("reviewer");
    expect(mcp.mcpServers.grove.env.GROVE_DIR).toBe("/path/to/.grove");
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
});
