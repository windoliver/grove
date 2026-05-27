# Grove Recipes - Design

**Issue:** [windoliver/grove#276](https://github.com/windoliver/grove/issues/276)
**Date:** 2026-05-27
**Status:** Approved design

## Problem

`GROVE.md` is the session-level contract for a checkout. It is good at describing
the active grove, but it is not a portable workflow artifact:

- it is edited in place inside one working tree
- parameters are usually copied into prose or topology fields by hand
- reusable sub-agent patterns live in presets, prompts, or local convention
- there is no deterministic object to hash, share, search, or re-run

Issue #377 broadens this into a shared library layer. Recipes should therefore
be one library object type, not a second session format that competes with
`GROVE.md`.

## Goals

- Define a versioned `GroveRecipe` YAML contract for shareable workflows.
- Keep `GROVE.md` as the generated or attached session-level contract.
- Make recipe execution reproducible by hashing the canonical recipe plus bound
  parameters and recording that digest on the session.
- Support parameters, extension requirements, activities, instructions,
  topology, sub-recipes, context manifests, response schema, and run policy.
- Make the schema compatible with the future library layer from #377.
- Leave room to compile recipes into Nexus workflow brick primitives without
  coupling the first Grove spec to Nexus internals.

## Non-Goals

- Replacing `GROVE.md`.
- Building a general-purpose task runner or cache system.
- Implementing the full recipe runtime in the first spec PR.
- Executing arbitrary template code inside recipe files.
- Solving publication, signing, search ranking, or permissions for every
  library object. Those belong in the broader library-layer work.

## Current Anchors

| File or issue | Current role |
| --- | --- |
| `src/core/contract.ts` | Strict Zod parser for `GROVE.md` contracts and the model to mirror for recipe parsing. |
| `spec/schemas/grove-contract.json` | JSON Schema pattern for wire-format validation. |
| `src/core/manifest.ts` | Canonical JSON and BLAKE3 digest precedent for immutable identifiers. |
| `src/core/topology.ts` | Existing `agent_topology` schema that recipes should reuse. |
| `src/core/session-config.ts` | Session runtime lens; recipe materialization should produce this shape through a `GroveContract`. |
| `src/core/loop-runner.ts` | Deterministic execution loop added for #340; recipe runs should delegate stop decisions to this layer. |
| `src/nexus/nexus-workflow-store.ts` | Durable workflow-state bridge already used by loop execution. |
| #377 | Parent library-object model that recipes must fit into. |
| #342 | Context manifests, which recipes may reference or extend per role. |

## Design

### Recipe As A Library Object

Add `Recipe` as a library object type whose first concrete wire format is
`GroveRecipe` YAML. The object contract should include library metadata in a
stable envelope so #377 can use the same ownership, versioning, import/export,
and search model for recipes, plans, skill packs, context manifests, rubrics,
notebooks, and autonomy profiles.

Recommended top-level shape:

```yaml
kind: recipe
recipe_version: 1
name: code-review-loop
version: 1.0.0
description: Coder and reviewer iterate on a feature
labels: [code-review]

parameters:
  target_path:
    type: string
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
  - id: reviewer-reviews
    label: Reviewer reviews
    role: reviewer
  - id: converge
    label: Converge
    condition: "${parameters.max_rounds} > 0"

instructions: |
  You are working on ${parameters.target_path}.

agent_topology:
  structure: graph
  roles:
    - name: coder
      platform: codex
    - name: reviewer
      platform: claude-code
      edges:
        - target: coder
          edge_type: feedback

sub_recipes:
  - name: security-audit
    ref: ./recipes/security-audit.yaml
    when: "${parameters.target_path} matches '**/auth/**'"

response:
  schema:
    type: object
    properties:
      approved:
        type: boolean
      summary:
        type: string
```

The parser should reject unknown top-level fields. New fields require a
`recipe_version` bump or explicit optional schema addition.

### Schema And Types

Add a recipe module separate from `contract.ts`:

- `src/core/recipe.ts` for Zod schemas, TypeScript types, parsing, canonical
  digest helpers, and materialization types
- `spec/schemas/grove-recipe.json` for JSON Schema
- `spec/GROVE-RECIPES.md` for the prose contract

The module should follow Grove's current wire/camel split:

- YAML wire fields use `snake_case`.
- TypeScript types use `camelCase`.
- exported interfaces are readonly.
- unknown properties are rejected.
- `agent_topology` reuses `AgentTopologySchema`.

The first schema version should be intentionally narrow enough to implement:

| Field | Required | Notes |
| --- | --- | --- |
| `kind` | Yes | Must be `recipe`. |
| `recipe_version` | Yes | Start at `1`. |
| `name` | Yes | Stable human-readable recipe id. |
| `version` | Yes | Semver string for human/library versioning. |
| `description` | No | Search and list display. |
| `labels` | No | Search metadata. |
| `parameters` | No | Declarative parameter definitions. |
| `extensions` | No | Required tools, MCP servers, providers, or external systems. |
| `activities` | No | Ordered workflow stages that can compile to execution steps. |
| `instructions` | No | Template string injected into the materialized session. |
| `agent_topology` | No | Existing Grove topology shape. |
| `context_manifests` | No | References or inline manifests; compatible with #342. |
| `sub_recipes` | No | Composable child recipes with parameter overrides. |
| `response` | No | JSON Schema response expectations. |
| `run_policy` | No | Max iterations, plateau thresholds, and interrupt behavior for #340. |
| `library` | No | Owner, license, source, visibility, and search metadata for #377. |

### Parameters And Template Binding

Parameters are data, not executable code. Supported types:

- `string`
- `integer`
- `number`
- `boolean`
- `enum`
- `path`
- `json`

Each parameter can define `required`, `default`, `description`, and `enum`.
Binding should produce a `BoundRecipe` object with:

- the original recipe digest
- the final parameter map
- validation diagnostics
- the rendered instructions string
- the materialization input used for the session

Template substitution should start with a deliberately small expression surface:

- `${parameters.name}` references only bound parameters.
- missing parameters are validation errors.
- nested property access is allowed only for `json` parameters.
- no functions, shell expansion, environment reads, or arbitrary evaluation.

Conditions for activities and sub-recipes should use the same safe expression
evaluator. The first implementation may validate condition syntax without
executing conditional branches; that should be called `validate` or `dry-run`,
not `run`.

### Sub-Recipes

Sub-recipes declare composition, not in-process imports. A parent recipe may
reference another recipe by relative file path, library ref, or digest:

```yaml
sub_recipes:
  - name: security-audit
    ref: ./recipes/security-audit.yaml
    when: "${parameters.target_path} matches '**/auth/**'"
    parameters:
      target_path: "${parameters.target_path}"
```

Validation should detect cycles after refs are resolved. The materialized run
records the digest of every included recipe and the parameter overrides used for
each child.

### Materialization Into Sessions

Recipes do not execute directly. `grove recipe run` materializes a session:

1. Load and validate the recipe.
2. Bind parameters from defaults, config, and `--param key=value` flags.
3. Resolve extension requirements.
4. Resolve and validate sub-recipes.
5. Build a `GroveContract`-compatible session config.
6. Attach recipe provenance to the session.
7. Start the deterministic loop runner.

The materialized `GroveContract` uses:

- recipe `name` and `description` as the contract metadata unless overridden
- `agent_topology` from the recipe
- `run_policy` mapped to stop conditions and loop-runner options
- rendered `instructions` as session prompt/context
- context manifest refs preserved as runtime context requirements

Session records should include:

```ts
interface RecipeProvenance {
  readonly recipeDigest: string;
  readonly recipeName: string;
  readonly recipeVersion: string;
  readonly boundParameterDigest: string;
  readonly subRecipeDigests: readonly string[];
  readonly sourceRef?: string | undefined;
}
```

This can live in session metadata or a dedicated recipe provenance field. The
implementation plan should choose based on the current session schema migration
surface.

### Digest And Reproducibility

Use the same conceptual digest model as contribution manifests:

- parse YAML into a normalized recipe object
- render no defaults into the source digest unless the schema specifies them as
  semantic defaults
- canonicalize to sorted-key JSON
- hash with BLAKE3
- prefix with `blake3:`

Two digests are useful:

- `recipeDigest`: the reusable recipe object itself
- `boundParameterDigest`: recipe digest plus the final parameter map and
  selected sub-recipes

The session should record both so users can answer different questions:

- "Which recipe did this come from?"
- "Can I re-run exactly this bound workflow?"

### CLI

Add a `recipe` command group:

```text
grove recipe validate <path>
grove recipe list [--dir <path>] [--json]
grove recipe run <path> --param key=value [--dry-run]
```

`validate` loads a recipe and reports schema, parameter, extension, and
sub-recipe diagnostics.

`list` discovers recipes from:

- `./recipes/`
- `.grove/recipes/`
- `~/.config/grove/recipes/`

Discovery should be deterministic: sort by source priority, then relative path,
then recipe name. Duplicate names are warnings, not fatal errors, because
multiple versions may coexist.

`run --dry-run` prints the bound parameters, recipe digest, included
sub-recipes, extension requirements, and the materialized session contract
without starting agents.

`run` without `--dry-run` should be implemented after validation and dry-run are
stable.

### Nexus Workflow Brick Compatibility

Recipes should be able to compile to Nexus workflow primitives later, but Grove
should not depend on the Python workflow brick at schema time. The recipe model
maps cleanly:

| Recipe field | Nexus workflow concept |
| --- | --- |
| `name`, `version`, `description` | `WorkflowDefinition` metadata |
| `parameters` | `variables` |
| `activities` | ordered `WorkflowAction` records |
| `run_policy` | execution context and stop policy |
| external triggers | `WorkflowTrigger` records |

Grove-specific actions should be an adapter layer:

- `spawn`
- `claim`
- `contribute`
- `handoff`
- `wait_for_condition`

The adapter can emit Nexus `WorkflowAction` objects when Nexus is available and
fall back to local Grove orchestration when it is not.

### Error Handling

Validation should distinguish:

- schema errors
- parameter binding errors
- missing extension errors
- unresolved recipe refs
- sub-recipe cycles
- unsafe template expressions
- materialization errors
- runtime errors

CLI output should be human-readable by default and machine-readable under
`--json`. Error messages should include a recipe path and a field path whenever
possible.

### Testing

The implementation plan should include:

- parser tests for required fields, unknown fields, type validation, and
  topology reuse
- digest tests proving stable key ordering and parameter digest separation
- template binding tests for valid references, missing parameters, unsafe
  expressions, and JSON parameter access
- sub-recipe tests for relative refs, parameter overrides, missing refs, and
  cycles
- CLI tests for `validate`, `list`, and `run --dry-run`
- materialization tests showing a recipe becomes a `GroveContract`-compatible
  session config
- JSON Schema tests under `spec/schemas/`

## Rollout

1. Land spec docs and schema/type tests only.
2. Add parser and digest helpers.
3. Add `grove recipe validate`.
4. Add deterministic recipe discovery and `grove recipe list`.
5. Add parameter binding and `run --dry-run`.
6. Add session materialization.
7. Add real `run` through the loop runner.
8. Add optional Nexus workflow adapter.

Each step should leave the CLI and package exports passing typecheck.

## Open Questions For Implementation Planning

- Whether recipe provenance should be a dedicated session field or session
  metadata.
- Whether context manifests are inline in recipe v1 or only references until
  #342 lands.
- Whether `path` parameters should normalize relative to the recipe file, the
  current working directory, or the target grove root. The recommended default is
  recipe-relative for defaults and caller-relative for `--param` values, with the
  bound value recorded as a normalized path.
- Whether `recipe run` should always create a session, or allow a pure local
  execution mode later. The recommended v1 answer is session-only.
