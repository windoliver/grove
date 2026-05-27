import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import groveRecipeSchema from "./grove-recipe.json";

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(groveRecipeSchema);
}

function validRecipe(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "recipe",
    recipe_version: 1,
    name: "code-review-loop",
    version: "1.0.0",
    ...overrides,
  };
}

describe("grove-recipe schema", () => {
  const validate = createValidator();

  test("accepts minimal recipe", () => {
    expect(validate(validRecipe())).toBe(true);
  });

  test("accepts parameters, activities, topology, and response schema", () => {
    const recipe = validRecipe({
      description: "Coder and reviewer iterate on a feature",
      labels: ["code-review"],
      parameters: {
        target_path: { type: "path", required: true },
        max_rounds: { type: "integer", default: 3 },
      },
      extensions: [{ type: "mcp", name: "filesystem", uri: "stdio:grove-fs-mcp" }],
      activities: [
        { id: "coder-drafts", label: "Coder drafts", role: "coder" },
        {
          id: "converge",
          label: "Converge",
          condition: `\${parameters.max_rounds} > 0`,
        },
      ],
      instructions: `Work on \${parameters.target_path}.`,
      agent_topology: {
        structure: "graph",
        roles: [
          { name: "coder", platform: "codex" },
          {
            name: "reviewer",
            platform: "claude-code",
            edges: [{ target: "coder", edge_type: "feedback" }],
          },
        ],
      },
      sub_recipes: [
        {
          name: "security-audit",
          ref: "./recipes/security-audit.yaml",
          when: `\${parameters.target_path} matches '**/auth/**'`,
          parameters: { target_path: `\${parameters.target_path}` },
        },
      ],
      response: {
        schema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
        },
      },
      run_policy: { max_iterations: 3, improvement_threshold: 0.01 },
      library: { owner: "platform", visibility: "workspace" },
    });

    expect(validate(recipe)).toBe(true);
  });

  test("rejects unknown top-level fields", () => {
    expect(validate(validRecipe({ unknown_field: true }))).toBe(false);
  });

  test("rejects invalid parameter defaults", () => {
    const recipe = validRecipe({
      parameters: {
        max_rounds: { type: "integer", default: "three" },
      },
    });
    expect(validate(recipe)).toBe(false);
  });

  test("rejects duplicate labels", () => {
    const recipe = validRecipe({ labels: ["code-review", "code-review"] });
    expect(validate(recipe)).toBe(false);
  });
});
