import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecipeProvenance } from "../core/recipe.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";

describe("SqliteGoalSessionStore recipe provenance", () => {
  test("createSession persists recipeProvenance and getSession returns it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-prov-"));
    try {
      const db = initSqliteDb(join(dir, "grove.db"));
      const store = new SqliteGoalSessionStore(db);
      const provenance: RecipeProvenance = {
        recipeDigest: "blake3:abc",
        recipeName: "code-review-loop",
        recipeVersion: "1.0.0",
        boundParameterDigest: "blake3:def",
        subRecipeDigests: [],
      };
      const created = await store.createSession({ goal: "g", recipeProvenance: provenance });
      expect(created.recipeProvenance).toEqual(provenance);
      const fetched = await store.getSession(created.id);
      expect(fetched?.recipeProvenance).toEqual(provenance);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
