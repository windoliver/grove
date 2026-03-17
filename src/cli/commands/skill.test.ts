/**
 * Tests for the `grove skill install` command.
 *
 * Uses temp directories instead of real home directories.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillInstall, type SkillTarget } from "./skill.js";
import { renderSkillTemplate } from "./skill-template.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-skill-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// renderSkillTemplate()
// ---------------------------------------------------------------------------

describe("renderSkillTemplate", () => {
  it("includes server URL in output", () => {
    const content = renderSkillTemplate({
      serverUrl: "http://myhost:9000",
      mcpUrl: "http://myhost:9001",
    });
    expect(content).toContain("http://myhost:9000");
  });

  it("includes MCP URL in output", () => {
    const content = renderSkillTemplate({
      serverUrl: "http://myhost:9000",
      mcpUrl: "http://myhost:9001",
    });
    expect(content).toContain("http://myhost:9001");
  });

  it("contains frontmatter with name and description", () => {
    const content = renderSkillTemplate({
      serverUrl: "http://localhost:4515",
      mcpUrl: "http://localhost:4015",
    });
    expect(content).toContain("name: grove");
    expect(content).toContain("description:");
  });
});

// ---------------------------------------------------------------------------
// handleSkillInstall()
// ---------------------------------------------------------------------------

describe("handleSkillInstall", () => {
  it("creates directories and writes SKILL.md", async () => {
    const targets: SkillTarget[] = [
      { platform: "test-platform", path: join(tempDir, "skills/grove") },
    ];

    await handleSkillInstall({ targets });

    const skillPath = join(tempDir, "skills/grove/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const content = readFileSync(skillPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("uses custom targets (writes to temp dirs)", async () => {
    const dir1 = join(tempDir, "target-a/grove");
    const dir2 = join(tempDir, "target-b/grove");

    const targets: SkillTarget[] = [
      { platform: "platform-a", path: dir1 },
      { platform: "platform-b", path: dir2 },
    ];

    await handleSkillInstall({ targets });

    expect(existsSync(join(dir1, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir2, "SKILL.md"))).toBe(true);
  });

  it("SKILL.md content contains expected sections", async () => {
    const targets: SkillTarget[] = [{ platform: "test", path: join(tempDir, "skill-content") }];

    await handleSkillInstall({ targets });

    const content = readFileSync(join(tempDir, "skill-content/SKILL.md"), "utf-8");

    // Expected sections from the template
    expect(content).toContain("## Grove Boardroom");
    expect(content).toContain("### MCP Server");
    expect(content).toContain("### Tools");
    expect(content).toContain("### Workflow");
    expect(content).toContain("grove_contribute");
    expect(content).toContain("grove_frontier");
    expect(content).toContain("grove_goal");
  });

  it("handles missing directories (creates them)", async () => {
    const deepPath = join(tempDir, "a/b/c/d/grove");
    const targets: SkillTarget[] = [{ platform: "deep-nested", path: deepPath }];

    await handleSkillInstall({ targets });

    expect(existsSync(join(deepPath, "SKILL.md"))).toBe(true);
  });

  it("uses custom serverUrl and mcpUrl", async () => {
    const targets: SkillTarget[] = [{ platform: "test", path: join(tempDir, "custom-urls") }];

    await handleSkillInstall({
      serverUrl: "http://custom:8888",
      mcpUrl: "http://custom:9999",
      targets,
    });

    const content = readFileSync(join(tempDir, "custom-urls/SKILL.md"), "utf-8");
    expect(content).toContain("http://custom:8888");
    expect(content).toContain("http://custom:9999");
  });
});
