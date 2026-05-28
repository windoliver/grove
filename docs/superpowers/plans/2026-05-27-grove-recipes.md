# Grove Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Grove Recipes v1 through schema validation, parser/digest helpers, recipe discovery, parameter binding, and `grove recipe run --dry-run` materialization.

**Architecture:** Add a focused core recipe module that mirrors the existing `GROVE.md` contract parser style: strict Zod validation, snake_case wire format, camelCase TypeScript types, BLAKE3 canonical digests, and explicit materialization to a `GroveContract`. Add a CLI command group that delegates all behavior to the core module and stays side-effect-free for this first slice. Real agent execution and Nexus workflow compilation remain follow-up work after dry-run materialization is stable.

**Tech Stack:** TypeScript strict mode, Bun test runner (`bun:test`), Zod, YAML, BLAKE3, AJV 2020 JSON Schema tests, Biome.

---

## File Structure

- Create: `spec/GROVE-RECIPES.md`
  - Prose contract for recipe YAML, matching the implementation and JSON Schema.
- Create: `spec/schemas/grove-recipe.json`
  - JSON Schema for recipe wire format.
- Create: `spec/schemas/grove-recipe.test.ts`
  - AJV schema tests using the same pattern as `spec/schemas/grove-contract.test.ts`.
- Create: `src/core/recipe.ts`
  - Zod schemas, readonly TypeScript types, YAML parser, canonical digest helpers, parameter binding, recipe discovery helpers, and materialization to a `GroveContract`.
- Create: `src/core/recipe.test.ts`
  - Unit tests for parser, digest, parameter binding, discovery sorting, and dry-run materialization.
- Create: `src/cli/commands/recipe.ts`
  - `grove recipe validate`, `grove recipe list`, and `grove recipe run --dry-run`.
- Create: `src/cli/commands/recipe.test.ts`
  - Command parser/runner tests with injected writers and temp directories.
- Modify: `src/core/index.ts`
  - Export recipe types and helpers for core consumers.
- Modify: `src/index.ts`
  - Export public recipe helpers from the package root.
- Modify: `src/cli/main.ts`
  - Register the top-level `recipe` command.
- Modify: `src/cli/cli.integration.test.ts`
  - Add a smoke test that `grove recipe validate <path>` works through the CLI entrypoint.

Implementation commands below assume `bun` is on `PATH`. If it is not, use:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun <command>
```

## Scope Boundary

This plan intentionally ships the first executable recipe slice:

- schema
- parser
- stable digests
- validation diagnostics
- deterministic discovery
- parameter binding
- `run --dry-run` materialization

This plan does not start agents, create sessions in persistent stores, or compile to Nexus workflow actions. Those are separate follow-up plans once the recipe contract is available to code.

### Task 1: Recipe Schema And Spec Docs

**Files:**
- Create: `spec/schemas/grove-recipe.test.ts`
- Create: `spec/schemas/grove-recipe.json`
- Create: `spec/GROVE-RECIPES.md`

- [ ] **Step 1: Write failing JSON Schema tests**

Create `spec/schemas/grove-recipe.test.ts`:

```ts
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
          condition: "${parameters.max_rounds} > 0",
        },
      ],
      instructions: "Work on ${parameters.target_path}.",
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
          when: "${parameters.target_path} matches '**/auth/**'",
          parameters: { target_path: "${parameters.target_path}" },
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
```

- [ ] **Step 2: Run tests and verify schema file is missing**

Run:

```bash
bun test spec/schemas/grove-recipe.test.ts
```

Expected: FAIL with an import error for `./grove-recipe.json`.

- [ ] **Step 3: Add the JSON Schema**

Create `spec/schemas/grove-recipe.json` with these definitions:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://grove.dev/schemas/grove-recipe.json",
  "title": "Grove Recipe",
  "description": "Schema for shareable Grove recipe YAML workflows.",
  "type": "object",
  "required": ["kind", "recipe_version", "name", "version"],
  "properties": {
    "kind": { "type": "string", "const": "recipe" },
    "recipe_version": { "type": "integer", "const": 1 },
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_-]*$",
      "minLength": 1,
      "maxLength": 128
    },
    "version": {
      "type": "string",
      "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$",
      "maxLength": 64
    },
    "description": { "type": "string", "maxLength": 1024 },
    "labels": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 64 },
      "uniqueItems": true,
      "maxItems": 50
    },
    "parameters": {
      "type": "object",
      "propertyNames": {
        "pattern": "^[a-z][a-z0-9_]*$",
        "maxLength": 64
      },
      "additionalProperties": { "$ref": "#/$defs/parameter" },
      "maxProperties": 100
    },
    "extensions": {
      "type": "array",
      "items": { "$ref": "#/$defs/extension" },
      "maxItems": 50
    },
    "activities": {
      "type": "array",
      "items": { "$ref": "#/$defs/activity" },
      "maxItems": 100
    },
    "instructions": { "type": "string", "maxLength": 20000 },
    "agent_topology": { "$ref": "#/$defs/agent_topology" },
    "context_manifests": {
      "type": "array",
      "items": { "$ref": "#/$defs/context_manifest_ref" },
      "maxItems": 50
    },
    "sub_recipes": {
      "type": "array",
      "items": { "$ref": "#/$defs/sub_recipe" },
      "maxItems": 50
    },
    "response": { "$ref": "#/$defs/response" },
    "run_policy": { "$ref": "#/$defs/run_policy" },
    "library": { "$ref": "#/$defs/library_metadata" }
  },
  "unevaluatedProperties": false,
  "$defs": {
    "json_value": {
      "oneOf": [
        { "type": "string" },
        { "type": "number" },
        { "type": "boolean" },
        { "type": "null" },
        { "type": "array", "items": { "$ref": "#/$defs/json_value" } },
        {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/json_value" }
        }
      ]
    },
    "parameter": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["string", "integer", "number", "boolean", "enum", "path", "json"]
        },
        "required": { "type": "boolean" },
        "default": { "$ref": "#/$defs/json_value" },
        "description": { "type": "string", "maxLength": 512 },
        "enum": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "uniqueItems": true,
          "minItems": 1,
          "maxItems": 100
        }
      },
      "allOf": [
        {
          "if": { "properties": { "type": { "const": "integer" } } },
          "then": {
            "properties": { "default": { "type": "integer" } }
          }
        },
        {
          "if": { "properties": { "type": { "const": "number" } } },
          "then": {
            "properties": { "default": { "type": "number" } }
          }
        },
        {
          "if": { "properties": { "type": { "const": "boolean" } } },
          "then": {
            "properties": { "default": { "type": "boolean" } }
          }
        },
        {
          "if": { "properties": { "type": { "enum": ["string", "path"] } } },
          "then": {
            "properties": { "default": { "type": "string" } }
          }
        },
        {
          "if": { "properties": { "type": { "const": "enum" } } },
          "then": {
            "required": ["enum"],
            "properties": { "default": { "type": "string" } }
          }
        }
      ],
      "unevaluatedProperties": false
    },
    "extension": {
      "type": "object",
      "required": ["type", "name"],
      "properties": {
        "type": { "type": "string", "enum": ["mcp", "tool", "provider", "service"] },
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "uri": { "type": "string", "maxLength": 512 },
        "required": { "type": "boolean" }
      },
      "unevaluatedProperties": false
    },
    "activity": {
      "type": "object",
      "required": ["id", "label"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_-]*$",
          "minLength": 1,
          "maxLength": 128
        },
        "label": { "type": "string", "minLength": 1, "maxLength": 256 },
        "role": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_-]*$",
          "maxLength": 64
        },
        "condition": { "type": "string", "maxLength": 512 }
      },
      "unevaluatedProperties": false
    },
    "context_manifest_ref": {
      "type": "object",
      "required": ["name", "ref"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "ref": { "type": "string", "minLength": 1, "maxLength": 512 },
        "role": { "type": "string", "maxLength": 64 }
      },
      "unevaluatedProperties": false
    },
    "sub_recipe": {
      "type": "object",
      "required": ["name", "ref"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "ref": { "type": "string", "minLength": 1, "maxLength": 512 },
        "when": { "type": "string", "maxLength": 512 },
        "parameters": {
          "type": "object",
          "additionalProperties": { "$ref": "#/$defs/json_value" }
        }
      },
      "unevaluatedProperties": false
    },
    "response": {
      "type": "object",
      "properties": {
        "schema": { "type": "object" }
      },
      "unevaluatedProperties": false
    },
    "run_policy": {
      "type": "object",
      "properties": {
        "max_iterations": { "type": "integer", "minimum": 1, "maximum": 1000 },
        "max_no_improvement_rounds": { "type": "integer", "minimum": 1, "maximum": 1000 },
        "improvement_threshold": { "type": "number", "minimum": 0 },
        "direction": { "type": "string", "enum": ["maximize", "minimize"] }
      },
      "unevaluatedProperties": false
    },
    "library_metadata": {
      "type": "object",
      "properties": {
        "owner": { "type": "string", "maxLength": 128 },
        "license": { "type": "string", "maxLength": 128 },
        "source": { "type": "string", "maxLength": 512 },
        "visibility": { "type": "string", "enum": ["private", "workspace", "public"] }
      },
      "unevaluatedProperties": false
    },
    "agent_topology": {
      "type": "object",
      "required": ["structure", "roles"],
      "properties": {
        "structure": { "type": "string", "enum": ["graph", "tree", "flat"] },
        "roles": {
          "type": "array",
          "minItems": 1,
          "maxItems": 50,
          "items": {
            "type": "object",
            "required": ["name"],
            "properties": {
              "name": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]*$",
                "minLength": 1,
                "maxLength": 64
              },
              "description": { "type": "string", "maxLength": 256 },
              "max_instances": { "type": "integer", "minimum": 1, "maximum": 100 },
              "mode": { "type": "string", "enum": ["explicit", "broadcast"] },
              "edges": {
                "type": "array",
                "maxItems": 50,
                "items": {
                  "type": "object",
                  "required": ["target", "edge_type"],
                  "properties": {
                    "target": { "type": "string", "minLength": 1, "maxLength": 64 },
                    "edge_type": {
                      "type": "string",
                      "enum": [
                        "delegates",
                        "feedback",
                        "monitors",
                        "reports",
                        "feeds",
                        "requests",
                        "escalates"
                      ]
                    },
                    "workspace": {
                      "type": "string",
                      "enum": ["branch_from_source", "independent"]
                    },
                    "reply_timeout_seconds": {
                      "type": "integer",
                      "minimum": 10,
                      "maximum": 86400
                    }
                  },
                  "unevaluatedProperties": false
                }
              },
              "command": { "type": "string", "maxLength": 512 },
              "ends_session": { "type": "boolean" },
              "platform": {
                "type": "string",
                "enum": ["claude-code", "codex", "gemini", "custom"]
              },
              "model": { "type": "string", "maxLength": 128 },
              "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
              "prompt": { "type": "string", "maxLength": 4096 },
              "goal": { "type": "string", "maxLength": 512 },
              "skills": { "type": "array", "items": { "type": "string", "minLength": 1 } },
              "repo_index": { "type": "integer", "minimum": 0 }
            },
            "unevaluatedProperties": false
          }
        },
        "spawning": {
          "type": "object",
          "required": ["dynamic"],
          "properties": {
            "dynamic": { "type": "boolean" },
            "max_depth": { "type": "integer", "minimum": 1, "maximum": 10 },
            "max_children_per_agent": { "type": "integer", "minimum": 1, "maximum": 20 },
            "timeout_seconds": { "type": "integer", "minimum": 10, "maximum": 3600 }
          },
          "unevaluatedProperties": false
        },
        "edge_types": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 64 },
          "maxItems": 20
        }
      },
      "unevaluatedProperties": false
    }
  }
}
```

- [ ] **Step 4: Add the prose contract**

Create `spec/GROVE-RECIPES.md`:

```markdown
# Grove Recipes

Grove Recipes are shareable YAML workflow objects. A recipe describes reusable
workflow intent and can be validated, listed, parameter-bound, and dry-run
materialized into a Grove session contract.

Recipes do not replace `GROVE.md`. A recipe is portable library content;
`GROVE.md` remains the session-level contract for a checkout.

## File Format

Recipe files are plain YAML validated against `spec/schemas/grove-recipe.json`.
The top-level object must include:

- `kind: recipe`
- `recipe_version: 1`
- `name`
- `version`

All wire fields use snake_case. Unknown top-level fields are rejected.

## Parameters

Supported parameter types are `string`, `integer`, `number`, `boolean`, `enum`,
`path`, and `json`. Parameter defaults must match the declared type. Required
parameters without a default must be supplied by the caller.

Template references use the form `${parameters.name}`. They can only read bound
parameters. They cannot call functions, read environment variables, run shell
commands, or perform arbitrary evaluation.

## Materialization

`grove recipe run --dry-run` binds parameters and emits:

- `recipeDigest`
- `boundParameterDigest`
- rendered instructions
- included sub-recipes
- extension requirements
- a `GroveContract`-compatible session contract

The first recipe implementation does not start agents. Real execution is a
follow-up layer that will create sessions and delegate stop decisions to the
deterministic loop runner.
```

- [ ] **Step 5: Run schema tests**

Run:

```bash
bun test spec/schemas/grove-recipe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit schema and prose docs**

```bash
git add spec/schemas/grove-recipe.test.ts spec/schemas/grove-recipe.json spec/GROVE-RECIPES.md
git commit -m "docs: add grove recipe schema"
```

### Task 2: Core Recipe Parser And Digest

**Files:**
- Create: `src/core/recipe.test.ts`
- Create: `src/core/recipe.ts`
- Modify: `src/core/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing parser and digest tests**

Create `src/core/recipe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  materializeRecipeContract,
  parseGroveRecipe,
  parseGroveRecipeObject,
} from "./recipe.js";

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
```

- [ ] **Step 2: Run tests and verify missing module failure**

Run:

```bash
bun test src/core/recipe.test.ts
```

Expected: FAIL with `Cannot find module './recipe.js'`.

- [ ] **Step 3: Implement core recipe module**

Create `src/core/recipe.ts`:

```ts
import { hash } from "blake3";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { GroveContract } from "./contract.js";
import { type AgentTopology, AgentTopologySchema, wireToTopology } from "./topology.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type RecipeParameterType = "string" | "integer" | "number" | "boolean" | "enum" | "path" | "json";

export interface RecipeParameter {
  readonly type: RecipeParameterType;
  readonly required?: boolean | undefined;
  readonly default?: JsonValue | undefined;
  readonly description?: string | undefined;
  readonly enum?: readonly string[] | undefined;
}

export interface RecipeExtension {
  readonly type: "mcp" | "tool" | "provider" | "service";
  readonly name: string;
  readonly uri?: string | undefined;
  readonly required?: boolean | undefined;
}

export interface RecipeActivity {
  readonly id: string;
  readonly label: string;
  readonly role?: string | undefined;
  readonly condition?: string | undefined;
}

export interface RecipeSubRecipe {
  readonly name: string;
  readonly ref: string;
  readonly when?: string | undefined;
  readonly parameters?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface RecipeRunPolicy {
  readonly maxIterations?: number | undefined;
  readonly maxNoImprovementRounds?: number | undefined;
  readonly improvementThreshold?: number | undefined;
  readonly direction?: "maximize" | "minimize" | undefined;
}

export interface RecipeLibraryMetadata {
  readonly owner?: string | undefined;
  readonly license?: string | undefined;
  readonly source?: string | undefined;
  readonly visibility?: "private" | "workspace" | "public" | undefined;
}

export interface GroveRecipe {
  readonly kind: "recipe";
  readonly recipeVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly parameters?: Readonly<Record<string, RecipeParameter>> | undefined;
  readonly extensions?: readonly RecipeExtension[] | undefined;
  readonly activities?: readonly RecipeActivity[] | undefined;
  readonly instructions?: string | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly contextManifests?: readonly { readonly name: string; readonly ref: string; readonly role?: string | undefined }[] | undefined;
  readonly subRecipes?: readonly RecipeSubRecipe[] | undefined;
  readonly response?: { readonly schema?: Readonly<Record<string, JsonValue>> | undefined } | undefined;
  readonly runPolicy?: RecipeRunPolicy | undefined;
  readonly library?: RecipeLibraryMetadata | undefined;
}

export interface BoundRecipe {
  readonly recipe: GroveRecipe;
  readonly recipeDigest: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly renderedInstructions?: string | undefined;
}

export interface RecipeProvenance {
  readonly recipeDigest: string;
  readonly recipeName: string;
  readonly recipeVersion: string;
  readonly boundParameterDigest: string;
  readonly subRecipeDigests: readonly string[];
  readonly sourceRef?: string | undefined;
}

export interface MaterializedRecipe {
  readonly contract: GroveContract;
  readonly provenance: RecipeProvenance;
  readonly renderedInstructions?: string | undefined;
}

const JsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine((n) => Number.isFinite(n), { message: "JSON numbers must be finite" }),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const ParameterSchema = z
  .object({
    type: z.enum(["string", "integer", "number", "boolean", "enum", "path", "json"]),
    required: z.boolean().optional(),
    default: JsonValueSchema.optional(),
    description: z.string().max(512).optional(),
    enum: z.array(z.string().min(1)).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((param, ctx) => {
    if (param.type === "enum" && param.enum === undefined) {
      ctx.addIssue({ code: "custom", message: "enum parameter requires enum values" });
    }
    if (param.default !== undefined) validateDefaultType(param, ctx);
  });

const WireRecipeSchema = z
  .object({
    kind: z.literal("recipe"),
    recipe_version: z.literal(1),
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/).min(1).max(128),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/).max(64),
    description: z.string().max(1024).optional(),
    labels: z.array(z.string().min(1).max(64)).max(50).optional(),
    parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), ParameterSchema).optional(),
    extensions: z
      .array(
        z
          .object({
            type: z.enum(["mcp", "tool", "provider", "service"]),
            name: z.string().min(1).max(128),
            uri: z.string().max(512).optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    activities: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_-]*$/).min(1).max(128),
            label: z.string().min(1).max(256),
            role: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64).optional(),
            condition: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    instructions: z.string().max(20000).optional(),
    agent_topology: AgentTopologySchema.optional(),
    context_manifests: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            ref: z.string().min(1).max(512),
            role: z.string().max(64).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    sub_recipes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            ref: z.string().min(1).max(512),
            when: z.string().max(512).optional(),
            parameters: z.record(z.string(), JsonValueSchema).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    response: z.object({ schema: z.record(z.string(), JsonValueSchema).optional() }).strict().optional(),
    run_policy: z
      .object({
        max_iterations: z.number().int().min(1).max(1000).optional(),
        max_no_improvement_rounds: z.number().int().min(1).max(1000).optional(),
        improvement_threshold: z.number().min(0).optional(),
        direction: z.enum(["maximize", "minimize"]).optional(),
      })
      .strict()
      .optional(),
    library: z
      .object({
        owner: z.string().max(128).optional(),
        license: z.string().max(128).optional(),
        source: z.string().max(512).optional(),
        visibility: z.enum(["private", "workspace", "public"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const labels = recipe.labels ?? [];
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", message: "duplicate labels" });
    }
    const activityIds = (recipe.activities ?? []).map((activity) => activity.id);
    if (new Set(activityIds).size !== activityIds.length) {
      ctx.addIssue({ code: "custom", message: "duplicate activity ids" });
    }
  });

function validateDefaultType(param: z.infer<typeof ParameterSchema>, ctx: z.RefinementCtx): void {
  const value = param.default;
  if (param.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    ctx.addIssue({ code: "custom", message: "integer parameter default must be an integer" });
  }
  if (param.type === "number" && typeof value !== "number") {
    ctx.addIssue({ code: "custom", message: "number parameter default must be a number" });
  }
  if (param.type === "boolean" && typeof value !== "boolean") {
    ctx.addIssue({ code: "custom", message: "boolean parameter default must be a boolean" });
  }
  if ((param.type === "string" || param.type === "path" || param.type === "enum") && typeof value !== "string") {
    ctx.addIssue({ code: "custom", message: `${param.type} parameter default must be a string` });
  }
  if (param.type === "enum" && typeof value === "string" && !param.enum?.includes(value)) {
    ctx.addIssue({ code: "custom", message: "enum parameter default must be in enum values" });
  }
}

export function parseGroveRecipe(content: string): GroveRecipe {
  const raw = parseYaml(content);
  return parseGroveRecipeObject(raw);
}

export function parseGroveRecipeObject(raw: unknown): GroveRecipe {
  const parsed = WireRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid Grove recipe: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return wireToRecipe(parsed.data);
}

function wireToRecipe(wire: z.infer<typeof WireRecipeSchema>): GroveRecipe {
  return {
    kind: "recipe",
    recipeVersion: wire.recipe_version,
    name: wire.name,
    version: wire.version,
    ...(wire.description !== undefined && { description: wire.description }),
    ...(wire.labels !== undefined && { labels: wire.labels }),
    ...(wire.parameters !== undefined && { parameters: wire.parameters }),
    ...(wire.extensions !== undefined && { extensions: wire.extensions }),
    ...(wire.activities !== undefined && { activities: wire.activities }),
    ...(wire.instructions !== undefined && { instructions: wire.instructions }),
    ...(wire.agent_topology !== undefined && { topology: wireToTopology(wire.agent_topology) }),
    ...(wire.context_manifests !== undefined && { contextManifests: wire.context_manifests }),
    ...(wire.sub_recipes !== undefined && { subRecipes: wire.sub_recipes }),
    ...(wire.response !== undefined && { response: wire.response }),
    ...(wire.run_policy !== undefined && {
      runPolicy: {
        ...(wire.run_policy.max_iterations !== undefined && { maxIterations: wire.run_policy.max_iterations }),
        ...(wire.run_policy.max_no_improvement_rounds !== undefined && {
          maxNoImprovementRounds: wire.run_policy.max_no_improvement_rounds,
        }),
        ...(wire.run_policy.improvement_threshold !== undefined && {
          improvementThreshold: wire.run_policy.improvement_threshold,
        }),
        ...(wire.run_policy.direction !== undefined && { direction: wire.run_policy.direction }),
      },
    }),
    ...(wire.library !== undefined && { library: wire.library }),
  };
}

function canonicalize(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not allowed");
    return JSON.stringify(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
    .join(",")}}`;
}

function digestObject(value: unknown): string {
  return `blake3:${hash(canonicalize(value)).toString("hex")}`;
}

export function computeRecipeDigest(recipe: GroveRecipe): string {
  return digestObject(recipe);
}

export function computeBoundRecipeDigest(bound: BoundRecipe): string {
  return digestObject({
    recipeDigest: bound.recipeDigest,
    parameters: bound.parameters,
    subRecipes: bound.recipe.subRecipes ?? [],
  });
}

export function bindRecipeParameters(
  recipe: GroveRecipe,
  overrides: Readonly<Record<string, JsonValue>> = {},
): BoundRecipe {
  const parameters: Record<string, JsonValue> = {};
  for (const [name, definition] of Object.entries(recipe.parameters ?? {})) {
    const value = overrides[name] ?? definition.default;
    if (value === undefined) {
      if (definition.required === true) throw new Error(`Missing required parameter: ${name}`);
      continue;
    }
    validateBoundParameter(name, definition, value);
    parameters[name] = value;
  }
  for (const name of Object.keys(overrides)) {
    if (recipe.parameters?.[name] === undefined) {
      throw new Error(`Unknown parameter: ${name}`);
    }
  }
  const recipeDigest = computeRecipeDigest(recipe);
  return {
    recipe,
    recipeDigest,
    parameters,
    ...(recipe.instructions !== undefined && {
      renderedInstructions: renderRecipeTemplate(recipe.instructions, parameters),
    }),
  };
}

function validateBoundParameter(name: string, definition: RecipeParameter, value: JsonValue): void {
  if (definition.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    throw new Error(`Parameter ${name} must be an integer`);
  }
  if (definition.type === "number" && typeof value !== "number") {
    throw new Error(`Parameter ${name} must be a number`);
  }
  if (definition.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`Parameter ${name} must be a boolean`);
  }
  if ((definition.type === "string" || definition.type === "path") && typeof value !== "string") {
    throw new Error(`Parameter ${name} must be a string`);
  }
  if (definition.type === "enum") {
    if (typeof value !== "string") throw new Error(`Parameter ${name} must be a string`);
    if (!definition.enum?.includes(value)) throw new Error(`Parameter ${name} must be one of ${definition.enum?.join(", ")}`);
  }
}

export function renderRecipeTemplate(
  template: string,
  parameters: Readonly<Record<string, JsonValue>>,
): string {
  return template.replace(/\$\{parameters\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\}/g, (_match, path: string) => {
    const value = resolveParameterPath(parameters, path);
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  });
}

function resolveParameterPath(parameters: Readonly<Record<string, JsonValue>>, path: string): JsonValue {
  const parts = path.split(".");
  let current: JsonValue | undefined = parameters[parts[0] ?? ""];
  for (const part of parts.slice(1)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(`Invalid parameter path: ${path}`);
    }
    current = current[part];
  }
  if (current === undefined) throw new Error(`Missing template parameter: ${path}`);
  return current;
}

export function materializeRecipeContract(bound: BoundRecipe): MaterializedRecipe {
  const recipe = bound.recipe;
  const boundParameterDigest = computeBoundRecipeDigest(bound);
  const contract: GroveContract = {
    contractVersion: 3,
    name: recipe.name,
    ...(recipe.description !== undefined && { description: recipe.description }),
    ...(recipe.topology !== undefined && { topology: recipe.topology }),
    ...(recipe.runPolicy?.maxIterations !== undefined && {
      stopConditions: {
        budget: { maxContributions: recipe.runPolicy.maxIterations },
      },
    }),
  };
  return {
    contract,
    provenance: {
      recipeDigest: bound.recipeDigest,
      recipeName: recipe.name,
      recipeVersion: recipe.version,
      boundParameterDigest,
      subRecipeDigests: [],
    },
    ...(bound.renderedInstructions !== undefined && { renderedInstructions: bound.renderedInstructions }),
  };
}
```

- [ ] **Step 4: Export recipe helpers**

Append to `src/core/index.ts` near the contract exports:

```ts
export type {
  BoundRecipe,
  GroveRecipe,
  MaterializedRecipe,
  RecipeActivity,
  RecipeExtension,
  RecipeLibraryMetadata,
  RecipeParameter,
  RecipeParameterType,
  RecipeProvenance,
  RecipeRunPolicy,
  RecipeSubRecipe,
} from "./recipe.js";
export {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  materializeRecipeContract,
  parseGroveRecipe,
  parseGroveRecipeObject,
  renderRecipeTemplate,
} from "./recipe.js";
```

Append to `src/index.ts` near the contract exports:

```ts
export type {
  BoundRecipe,
  GroveRecipe,
  MaterializedRecipe,
  RecipeActivity,
  RecipeExtension,
  RecipeLibraryMetadata,
  RecipeParameter,
  RecipeParameterType,
  RecipeProvenance,
  RecipeRunPolicy,
  RecipeSubRecipe,
} from "./core/recipe.js";
export {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  materializeRecipeContract,
  parseGroveRecipe,
  parseGroveRecipeObject,
  renderRecipeTemplate,
} from "./core/recipe.js";
```

- [ ] **Step 5: Run focused core tests**

Run:

```bash
bun test src/core/recipe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck for exported API**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit core recipe parser and digest**

```bash
git add src/core/recipe.ts src/core/recipe.test.ts src/core/index.ts src/index.ts
git commit -m "feat(core): add grove recipe parser"
```

### Task 3: Recipe Discovery

**Files:**
- Modify: `src/core/recipe.ts`
- Modify: `src/core/recipe.test.ts`

- [ ] **Step 1: Add failing discovery tests**

Append to `src/core/recipe.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverRecipes } from "./recipe.js";

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
});
```

- [ ] **Step 2: Run test and verify missing export**

Run:

```bash
bun test src/core/recipe.test.ts
```

Expected: FAIL with `discoverRecipes is not a function` or a missing export error.

- [ ] **Step 3: Add discovery helpers**

Update the existing import block in `src/core/recipe.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
```

Then append the discovery types and helpers below `materializeRecipeContract()`:

```ts
export type RecipeSource = "project" | "workspace" | "user";

export interface DiscoveredRecipe {
  readonly path: string;
  readonly source: RecipeSource;
  readonly recipe: GroveRecipe;
  readonly digest: string;
}

export interface DiscoverRecipesOptions {
  readonly cwd: string;
  readonly homeConfigDir?: string | undefined;
}

export async function discoverRecipes(options: DiscoverRecipesOptions): Promise<readonly DiscoveredRecipe[]> {
  const roots: readonly { readonly source: RecipeSource; readonly dir: string }[] = [
    { source: "project", dir: join(options.cwd, "recipes") },
    { source: "workspace", dir: join(options.cwd, ".grove", "recipes") },
    { source: "user", dir: options.homeConfigDir ?? join(process.env.HOME ?? "", ".config", "grove", "recipes") },
  ];
  const discovered: DiscoveredRecipe[] = [];
  for (const root of roots) {
    for (const path of await listYamlFiles(root.dir)) {
      const content = await readFile(path, "utf-8");
      const recipe = parseGroveRecipe(content);
      discovered.push({
        path,
        source: root.source,
        recipe,
        digest: computeRecipeDigest(recipe),
      });
    }
  }
  return discovered.sort((a, b) => {
    const sourceRank = sourceOrder(a.source) - sourceOrder(b.source);
    if (sourceRank !== 0) return sourceRank;
    return a.path.localeCompare(b.path) || a.recipe.name.localeCompare(b.recipe.name);
  });
}

async function listYamlFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await listYamlFiles(path)));
      if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        files.push(path);
      }
    }
    return files.sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function sourceOrder(source: RecipeSource): number {
  if (source === "project") return 0;
  if (source === "workspace") return 1;
  return 2;
}
```

- [ ] **Step 4: Export discovery helpers**

Append to `src/core/index.ts` and `src/index.ts` recipe type exports:

```ts
export type { DiscoveredRecipe, DiscoverRecipesOptions, RecipeSource } from "./recipe.js";
export { discoverRecipes } from "./recipe.js";
```

For `src/index.ts`, use:

```ts
export type { DiscoveredRecipe, DiscoverRecipesOptions, RecipeSource } from "./core/recipe.js";
export { discoverRecipes } from "./core/recipe.js";
```

- [ ] **Step 5: Run discovery tests**

Run:

```bash
bun test src/core/recipe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit discovery helpers**

```bash
git add src/core/recipe.ts src/core/recipe.test.ts src/core/index.ts src/index.ts
git commit -m "feat(core): discover grove recipes"
```

### Task 4: Recipe Validate CLI

**Files:**
- Create: `src/cli/commands/recipe.test.ts`
- Create: `src/cli/commands/recipe.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Write failing validate command tests**

Create `src/cli/commands/recipe.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests and verify missing module failure**

Run:

```bash
bun test src/cli/commands/recipe.test.ts
```

Expected: FAIL with `Cannot find module './recipe.js'`.

- [ ] **Step 3: Implement validate command**

Create `src/cli/commands/recipe.ts`:

```ts
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  discoverRecipes,
  materializeRecipeContract,
  parseGroveRecipe,
} from "../../core/recipe.js";
import { UsageError } from "../errors.js";

type RecipeCommand =
  | { readonly command: "validate"; readonly path: string; readonly json: boolean }
  | { readonly command: "list"; readonly dir?: string | undefined; readonly json: boolean }
  | {
      readonly command: "run";
      readonly path: string;
      readonly params: Readonly<Record<string, string>>;
      readonly dryRun: boolean;
      readonly json: boolean;
    };

interface RecipeDeps {
  readonly cwd: string;
  readonly writer: (line: string) => void;
}

export function parseRecipeArgs(argv: readonly string[]): RecipeCommand {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "validate") {
    const parsed = parseArgs({
      args: [...rest],
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
    const path = parsed.positionals[0];
    if (path === undefined) throw new UsageError("recipe validate requires <path>");
    return { command: "validate", path, json: parsed.values.json ?? false };
  }
  if (subcommand === "list") {
    const parsed = parseArgs({
      args: [...rest],
      options: { dir: { type: "string" }, json: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    });
    return { command: "list", dir: parsed.values.dir, json: parsed.values.json ?? false };
  }
  if (subcommand === "run") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        param: { type: "string", multiple: true },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const path = parsed.positionals[0];
    if (path === undefined) throw new UsageError("recipe run requires <path>");
    return {
      command: "run",
      path,
      params: parseParamFlags(parsed.values.param ?? []),
      dryRun: parsed.values["dry-run"] ?? false,
      json: parsed.values.json ?? false,
    };
  }
  throw new UsageError("recipe requires subcommand: validate, list, or run");
}

export async function handleRecipe(args: readonly string[], cwd = process.cwd()): Promise<void> {
  await runRecipe(parseRecipeArgs(args), { cwd, writer: console.log });
}

export async function runRecipe(command: RecipeCommand, deps: RecipeDeps): Promise<void> {
  if (command.command === "validate") {
    const content = await readFile(command.path, "utf-8");
    const recipe = parseGroveRecipe(content);
    const digest = computeRecipeDigest(recipe);
    if (command.json) {
      deps.writer(JSON.stringify({ valid: true, name: recipe.name, version: recipe.version, digest }, null, 2));
      return;
    }
    deps.writer(`Valid recipe: ${recipe.name}@${recipe.version}`);
    deps.writer(`Digest: ${digest}`);
    return;
  }
  if (command.command === "list") {
    const entries = await discoverRecipes({ cwd: command.dir ?? deps.cwd });
    if (command.json) {
      deps.writer(JSON.stringify(entries, null, 2));
      return;
    }
    deps.writer(entries.length === 0 ? "No recipes found." : entries.map((entry) => `${entry.recipe.name}@${entry.recipe.version} ${entry.path}`).join("\n"));
    return;
  }
  const content = await readFile(command.path, "utf-8");
  const recipe = parseGroveRecipe(content);
  const bound = bindRecipeParameters(recipe, command.params);
  const materialized = materializeRecipeContract(bound);
  if (!command.dryRun) {
    throw new UsageError("recipe run currently requires --dry-run");
  }
  const payload = {
    recipe: { name: recipe.name, version: recipe.version },
    recipeDigest: bound.recipeDigest,
    boundParameterDigest: computeBoundRecipeDigest(bound),
    parameters: bound.parameters,
    renderedInstructions: materialized.renderedInstructions,
    contract: materialized.contract,
    provenance: materialized.provenance,
  };
  deps.writer(command.json ? JSON.stringify(payload, null, 2) : formatDryRun(payload));
}

function parseParamFlags(flags: readonly string[]): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const flag of flags) {
    const equals = flag.indexOf("=");
    if (equals <= 0) throw new UsageError(`Invalid --param: ${flag}`);
    params[flag.slice(0, equals)] = flag.slice(equals + 1);
  }
  return params;
}

function formatDryRun(payload: {
  readonly recipe: { readonly name: string; readonly version: string };
  readonly recipeDigest: string;
  readonly boundParameterDigest: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly renderedInstructions?: string | undefined;
}): string {
  const lines = [
    `Recipe dry-run: ${payload.recipe.name}@${payload.recipe.version}`,
    `Recipe digest: ${payload.recipeDigest}`,
    `Bound digest: ${payload.boundParameterDigest}`,
    `Parameters: ${JSON.stringify(payload.parameters)}`,
  ];
  if (payload.renderedInstructions !== undefined) {
    lines.push("Rendered instructions:");
    lines.push(payload.renderedInstructions);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Register CLI command**

Add this command object in `buildCommands()` in `src/cli/main.ts` near `goal` or `session`:

```ts
    {
      name: "recipe",
      description: "Validate, list, and dry-run Grove recipes",
      needsStore: false,
      helpText: `grove recipe — validate, list, and dry-run Grove recipes

Usage:
  grove recipe validate <path> [--json]
  grove recipe list [--dir <path>] [--json]
  grove recipe run <path> --dry-run [--param key=value] [--json]`,
      handler: async (args) => {
        const { handleRecipe } = await import("./commands/recipe.js");
        await handleRecipe(args);
      },
    },
```

- [ ] **Step 5: Run validate command tests**

Run:

```bash
bun test src/cli/commands/recipe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit validate CLI**

```bash
git add src/cli/commands/recipe.ts src/cli/commands/recipe.test.ts src/cli/main.ts
git commit -m "feat(cli): validate grove recipes"
```

### Task 5: Recipe List CLI

**Files:**
- Modify: `src/cli/commands/recipe.test.ts`
- Modify: `src/cli/commands/recipe.ts`

- [ ] **Step 1: Add failing list tests**

Append to `src/cli/commands/recipe.test.ts` inside `describe("recipe command", () => { ... })`:

```ts
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
```

Add `mkdir` to the existing `node:fs/promises` import:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Run tests and verify list behavior fails if not already implemented**

Run:

```bash
bun test src/cli/commands/recipe.test.ts
```

Expected before implementing list: FAIL on list output. If Task 4 already included working list code, this command may PASS; in that case inspect the test output and proceed to Step 4.

- [ ] **Step 3: Implement or tighten list output**

In `src/cli/commands/recipe.ts`, make sure the list branch is exactly:

```ts
  if (command.command === "list") {
    const entries = await discoverRecipes({ cwd: command.dir ?? deps.cwd });
    if (command.json) {
      deps.writer(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      deps.writer("No recipes found.");
      return;
    }
    deps.writer(
      entries
        .map((entry) => `${entry.recipe.name}@${entry.recipe.version} ${entry.source} ${entry.path}`)
        .join("\n"),
    );
    return;
  }
```

- [ ] **Step 4: Run list tests**

Run:

```bash
bun test src/cli/commands/recipe.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit list CLI**

```bash
git add src/cli/commands/recipe.ts src/cli/commands/recipe.test.ts
git commit -m "feat(cli): list grove recipes"
```

### Task 6: Recipe Run Dry-Run CLI

**Files:**
- Modify: `src/cli/commands/recipe.test.ts`
- Modify: `src/cli/commands/recipe.ts`
- Modify: `src/core/recipe.test.ts`
- Modify: `src/core/recipe.ts`

- [ ] **Step 1: Add failing dry-run CLI tests**

Append to `src/cli/commands/recipe.test.ts`:

```ts
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
          "  Review ${parameters.target_path}.",
          "",
        ].join("\n"),
      );
      const { lines, writer } = createWriter();
      await runRecipe(parseRecipeArgs(["run", recipePath, "--dry-run", "--param", "target_path=src/core"]), {
        cwd: dir,
        writer,
      });
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
```

- [ ] **Step 2: Add failing typed parameter binding tests**

Append to `src/core/recipe.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run tests and verify type coercion fails**

Run:

```bash
bun test src/core/recipe.test.ts src/cli/commands/recipe.test.ts
```

Expected before coercion: FAIL because string `"4"` is not accepted as integer.

- [ ] **Step 4: Add safe CLI value coercion**

In `src/core/recipe.ts`, replace the `const value = overrides[name] ?? definition.default;` line inside `bindRecipeParameters()` with:

```ts
    const rawValue = overrides[name] ?? definition.default;
    const value = rawValue === undefined ? undefined : coerceParameterValue(name, definition, rawValue);
```

Add this helper below `bindRecipeParameters()`:

```ts
function coerceParameterValue(
  name: string,
  definition: RecipeParameter,
  value: JsonValue,
): JsonValue {
  if (typeof value !== "string") return value;
  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(value)) throw new Error(`Parameter ${name} must be an integer`);
    return Number(value);
  }
  if (definition.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Parameter ${name} must be a number`);
    return parsed;
  }
  if (definition.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Parameter ${name} must be true or false`);
  }
  if (definition.type === "json") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      throw new Error(`Parameter ${name} must be valid JSON`);
    }
  }
  return value;
}
```

- [ ] **Step 5: Run dry-run tests**

Run:

```bash
bun test src/core/recipe.test.ts src/cli/commands/recipe.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit dry-run behavior**

```bash
git add src/core/recipe.ts src/core/recipe.test.ts src/cli/commands/recipe.ts src/cli/commands/recipe.test.ts
git commit -m "feat(cli): dry-run grove recipes"
```

### Task 7: CLI Integration And Package Verification

**Files:**
- Modify: `src/cli/cli.integration.test.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Add failing CLI integration smoke test**

Append to `src/cli/cli.integration.test.ts` inside the top-level `describe`:

```ts
  test("grove recipe validate works through the CLI entrypoint", async () => {
    const recipePath = join(tempDir, "review.yaml");
    await Bun.write(
      recipePath,
      "kind: recipe\nrecipe_version: 1\nname: review-loop\nversion: 1.0.0\n",
    );

    const result = await runGrove(["recipe", "validate", recipePath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Valid recipe: review-loop@1.0.0");
  });
```

- [ ] **Step 2: Run integration test**

Run:

```bash
bun test src/cli/cli.integration.test.ts
```

Expected: PASS after command registration. If it fails with an unknown command, verify the `recipe` command object is inside `buildCommands()`.

- [ ] **Step 3: Run focused recipe suite**

Run:

```bash
bun test spec/schemas/grove-recipe.test.ts src/core/recipe.test.ts src/cli/commands/recipe.test.ts src/cli/cli.integration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 6: Commit integration coverage**

```bash
git add src/cli/cli.integration.test.ts src/cli/main.ts
git commit -m "test(cli): cover recipe command entrypoint"
```

### Task 8: Final Verification

**Files:**
- No source edits unless verification finds a concrete failure.

- [ ] **Step 1: Inspect changed files**

Run:

```bash
git status --short
git log --oneline --decorate -8
```

Expected: only intentional files are modified or committed.

- [ ] **Step 2: Run final focused tests**

Run:

```bash
bun test spec/schemas/grove-recipe.test.ts src/core/recipe.test.ts src/cli/commands/recipe.test.ts src/cli/cli.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run lint/check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 6: Record follow-up boundaries in final response**

Final response should state:

```text
Implemented Grove Recipes v1 through validate/list/dry-run materialization.
Real recipe execution and Nexus workflow compilation are intentionally left for the follow-up plan named in the design.
```

## Spec Coverage Self-Review

- Recipe as library object: covered by Task 1 schema/docs and Task 2 parser types.
- Strict schema and wire/camel split: covered by Task 1 JSON Schema and Task 2 Zod parser.
- Parameter binding and safe templates: covered by Task 2 and Task 6.
- Sub-recipes: schema and parsed fields are covered in Task 1 and Task 2; cycle resolution is not implemented in this first dry-run slice because recipe ref loading is not part of dry-run materialization yet.
- Materialization into sessions: covered by Task 2 `materializeRecipeContract()` and Task 6 CLI dry-run payload.
- Digest and reproducibility: covered by Task 2 digest tests and Task 6 bound digest output.
- CLI validate/list/run dry-run: covered by Tasks 4, 5, 6, and 7.
- Nexus workflow brick compatibility: documented in the spec; runtime adapter is out of this first implementation slice.
- Error handling: covered for schema, parameter, and dry-run rejection paths; extension availability and sub-recipe cycle errors need the follow-up runtime/ref-resolution slice.
- Testing: covered by schema, core, CLI command, integration, typecheck, Biome, and whitespace checks.
