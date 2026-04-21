/**
 * Tests for the `grove skill install` command.
 *
 * Uses temp directories; points the install at a temp catalog root.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillInstall } from "./skill.js";

let tempDir: string;
let catalogRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-skill-test-"));
  catalogRoot = join(tempDir, "skills");
  mkdirSync(join(catalogRoot, "grove"), { recursive: true });
  writeFileSync(join(catalogRoot, "grove", "SKILL.md"), "CATALOG_CONTENT\n", "utf-8");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("handleSkillInstall", () => {
  it("copies SKILL.md from the on-disk catalog to each target", async () => {
    const target = join(tempDir, "out/grove");
    await handleSkillInstall({
      targets: [{ platform: "test", path: target }],
      catalogRoot,
    });

    expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("CATALOG_CONTENT\n");
  });

  it("writes to multiple targets", async () => {
    const t1 = join(tempDir, "out/a");
    const t2 = join(tempDir, "out/b");
    await handleSkillInstall({
      targets: [
        { platform: "a", path: t1 },
        { platform: "b", path: t2 },
      ],
      catalogRoot,
    });

    expect(existsSync(join(t1, "SKILL.md"))).toBe(true);
    expect(existsSync(join(t2, "SKILL.md"))).toBe(true);
  });

  it("throws when catalog does not contain the grove skill", async () => {
    const emptyCatalog = join(tempDir, "empty");
    mkdirSync(emptyCatalog, { recursive: true });
    await expect(
      handleSkillInstall({
        targets: [{ platform: "t", path: join(tempDir, "out") }],
        catalogRoot: emptyCatalog,
      }),
    ).rejects.toThrow();
  });
});
