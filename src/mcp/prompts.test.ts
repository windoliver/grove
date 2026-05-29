import { describe, expect, test } from "bun:test";
import { loadPromptDefinitions } from "./prompts.js";

describe("loadPromptDefinitions", () => {
  test("loads .md files from the repo prompts dir as named prompts", async () => {
    const defs = await loadPromptDefinitions(new URL("../../prompts/", import.meta.url).pathname);
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      expect(typeof d.name).toBe("string");
      expect(d.template.length).toBeGreaterThan(0);
    }
    // The repo ships coder/coordinator/reviewer prompts.
    expect(defs.map((d) => d.name)).toContain("coder");
  });
  test("returns [] for a missing directory", async () => {
    expect(await loadPromptDefinitions("/no/such/dir")).toEqual([]);
  });
});
