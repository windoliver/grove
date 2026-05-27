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

  test("rejects malformed activity condition templates during parsing", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "bad-activity-condition",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        activities: [
          {
            id: "review",
            label: "Review",
            condition: "${parameters.target_path",
          },
        ],
      }),
    ).toThrow(/malformed recipe template syntax/);
  });

  test("rejects malformed sub-recipe when templates during parsing", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "bad-sub-recipe-when",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        sub_recipes: [
          {
            name: "child",
            ref: "recipe:child@1.0.0",
            when: "${parameters.target_path",
          },
        ],
      }),
    ).toThrow(/malformed recipe template syntax/);
  });

  test("rejects unsupported sub-recipe parameter templates during parsing", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "bad-sub-recipe-parameters",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        sub_recipes: [
          {
            name: "child",
            ref: "recipe:child@1.0.0",
            parameters: {
              child_path: "$" + "{parameters.target_path.name}",
            },
          },
        ],
      }),
    ).toThrow(/nested recipe template paths require json parameter/);
  });

  test("rejects undeclared template parameter references during parsing", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "bad-template-reference",
        version: "1.0.0",
        parameters: {},
        activities: [
          {
            id: "review",
            label: "Review",
            condition: "$" + "{parameters.target_path}",
          },
        ],
      }),
    ).toThrow(/unknown recipe template parameter/);
  });

  test("accepts literal braces in activity and sub-recipe template fields", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "literal-braces-in-recipe-fields",
      version: "1.0.0",
      activities: [
        {
          id: "review",
          label: "Review",
          condition: 'payload == {"ok": true}',
        },
      ],
      sub_recipes: [
        {
          name: "child",
          ref: "recipe:child@1.0.0",
          when: "status in {ready,pending}",
          parameters: {
            child_path: "literal {braces}",
          },
        },
      ],
    });

    expect(recipe.activities?.[0]?.condition).toBe('payload == {"ok": true}');
    expect(recipe.subRecipes?.[0]?.when).toBe("status in {ready,pending}");
    expect(recipe.subRecipes?.[0]?.parameters?.child_path).toBe("literal {braces}");
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
  test("coerces CLI string values to declared parameter types", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: typed-params
version: 1.0.0
parameters:
  max_rounds:
    type: integer
    required: true
  enabled:
    type: boolean
    required: true
`);
    const bound = bindRecipeParameters(recipe, { max_rounds: "4", enabled: "true" });
    expect(bound.parameters.max_rounds).toBe(4);
    expect(bound.parameters.enabled).toBe(true);
  });

  test("preserves plain string JSON parameter defaults", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: json-default
version: 1.0.0
parameters:
  message:
    type: json
    default: hello
`);
    const bound = bindRecipeParameters(recipe, {});
    expect(bound.parameters.message).toBe("hello");
  });

  test("parses JSON object CLI string overrides", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: json-override
version: 1.0.0
parameters:
  config:
    type: json
    required: true
`);
    const bound = bindRecipeParameters(recipe, { config: '{"enabled":true,"rounds":2}' });
    expect(bound.parameters.config).toEqual({ enabled: true, rounds: 2 });
  });

  test("preserves plain string JSON CLI overrides", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: plain-json-override
version: 1.0.0
parameters:
  message:
    type: json
    required: true
`);
    const bound = bindRecipeParameters(recipe, { message: "hello" });
    expect(bound.parameters.message).toBe("hello");
  });

  test("parses JSON CLI overrides as numbers only for complete JSON number literals", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: json-number-overrides
version: 1.0.0
parameters:
  value:
    type: json
    required: true
`);
    expect(bindRecipeParameters(recipe, { value: "2026-05-27" }).parameters.value).toBe(
      "2026-05-27",
    );
    expect(bindRecipeParameters(recipe, { value: "123abc" }).parameters.value).toBe("123abc");
    expect(bindRecipeParameters(recipe, { value: "123" }).parameters.value).toBe(123);
    expect(bindRecipeParameters(recipe, { value: "-1.5e2" }).parameters.value).toBe(-150);
  });

  test("rejects invalid JSON-looking CLI overrides", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: invalid-json-override
version: 1.0.0
parameters:
  config:
    type: json
    required: true
`);
    expect(() => bindRecipeParameters(recipe, { config: "{bad" })).toThrow(
      /Parameter config must be valid JSON/,
    );
  });

  test("rejects empty numeric CLI string overrides", () => {
    const recipe = parseGroveRecipe(`
kind: recipe
recipe_version: 1
name: empty-numeric-overrides
version: 1.0.0
parameters:
  max_rounds:
    type: integer
    required: true
  threshold:
    type: number
    required: true
`);
    expect(() => bindRecipeParameters(recipe, { max_rounds: "", threshold: 0 })).toThrow(
      /Parameter max_rounds must be an integer/,
    );
    expect(() => bindRecipeParameters(recipe, { max_rounds: 1, threshold: "   " })).toThrow(
      /Parameter threshold must be a number/,
    );
  });

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
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "missing-template-path",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        instructions: "Work on $" + "{parameters.other_path}.",
      }),
    ).toThrow(/unknown recipe template parameter/);
  });

  test("rejects missing template values during binding", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "missing-template-value",
      version: "1.0.0",
      parameters: {
        target_path: { type: "path", required: false },
      },
      instructions: "Work on $" + "{parameters.target_path}.",
    });

    expect(() => bindRecipeParameters(recipe, {})).toThrow(
      /missing recipe template parameter 'target_path'/,
    );
  });

  test("rejects malformed template syntax", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "malformed-template",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        instructions: "Work on ${parameters.target_path.",
      }),
    ).toThrow(/malformed recipe template syntax/);
  });

  test("rejects unsupported template roots", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "unsupported-template-root",
        version: "1.0.0",
        parameters: {},
        instructions: "Home is $" + "{env.HOME}.",
      }),
    ).toThrow(/unsupported recipe template expression/);
  });

  test("rejects empty template markers", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "empty-template-marker",
        version: "1.0.0",
        instructions: "Work on $" + "{}.",
      }),
    ).toThrow(/malformed recipe template syntax/);
  });

  test("rejects nested template paths on non-json parameters during parsing", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "non-json-template-path",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        instructions: "Use $" + "{parameters.target_path.name}.",
      }),
    ).toThrow(/nested recipe template paths require json parameter/);
  });

  test("validates nested string leaves in sub-recipe parameter objects", () => {
    expect(() =>
      parseGroveRecipeObject({
        kind: "recipe",
        recipe_version: 1,
        name: "bad-nested-sub-recipe-parameters",
        version: "1.0.0",
        parameters: {
          target_path: { type: "path", required: true },
        },
        sub_recipes: [
          {
            name: "child",
            ref: "recipe:child@1.0.0",
            parameters: {
              nested: {
                child_path: "$" + "{parameters.target_path.name}",
              },
            },
          },
        ],
      }),
    ).toThrow(/nested recipe template paths require json parameter/);
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

  test("preserves declared extensions and sub-recipes in dry-run materialization", () => {
    const recipe = parseGroveRecipeObject({
      kind: "recipe",
      recipe_version: 1,
      name: "composed-recipe",
      version: "1.0.0",
      parameters: {
        target_path: { type: "path", required: true },
      },
      extensions: [
        {
          type: "mcp",
          name: "filesystem",
          uri: "stdio:grove-fs-mcp",
          required: true,
        },
      ],
      sub_recipes: [
        {
          name: "child",
          ref: "recipe:child@1.0.0",
          parameters: {
            child_path: "$" + "{parameters.target_path}",
          },
        },
      ],
    });

    const materialized = materializeRecipeContract(
      bindRecipeParameters(recipe, { target_path: "src/core" }),
    );

    expect(materialized.extensions).toEqual([
      {
        type: "mcp",
        name: "filesystem",
        uri: "stdio:grove-fs-mcp",
        required: true,
      },
    ]);
    expect(materialized.subRecipes).toEqual([
      {
        name: "child",
        ref: "recipe:child@1.0.0",
        parameters: {
          child_path: "$" + "{parameters.target_path}",
        },
      },
    ]);
    expect(materialized.provenance.subRecipeDigests).toEqual([]);
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
