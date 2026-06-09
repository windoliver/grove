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

  test("listSessions includes recipeProvenance (used by `grove session status`)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-list-"));
    try {
      const db = initSqliteDb(join(dir, "grove.db"));
      const store = new SqliteGoalSessionStore(db);
      const provenance: RecipeProvenance = {
        recipeDigest: "blake3:listabc",
        recipeName: "review-loop-276",
        recipeVersion: "1.0.0",
        boundParameterDigest: "blake3:listdef",
        subRecipeDigests: [],
      };
      const created = await store.createSession({ goal: "g", recipeProvenance: provenance });
      const listed = await store.listSessions({ includeArchived: true });
      const match = listed.find((s) => s.id === created.id);
      expect(match?.recipeProvenance).toEqual(provenance);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
