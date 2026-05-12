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

describe("loadAliases merge semantics", () => {
  test("project file overrides user file on key conflict", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      const userGrove = join(dir, "fakehome", ".grove");
      await mkdir(grove, { recursive: true });
      await mkdir(userGrove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "dev: project-cmd\n", "utf8");
      await writeFile(join(userGrove, "aliases.yaml"), "dev: user-cmd\nuonly: user-only\n", "utf8");
      const r = await loadAliases(dir, { homeOverride: join(dir, "fakehome") });
      expect(r.errors).toEqual([]);
      expect(r.aliases.get("dev")?.value).toBe("project-cmd");
      expect(r.aliases.get("uonly")?.value).toBe("user-only");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema violation (empty value) reports error and keeps defaults", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), 'bad: ""\n', "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.aliases.has("bad")).toBe(false);
      expect(r.aliases.get("a")?.value).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema violation (illegal key chars) reports error", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), '"1bad": something\n', "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.aliases.has("1bad")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
