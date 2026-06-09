import { describe, expect, test } from "bun:test";
import type { RecipeProvenance } from "../core/recipe.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusSessionStore } from "./nexus-session-store.js";

describe("NexusSessionStore — recipeProvenance round-trip", () => {
  test("createSession preserves recipeProvenance and getSession returns it", async () => {
    const client = new MockNexusClient();
    const store = new NexusSessionStore(client, "test-zone");

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
  });
});
