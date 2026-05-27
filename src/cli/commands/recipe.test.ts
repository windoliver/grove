import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../errors.js";
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

  test("parseRecipeArgs rejects extra validate positionals", () => {
    expect(() => parseRecipeArgs(["validate", "recipes/review.yaml", "extra.yaml"])).toThrow(
      UsageError,
    );
  });

  test("parseRecipeArgs rejects extra run positionals", () => {
    expect(() => parseRecipeArgs(["run", "recipes/review.yaml", "extra.yaml"])).toThrow(UsageError);
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
      const output = lines.join("\n");
      expect(output).toContain("Valid recipe: review-loop@1.0.0");
      expect(output).toContain("Digest: blake3:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validate resolves relative recipe paths from cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-cli-cwd-"));
    try {
      const recipesDir = join(dir, "recipes");
      await mkdir(recipesDir);
      await writeFile(
        join(recipesDir, "review.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["validate", "recipes/review.yaml"]), {
        cwd: dir,
        writer,
      });
      expect(lines.join("\n")).toContain("Valid recipe: review-loop@1.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run dry-run resolves relative recipe paths from cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-cli-run-cwd-"));
    try {
      const recipesDir = join(dir, "recipes");
      await mkdir(recipesDir);
      await writeFile(
        join(recipesDir, "review.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["run", "recipes/review.yaml", "--dry-run"]), {
        cwd: dir,
        writer,
      });
      expect(lines.join("\n")).toContain("Recipe dry-run: review-loop@1.0.0");
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
      const parsed = JSON.parse(lines.join("\n")) as {
        digest: string;
        name: string;
        valid: boolean;
        version: string;
      };
      expect(parsed.valid).toBe(true);
      expect(parsed.name).toBe("review-loop");
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.digest).toStartWith("blake3:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
