import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALIASES } from "./aliases.js";
import { loadAliases } from "./aliases-loader.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "c2-aliases-"));
}

describe("loadAliases", () => {
  test("missing project + user files returns defaults with no errors", async () => {
    const dir = await makeTmp();
    try {
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors).toEqual([]);
      // All default keys present
      for (const k of DEFAULT_ALIASES.keys()) {
        expect(r.aliases.has(k)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid YAML in project file falls back to defaults + reports error", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "not: : valid:: yaml: [", "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toMatch(/aliases\.yaml/);
      // Defaults still present
      expect(r.aliases.get("a")?.value).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
