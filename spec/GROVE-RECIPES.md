# Grove Recipes

Grove Recipes are shareable YAML workflow objects. A recipe describes a portable
workflow pattern that can be validated, hashed, shared, and materialized into a
Grove session contract.

Recipes do not replace `GROVE.md`. Recipes are portable library content:
versioned workflow templates that may live in a local recipe directory, a shared
workspace library, or a public catalog. `GROVE.md` remains the session-level
contract for an active grove checkout.

## Wire Format

Recipe files use YAML and must validate against the Grove Recipe JSON Schema at
`spec/schemas/grove-recipe.json`.

Required top-level fields:

```yaml
kind: recipe
recipe_version: 1
name: code-review-loop
version: 1.0.0
```

Wire fields use `snake_case`. Unknown top-level fields are rejected. New
top-level fields require either an optional schema addition or a future
`recipe_version` bump.

`name` is a stable lowercase slug. `version` is a semver-like human and library
version string.

## Parameters

Recipes may define declarative parameters:

```yaml
parameters:
  target_path:
    type: path
    required: true
  max_rounds:
    type: integer
    default: 3
```

Supported parameter types:

- `string`
- `integer`
- `number`
- `boolean`
- `enum`
- `path`
- `json`

Each parameter may define `required`, `default`, `description`, and, for
`enum`, an `enum` value list. Defaults must match the declared parameter type.

## Templates

Template references use `${parameters.name}` only. Nested property access is
reserved for bound `json` parameters. Templates do not support shell expansion,
environment reads, functions, imports, or arbitrary code evaluation.

The same restricted reference form is used in `instructions`, activity
conditions, sub-recipe conditions, and sub-recipe parameter bindings.

## Workflow Fields

Recipes may include:

- `description` and `labels` for discovery.
- `extensions` for required MCP servers, tools, providers, or services.
- `activities` for ordered workflow stages.
- `instructions` for the rendered session prompt or context.
- `agent_topology` using the Grove contract topology shape.
- `context_manifests` for referenced context packs.
- `sub_recipes` for composable child recipes.
- `response.schema` for expected structured output.
- `run_policy` for iteration and improvement thresholds.
- `library` for owner, license, source, and visibility metadata.

`agent_topology` is compatible with the existing Grove contract topology shape:
`structure`, `roles`, role `edges`, `spawning`, and `edge_types`.

## Dry Run Materialization

`grove recipe run --dry-run` will validate the recipe, bind parameters, and
emit:

- the canonical recipe digest
- the bound-parameter digest
- rendered instructions
- selected sub-recipes and their parameter bindings
- required extensions
- a `GroveContract`-compatible session contract

## Live Run

`grove recipe run <path> [--param k=v] [--goal "..."] [--repo <ref>]` materializes the
recipe and launches a persistent session:

- The rendered `instructions` becomes the session goal (overridable with `--goal`).
- `agent_topology` roles are spawned via the shared launcher used by `grove session start`.
- Declared `stdio:` MCP `extensions` are wired into every agent (after the built-in `grove`
  server). Non-`stdio` extensions are skipped when optional and error when `required`.
- `run_policy` maps to the session contract's stop conditions.
- The session record stores the recipe digest and bound-parameter digest
  (`recipeProvenance`) so re-runs are reproducible.

Sub-recipe spawning and non-`stdio` extension wiring remain follow-up work.
