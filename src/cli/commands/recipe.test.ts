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

  test("run --dry-run binds parameters and renders instructions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-run-"));
    try {
      const recipePath = join(dir, "review.yaml");
      await writeFile(
        recipePath,
        [
          "kind: recipe",
          "recipe_version: 1",
          "name: review-loop",
          "version: 1.0.0",
          "parameters:",
          "  target_path:",
          "    type: path",
          "    required: true",
          "instructions: |",
          "  Review $" + "{parameters.target_path}.",
          "",
        ].join("\n"),
      );
      const { lines, writer } = createWriter();
      await runRecipe(
        parseRecipeArgs(["run", recipePath, "--dry-run", "--param", "target_path=src/core"]),
        {
          cwd: dir,
          writer,
        },
      );
      const output = lines.join("\n");
      expect(output).toContain("Recipe dry-run: review-loop@1.0.0");
      expect(output).toContain("src/core");
      expect(output).toContain("Bound digest:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run without --dry-run is rejected in the first implementation slice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-run-required-dry-"));
    try {
      const recipePath = join(dir, "review.yaml");
      await writeFile(
        recipePath,
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      await expect(
        runRecipe(parseRecipeArgs(["run", recipePath]), { cwd: dir, writer: () => undefined }),
      ).rejects.toThrow(/requires --dry-run/);
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

  test("list prints discovered recipes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-list-"));
    try {
      const recipesDir = join(dir, "recipes");
      await mkdir(recipesDir, { recursive: true });
      await writeFile(
        join(recipesDir, "review.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["list", "--dir", dir]), { cwd: dir, writer });
      expect(lines.join("\n")).toContain("review-loop@1.0.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list --json emits discovered recipes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-list-json-"));
    try {
      const recipesDir = join(dir, "recipes");
      await mkdir(recipesDir, { recursive: true });
      await writeFile(
        join(recipesDir, "review.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["list", "--dir", dir, "--json"]), { cwd: dir, writer });
      const parsed = JSON.parse(lines.join("\n")) as Array<{ recipe: { name: string } }>;
      expect(parsed[0]?.recipe.name).toBe("review-loop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
