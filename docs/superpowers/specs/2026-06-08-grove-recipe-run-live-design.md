# Grove Recipe — Live Run (issue #276 follow-up)

Status: approved design, pre-implementation
Issue: windoliver/grove#276
Prior art: `docs/superpowers/specs/2026-05-27-grove-recipes-design.md` (dry-run phase)

## Goal

Make `grove recipe run <path> [--param k=v]...` (without `--dry-run`) materialize the
recipe into a **persistent, launched session**. The resulting session record carries the
recipe digest so re-runs are reproducible, and declared `stdio:` MCP extensions are wired
into every spawned agent.

Today `recipe.ts` throws `"recipe run currently requires --dry-run"`. The dry-run pipeline
(`parseGroveRecipe` → `bindRecipeParameters` → `materializeRecipeContract`) is complete and
already emits a `GroveContract`, rendered instructions, topology, run policy, extensions, and
provenance digests. This work feeds those outputs into the same launch path that
`grove session start` uses.

## Non-goals (separate #276 chunks — record-only here)

- **Sub-recipe composition** — `sub_recipes` are materialized into provenance but not loaded
  or spawned.
- **Non-`stdio` extensions** — `type: tool|provider|service`, and `mcp` extensions whose URI
  is not `stdio:`, are not wired. Required ones fail fast; optional ones warn and skip.
- **Extension availability probing** — we map and attach `stdio:` MCP servers but do not
  health-check that the command exists before launch.

## Decisions (locked with user)

1. **Approach A — shared launcher.** Extract the launch core from `sessionStart` into a
   reusable helper; both `session start` and `recipe run` call it.
2. **Goal source.** The recipe's rendered `instructions` is the session goal; `--goal`
   overrides; error if neither yields a non-empty goal.
3. **Wire extensions this pass.** Declared `stdio:` MCP extensions attach to every agent.

## Components & data flow

### 1. Shared launcher — `src/cli/utils/launch-session.ts` (new)

Extract the launch core currently inlined in `sessionStart` (`src/cli/commands/session.ts`
≈ lines 181–421) into:

```ts
export interface LaunchGoalSessionInput {
  readonly groveDir: string;
  readonly groveRoot: string;
  readonly goal: string;
  readonly topology: AgentTopology;
  readonly contract?: GroveContract | undefined;
  readonly repos: readonly RepoRef[];
  readonly extraMcpServers?: NonNullable<AgentConfig["mcpServers"]> | undefined;
  readonly recipeProvenance?: RecipeProvenance | undefined;
}

export interface LaunchGoalSessionResult {
  readonly sessionId: string;
  readonly stopStatus: LoopStopStatus;
  readonly stopReason: string;
}

export async function launchGoalSession(
  input: LaunchGoalSessionInput,
): Promise<LaunchGoalSessionResult>;
```

The launcher owns everything `sessionStart` does after topology resolution:

- runtime selection (`selectRuntime`, acpx/acp → `MockRuntime` fallback) honoring
  `GROVE_RUNTIME` and `GROVE_ALLOW_ALL_PERMISSIONS`,
- `SqliteGoalSessionStore.createSession` (now also persisting `recipeProvenance`),
- Nexus mirror (`putSession` with retries; orphan archive + rethrow on failure),
- `SessionOrchestrator.start()` (passing `extraMcpServers` through),
- `GroveLoopRunner` wait-for-completion + `markDone`,
- interrupt handlers + `finally` db close.

`sessionStart` becomes a thin caller: parse args → resolve topology → `launchGoalSession` →
print JSON. **No behavior change** to `session start`; its existing tests are the regression
guard that proves the extraction is behavior-preserving.

### 2. Recipe → launch inputs — `src/cli/commands/recipe.ts`

The live branch of `runRecipe` (replacing the `--dry-run` guard at recipe.ts:126):

1. `readFile` → `parseGroveRecipe` → `bindRecipeParameters(recipe, params)` →
   `materializeRecipeContract(bound)`.
2. `goal` = `--goal` value if non-empty, else `materialized.renderedInstructions`.
   If both empty → `UsageError`.
3. `topology` = `materialized.contract.topology`. If absent → `UsageError`
   (cannot spawn agents with no roles).
4. `extraMcpServers` = `resolveRecipeMcpServers(recipe.extensions ?? [])`.
5. `repos` = `buildRepos({ rawRepo: --repo flags, cwd: groveRoot })` (same as `session start`).
6. Resolve `groveDir` via `findGroveDir(cwd)`; error if not inside a grove.
7. Call `launchGoalSession({ ... recipeProvenance: materialized.provenance })`.

New flags on `recipe run`: `--goal <string>` and `--repo <ref>` (multiple), alongside the
existing `--param`, `--json`. `--dry-run` keeps its current behavior.

### 3. Extension wiring — `src/core/recipe-extensions.ts` (new)

```ts
export function resolveRecipeMcpServers(
  extensions: readonly RecipeExtension[],
): NonNullable<AgentConfig["mcpServers"]>;
```

Mapping rules:

- `type: "mcp"`, `uri` starts with `stdio:` → `{ name, command, args }` where the text after
  `stdio:` is split on whitespace into `[command, ...args]`. Empty command → error.
- `type: "mcp"` with a non-`stdio:` URI (or no URI), or `type: "tool"|"provider"|"service"`
  → not expressible in the current stdio-only `AgentConfig.mcpServers`. If
  `required: true` → throw
  (`extension '<name>' is not launchable: only stdio: MCP URIs are wired today`);
  otherwise log a warning and skip.

`SessionOrchestrator` config gains optional `extraMcpServers`. The per-role spawn
(orchestrator.ts:659) changes from:

```ts
mcpServers: [this.groveMcpServer(role.name)],
```
to:
```ts
mcpServers: [this.groveMcpServer(role.name), ...(this.config.extraMcpServers ?? [])],
```

Backward-compatible: `session start` and the TUI pass nothing, preserving current behavior.
The runtime already forwards `AgentConfig.mcpServers` to agents via ACP `session/new`
(see `agent-runtime.ts` `mcpServers` doc), so no new runtime plumbing is required.

### 4. Provenance persistence

- `Session` and `CreateSessionInput` (`src/core/session.ts`) gain optional
  `recipeProvenance?: RecipeProvenance` (the existing type from `src/core/recipe.ts`:
  `recipeDigest`, `recipeName`, `recipeVersion`, `boundParameterDigest`, `subRecipeDigests`,
  `sourceRef?`).
- SQLite (`src/local/sqlite-goal-session-store.ts`): additive, idempotent migration
  `ALTER TABLE sessions ADD COLUMN recipe_provenance_json TEXT` (guarded the same way other
  back-compat column adds are), serialized on create and hydrated on read.
- Nexus session store: include `recipeProvenance` in the JSON body (the store already
  round-trips session fields as JSON).
- `grove session status` / `grove session list` surface `recipeDigest` when present.

## Error handling

- Missing required param / unknown param → `bindRecipeParameters` throws (surfaced as
  `UsageError`).
- Empty goal, absent topology, or an unlaunchable **required** extension → `UsageError`
  raised **before** any session is created → nothing persisted (fail-closed).
- Nexus mirror failure → archive the orphan SQLite record + rethrow (reused from
  `sessionStart`, now living in the launcher).

## Testing

- **Unit**
  - `resolveRecipeMcpServers`: `stdio:` parse (command + args), required-non-stdio throws,
    optional non-stdio warns and is skipped, empty command errors.
  - recipe→launch-input mapping: goal precedence (`--goal` > instructions > error),
    topology-absent error.
- **Integration** (`GROVE_RUNTIME=mock`)
  - `recipe run` of a 2-role recipe → asserts a session row exists with
    `recipe_provenance_json` whose `recipeDigest` equals `grove recipe validate` output.
  - asserts each spawned `AgentConfig.mcpServers` includes both the `grove` server and the
    recipe's `stdio:` extension.
- **Refactor guard**: existing `grove session start` tests stay green (behavior-preserving
  extraction).
- **Real-process E2E** (`tests/e2e/recipe-run-tmux.ts`): tmux + real grove server +
  real Nexus running a 2-role review-loop recipe — confirms agents spawn, the `stdio:` MCP
  extension attaches, codex↔claude handoff completes, and the session record carries the
  recipe digest. Built on the `tests/e2e/watch-relist-tmux.ts` pattern.

## Files touched

- new: `src/cli/utils/launch-session.ts`, `src/core/recipe-extensions.ts`,
  `tests/e2e/recipe-run-tmux.ts`
- edit: `src/cli/commands/recipe.ts` (live branch + flags), `src/cli/main.ts` (help text),
  `src/cli/commands/session.ts` (thin caller of launcher),
  `src/core/session.ts` (provenance fields), `src/core/session-orchestrator.ts`
  (`extraMcpServers`), `src/local/sqlite-goal-session-store.ts` (column + migration),
  `src/nexus/nexus-session-store.ts` (provenance round-trip),
  `spec/GROVE-RECIPES.md` (live-run section replacing the "does not start agents" note)
