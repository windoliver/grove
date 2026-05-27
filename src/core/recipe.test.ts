import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  discoverRecipes,
  materializeRecipeContract,
  parseGroveRecipe,
  parseGroveRecipeObject,
} from "./recipe.js";
import { resolveRoleWorkspaceStrategies, topologicalSortRoles } from "./topology.js";

const MINIMAL_RECIPE = `
kind: recipe
recipe_version: 1
name: code-review-loop
version: 1.0.0
`;

const FULL_RECIPE = `
kind: recipe
recipe_version: 1
name: code-review-loop
version: 1.0.0
description: Coder and reviewer iterate on a feature
labels: [code-review]
parameters:
  target_path:
    type: path
    required: true
  max_rounds:
    type: integer
    default: 3
extensions:
  - type: mcp
    name: filesystem
    uri: stdio:grove-fs-mcp
activities:
  - id: coder-drafts
    label: Coder drafts
    role: coder
instructions: |
  Work on \${parameters.target_path} for \${parameters.max_rounds} rounds.
agent_topology:
  structure: graph
  roles:
    - name: coder
      platform: codex
run_policy:
  max_iterations: 3
  improvement_threshold: 0.01
`;

describe("parseGroveRecipe", () => {
  test("parses a minimal recipe", () => {
    const recipe = parseGroveRecipe(MINIMAL_RECIPE);
    expect(recipe.kind).toBe("recipe");
    expect(recipe.recipeVersion).toBe(1);
    expect(recipe.name).toBe("code-review-loop");
    expect(recipe.version).toBe("1.0.0");
  });

  test("parses parameters, activities, topology, and run policy", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    expect(recipe.parameters?.target_path?.type).toBe("path");
    expect(recipe.parameters?.max_rounds?.default).toBe(3);
    expect(recipe.activities?.[0]?.id).toBe("coder-drafts");
    expect(recipe.topology?.roles[0]?.name).toBe("coder");
    expect(recipe.runPolicy?.maxIterations).toBe(3);
  });

  test("rejects unknown top-level fields", () => {
    expect(() => parseGroveRecipe(`${MINIMAL_RECIPE}\nunknown_field: true\n`)).toThrow(
      /unknown_field|Unrecognized key/,
    );
  });

  test("rejects duplicate activity ids", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "duplicate-activities",
        version: "1.0.0",
        activities: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }),
    ).toThrow(/duplicate activity ids/);
  });

  test("rejects enum defaults outside the declared enum", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "enum-default-test",
        version: "1.0.0",
        parameters: {
          mode: { type: "enum", enum: ["fast", "safe"], default: "slow" },
        },
      }),
    ).toThrow(/enum parameter default must be in enum values/);
  });

  test("rejects non-JSON response schema values", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "response-schema-json",
        version: "1.0.0",
        response: {
          schema: { transform: () => undefined },
        },
      }),
    ).toThrow(/JSON|Invalid input/);
  });

  test("parses complete topology role and spawning fields", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "topology-fields",
      version: "1.0.0",
      agent_topology: {
        structure: "graph",
        edge_types: ["feedback"],
        spawning: {
          dynamic: true,
          max_depth: 2,
          max_children_per_agent: 3,
          timeout_seconds: 120,
        },
        roles: [
          {
            name: "coder",
            description: "Writes code",
            max_instances: 2,
            mode: "explicit",
            command: "codex",
            ends_session: true,
            platform: "codex",
            model: "gpt-5",
            color: "#00ccff",
            prompt: "Implement",
            goal: "Ship",
            skills: ["test-driven-development"],
            repo_index: 0,
            edges: [
              {
                target: "reviewer",
                edge_type: "feedback",
                workspace: "branch_from_source",
                reply_timeout_seconds: 600,
              },
            ],
          },
          { name: "reviewer" },
        ],
      },
    });

    const topology = recipe.topology;
    expect(topology).toBeDefined();
    if (topology === undefined) {
      throw new Error("expected topology");
    }
    expect(topology.edgeTypes).toEqual(["feedback"]);
    expect(topology.spawning?.maxChildrenPerAgent).toBe(3);
    expect(topology.roles[0]?.edges?.[0]?.replyTimeoutSeconds).toBe(600);
    expect(topology.roles[0]?.repoIndex).toBe(0);

    const strategies = resolveRoleWorkspaceStrategies(topology, "session-1");
    expect(strategies.get("reviewer")).toBe("grove/session-1/coder");
    expect(topologicalSortRoles(topology).map((role) => role.name)).toEqual(["coder", "reviewer"]);
  });

  test("rejects invalid recipe topologies", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "unknown-edge",
        version: "1.0.0",
        agent_topology: {
          structure: "graph",
          roles: [{ name: "coder", edges: [{ target: "missing", edge_type: "feedback" }] }],
        },
      }),
    ).toThrow(/edge target/);

    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "self-edge",
        version: "1.0.0",
        agent_topology: {
          structure: "graph",
          roles: [{ name: "coder", edges: [{ target: "coder", edge_type: "feedback" }] }],
        },
      }),
    ).toThrow(/self-edge/);

    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "flat-edge",
        version: "1.0.0",
        agent_topology: {
          structure: "flat",
          roles: [
            { name: "coder", edges: [{ target: "reviewer", edge_type: "feedback" }] },
            { name: "reviewer" },
          ],
        },
      }),
    ).toThrow(/flat topology/);

    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "tree-roots",
        version: "1.0.0",
        agent_topology: {
          structure: "tree",
          roles: [{ name: "root" }, { name: "other" }],
        },
      }),
    ).toThrow(/tree topology/);

    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "tree-duplicate-parent",
        version: "1.0.0",
        agent_topology: {
          structure: "tree",
          roles: [
            { name: "root", edges: [{ target: "child", edge_type: "feedback" }] },
            { name: "other", edges: [{ target: "child", edge_type: "feedback" }] },
            { name: "child" },
          ],
        },
      }),
    ).toThrow(/single parent/);
  });
});

describe("recipe digests", () => {
  test("recipe digest is stable across object key order", () => {
    const first = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "digest-test",
      version: "1.0.0",
      description: "Stable",
    });
    const second = parseGroveRecipeObject({
      description: "Stable",
      version: "1.0.0",
      name: "digest-test",
      recipe_version: 1,
      kind: "recipe",
    });
    expect(computeRecipeDigest(first)).toBe(computeRecipeDigest(second));
  });

  test("bound digest changes when parameters change", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    const first = bindRecipeParameters(recipe, { target_path: "src/core" });
    const second = bindRecipeParameters(recipe, { target_path: "src/cli" });
    expect(computeBoundRecipeDigest(first)).not.toBe(computeBoundRecipeDigest(second));
  });
});

describe("bindRecipeParameters", () => {
  test("rejects unknown parameter overrides", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    expect(() => bindRecipeParameters(recipe, { target_path: "src/core", extra: true })).toThrow(
      /unknown recipe parameter/,
    );
  });

  test("rejects missing required parameters", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    expect(() => bindRecipeParameters(recipe, {})).toThrow(/missing required recipe parameter/);
  });

  test("rejects wrong bound parameter types", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    expect(() => bindRecipeParameters(recipe, { target_path: 123 })).toThrow(/must be a string/);
  });

  test("rejects enum overrides outside the declared enum", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "enum-override-test",
      version: "1.0.0",
      parameters: {
        mode: { type: "enum", enum: ["fast", "safe"] },
      },
    });

    expect(() => bindRecipeParameters(recipe, { mode: "slow" })).toThrow(/enum values/);
  });

  test("rejects missing template paths", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "missing-template-path",
      version: "1.0.0",
      parameters: {
        target_path: { type: "path", required: true },
      },
      instructions: "Work on $" + "{parameters.other_path}.",
    });

    expect(() => bindRecipeParameters(recipe, { target_path: "src/core" })).toThrow(
      /missing recipe template parameter/,
    );
  });

  test("rejects malformed template syntax", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "malformed-template",
      version: "1.0.0",
      parameters: {
        target_path: { type: "path", required: true },
      },
      instructions: "Work on ${parameters.target_path.",
    });

    expect(() => bindRecipeParameters(recipe, { target_path: "src/core" })).toThrow(
      /malformed recipe template syntax/,
    );
  });

  test("renders nested JSON parameter paths", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "json-template-path",
      version: "1.0.0",
      parameters: {
        config: { type: "json", required: true },
      },
      instructions: "Use $" + "{parameters.config.paths.target}.",
    });

    const bound = bindRecipeParameters(recipe, {
      config: { paths: { target: "src/core" } },
    });
    expect(bound.renderedInstructions).toBe("Use src/core.");
  });

  test("preserves literal braces outside template markers", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "literal-braces-template",
      version: "1.0.0",
      parameters: {
        target_path: { type: "path", required: true },
      },
      instructions: 'Return {"ok": true} for $' + "{parameters.target_path}.",
    });

    const bound = bindRecipeParameters(recipe, { target_path: "src/core" });
    expect(bound.renderedInstructions).toBe('Return {"ok": true} for src/core.');
  });
});

describe("materializeRecipeContract", () => {
  test("creates a GroveContract-compatible dry-run contract", () => {
    const recipe = parseGroveRecipe(FULL_RECIPE);
    const bound = bindRecipeParameters(recipe, { target_path: "src/core" });
    const materialized = materializeRecipeContract(bound);
    expect(materialized.contract.contractVersion).toBe(3);
    expect(materialized.contract.name).toBe("code-review-loop");
    expect(materialized.contract.topology?.roles[0]?.name).toBe("coder");
    expect(materialized.provenance.recipeName).toBe("code-review-loop");
    expect(materialized.renderedInstructions).toContain("src/core");
  });
});

describe("discoverRecipes", () => {
  test("discovers recipes from configured directories in deterministic order", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-recipe-discovery-"));
    try {
      const recipesDir = join(root, "recipes");
      const groveRecipesDir = join(root, ".grove", "recipes");
      await mkdir(recipesDir, { recursive: true });
      await mkdir(groveRecipesDir, { recursive: true });
      await writeFile(
        join(groveRecipesDir, "workspace.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: workspace-recipe\nversion: 1.0.0\n",
      );
      await writeFile(
        join(recipesDir, "project.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: project-recipe\nversion: 1.0.0\n",
      );

      const discovered = await discoverRecipes({
        cwd: root,
        homeConfigDir: join(root, "home-recipes-missing"),
      });

      expect(discovered.map((entry) => entry.recipe.name)).toEqual([
        "project-recipe",
        "workspace-recipe",
      ]);
      expect(discovered[0]?.source).toBe("project");
      expect(discovered[1]?.source).toBe("workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sorts recipe paths by deterministic code-unit order", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-recipe-discovery-"));
    try {
      const recipesDir = join(root, "recipes");
      await mkdir(recipesDir, { recursive: true });
      await writeFile(
        join(recipesDir, "z.yaml"),
        "kind: recipe\nrecipe_version: 1\nname: z-recipe\nversion: 1.0.0\n",
      );
      await writeFile(
        join(recipesDir, `${String.fromCharCode(0xe4)}.yaml`),
        "kind: recipe\nrecipe_version: 1\nname: accent-recipe\nversion: 1.0.0\n",
      );

      const discovered = await discoverRecipes({
        cwd: root,
        homeConfigDir: join(root, "home-recipes-missing"),
      });

      expect(discovered.map((entry) => entry.recipe.name)).toEqual(["z-recipe", "accent-recipe"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
