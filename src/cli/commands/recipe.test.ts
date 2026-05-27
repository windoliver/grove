import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecipeArgs, runRecipe } from "./recipe.js";

function createWriter(): { lines: string[]; writer: (line: string) => void } {
  const lines: string[] = [];
  return { lines, writer: (line: string) => lines.push(line) };
}

describe("recipe command", () => {
  test("parseRecipeArgs parses validate", () => {
    expect(parseRecipeArgs(["validate", "recipes/review.yaml"])).toEqual({
      command: "validate",
      path: "recipes/review.yaml",
      json: false,
    });
  });

  test("validate reports a valid recipe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-cli-"));
    try {
      const recipePath = join(dir, "review.yaml");
      await writeFile(
        recipePath,
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["validate", recipePath]), { cwd: dir, writer });
      expect(lines.join("\n")).toContain("Valid recipe: review-loop@1.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validate --json emits parseable JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-cli-json-"));
    try {
      const recipePath = join(dir, "review.yaml");
      await writeFile(
        recipePath,
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["validate", recipePath, "--json"]), { cwd: dir, writer });
      const parsed = JSON.parse(lines.join("\n")) as { valid: boolean; name: string };
      expect(parsed.valid).toBe(true);
      expect(parsed.name).toBe("review-loop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
