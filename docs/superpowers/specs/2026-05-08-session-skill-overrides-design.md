# Session-Level Skill Overrides Design

- **Issue**: [#327](https://github.com/windoliver/grove/issues/327)
- **Parent**: [#202](https://github.com/windoliver/grove/issues/202)
- **Date**: 2026-05-08
- **Status**: Approved for full issue scope

## Goal

Allow a single session launch to add, remove, replace, or clear topology
`role.skills` without editing `GROVE.md` or preset YAML, across both the CLI
and the TUI.

## Non-goals

- Do not add mid-session or hot-reload skill changes after agents start.
- Do not introduce a new persisted `skillOverrides` field on `Session` or in
  the frozen contract snapshot.
- Do not move skill existence validation out of bootstrap/injection into the
  CLI, TUI, or HTTP server.
- Do not redesign `grove skill install`, the skill catalog layout, or the
  workspace skill injector.
- Do not add a new standalone server API field for overrides when an edited
  topology already expresses the effective session state.

## Current State

Topology roles already carry `skills?: readonly string[]` in
[src/core/topology.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/core/topology.ts:327).
That value is treated as bootstrap input:

- Headless sessions call `bootstrapWorkspace({ skills: role.skills, ... })` in
  [src/core/session-orchestrator.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/core/session-orchestrator.ts:616).
- TUI spawns pass `context.skills = role.skills` and inject them in
  [src/tui/spawn-manager.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/tui/spawn-manager.ts:669).

Session creation already persists a fully resolved topology snapshot:

- CLI resolves `--roles > --preset > GROVE.md` in
  [src/cli/commands/session.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/cli/commands/session.ts:124).
- HTTP `POST /api/sessions` accepts an inline topology and stores it in the
  session record in
  [src/server/routes/sessions.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/server/routes/sessions.ts:78).
- The TUI already applies session-local topology edits for edge deadlines by
  cloning the topology before `createSession()` in
  [src/tui/screens/screen-manager.tsx](/Users/tafeng/.codex/worktrees/991b/grove/src/tui/screens/screen-manager.tsx:624).

The gap is narrow: there is no session-scoped way to mutate `role.skills`
before the topology snapshot is stored and later consumed by bootstrap.

## Chosen Approach

Treat session skill overrides as a topology rewrite step that runs after base
topology resolution and before session creation/spawn. The resulting effective
skill lists are written directly into `role.skills` on the session topology.

This is preferred over storing a separate `skillOverrides` object because:

- the effective topology is already the immutable session snapshot used by CLI,
  TUI, server, and runtime code paths;
- bootstrap already consumes `role.skills` and does not need new precedence
  logic;
- persisted sessions remain directly inspectable because the stored topology is
  the exact topology that launched.

The implementation therefore has two layers:

1. Parse or edit override intent at the surface layer:
   - CLI parses repeated `--skills` flags.
   - TUI edits effective skill lists directly in launch preview.
2. Apply those edits through one shared core helper that returns a cloned
   `AgentTopology` with updated `role.skills`.

## Override Model

### Targets

Overrides target either:

- a specific role name, for example `coder`
- all roles, using the blanket selector `*`

Unknown role names are rejected before session creation.

### Operations

Three operations are supported:

- `=` replace the target list
- `+=` append unique skills to the target list
- `-=` remove listed skills from the target list

Examples:

- `coder=grove,review`
- `coder+=lint`
- `reviewer-=grove`
- `*=grove`
- `*=`

Replace with an empty right-hand side clears the target list. Add/remove with
an empty list are treated as no-ops.

### Ordering and Precedence

Session skill override precedence is:

1. Resolve base topology exactly as today:
   - CLI `--roles` inline topology
   - CLI `--preset`
   - `GROVE.md` default topology
2. Apply blanket `*` clauses in input order.
3. Apply per-role clauses in input order.

Within a target group, later clauses win because they are applied after earlier
clauses. Blanket overrides never clobber a role-specific override because the
per-role group is always evaluated after the blanket group.

Examples:

- `--skills '*=grove' --skills 'coder+=review'`
  - every role gets `["grove"]`
  - `coder` becomes `["grove", "review"]`
- `--skills 'coder=grove' --skills '*=review'`
  - `coder` still ends as `["grove"]`
  - every other role ends as `["review"]`

### Deduplication and Order

Effective skill lists are deduped while preserving left-to-right order.

Rules:

- replace keeps the provided order and removes duplicates
- add appends only skills not already present
- remove preserves the order of remaining skills
- missing initial `role.skills` is treated as `[]`

This keeps stored topologies stable, readable, and deterministic in tests.

## CLI Design

`grove session start` gains a repeatable `--skills` flag:

```bash
grove session start \
  --goal "..." \
  --preset review-loop \
  --skills '*=grove' \
  --skills 'coder+=review' \
  --skills 'reviewer-=grove'
```

Design choices:

- one clause per `--skills` flag
- no semicolon mini-language inside a single flag
- the existing issue example `--skills coder=grove,review` remains valid

This keeps shell quoting manageable and error reporting precise.

### CLI Parsing

Add a small parser in the CLI layer that turns raw flag values into a shared
core DTO such as:

```ts
export type SkillOverrideOp = "replace" | "add" | "remove";

export interface SessionSkillOverrideClause {
  readonly target: "*" | string;
  readonly op: SkillOverrideOp;
  readonly skills: readonly string[];
}
```

Parser responsibilities:

- recognize `=`, `+=`, and `-=`
- trim surrounding whitespace
- split skills on commas
- reject empty role selectors
- reject malformed clauses such as `coder`, `coder+foo`, `=grove`, or `*=,`

Application responsibilities belong in shared core code, not in the parser.

### CLI Flow

`sessionStart()` in
[src/cli/commands/session.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/cli/commands/session.ts:71)
changes only at the topology handoff point:

1. Parse `values.skills` into `SessionSkillOverrideClause[]`.
2. Resolve the base topology using existing logic.
3. Apply the shared override helper to produce an edited topology.
4. Store and launch the session with that edited topology.

No `Session`, `SessionStore`, or HTTP schema changes are required for the CLI
path because the effective topology is already what gets stored.

## TUI Design

The launch preview screen in
[src/tui/screens/agent-detect.tsx](/Users/tafeng/.codex/worktrees/991b/grove/src/tui/screens/agent-detect.tsx:1)
already edits two session-local role properties:

- prompt text
- edge reply deadlines

Session-scoped skill overrides fit the same pattern.

### TUI Editing Model

The TUI edits effective per-role skill lists directly rather than exposing raw
clause syntax. Operators should see the final list each role will launch with.

Capabilities:

- edit the selected role's skills
- clear the selected role's skills
- apply the selected role's current skills to all roles

The last action gives the TUI a blanket-override equivalent without forcing the
operator to learn CLI syntax.

### TUI Data Flow

Extend the existing `AgentDetect.onContinue(...)` handoff with a role-skills
payload, for example:

```ts
readonly roleSkills: ReadonlyMap<string, readonly string[]>;
```

Then extend the cloned per-launch topology path in
[src/tui/screens/screen-manager.tsx](/Users/tafeng/.codex/worktrees/991b/grove/src/tui/screens/screen-manager.tsx:624):

1. clone the current topology
2. apply edited edge deadlines
3. apply edited role skills
4. persist that edited topology via `provider.createSession(...)`
5. pass the same edited topology into `spawnManager`

Role prompts stay on their existing spawn-only path through `rolePromptsRef`.
This issue only changes what is persisted into `role.skills`.

This keeps remote and local TUI modes aligned because both already round-trip
the topology through `createSessionHttp()` in
[src/tui/provider-shared.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/tui/provider-shared.ts:329).

## Shared Core Helper

Add a new core module, for example:

```text
src/core/session-skill-overrides.ts
```

Recommended surface:

```ts
export type SkillOverrideOp = "replace" | "add" | "remove";

export interface SessionSkillOverrideClause {
  readonly target: "*" | string;
  readonly op: SkillOverrideOp;
  readonly skills: readonly string[];
}

export function applySessionSkillOverrides(
  topology: AgentTopology,
  clauses: readonly SessionSkillOverrideClause[],
): AgentTopology;
```

Behavior:

- returns a cloned topology
- never mutates the input topology or nested `roles`
- validates that per-role targets exist
- normalizes resulting `role.skills`
- preserves all non-skill topology fields unchanged

This module owns the precedence and list-manipulation rules so CLI and TUI
cannot drift.

## Session and Server Implications

No new persistent session fields are needed. The existing `topology` and
`config.topology` snapshot remain the single source of truth.

No new `POST /api/sessions` request field is required either:

- CLI performs the override locally, then stores the edited topology.
- TUI already sends an inline edited topology when it has session-local changes.

The existing server behavior that inline topology overrides preset topology in
[tests/server/goals-sessions.test.ts](/Users/tafeng/.codex/worktrees/991b/grove/tests/server/goals-sessions.test.ts:590)
already matches this design.

## Error Handling

### Early validation

Reject before session creation when:

- the `--skills` clause syntax is malformed
- a per-role target does not exist in the resolved topology
- no topology is available at all under the existing resolution rules

These failures should surface as the same `VALIDATION_ERROR` style currently
used for bad CLI/session inputs.

### Deferred validation

Do not add CLI/TUI/server-side catalog existence checks. Unknown or missing
skill directories still fail in bootstrap through the existing injector path.

This is intentional because:

- the authoritative catalog may differ between environments
- remote TUI mode should not duplicate server/bootstrap validation logic
- the existing bootstrap failure path already stops an invalid session launch

### No-op behavior

- removing a skill that is not present is a no-op
- adding a skill already present is a no-op after dedupe
- `*=` or `coder=` clears the target list
- `coder+=` or `coder-=` is treated as invalid syntax rather than an ambiguous
  no-op

## Testing

### Core unit tests

Add `src/core/session-skill-overrides.test.ts` covering:

- replace, add, remove against roles with and without initial skills
- blanket then per-role precedence
- input immutability
- dedupe and ordering behavior
- clear behavior with empty replace
- unknown role rejection

### CLI tests

Extend `src/cli/commands/session.test.ts` and/or CLI integration tests to cover:

- valid repeated `--skills` parsing
- malformed clause errors
- `session start` storing the expected overridden topology
- precedence with preset-derived roles

### TUI tests

Extend TUI tests around launch preview and screen manager flow to cover:

- launch preview initializes from `role.skills`
- edited per-role skills are reflected in the cloned session topology
- apply-to-all behavior updates every role
- the topology sent to `createSession()` and `spawnManager` contains the final
  skill lists

### Bootstrap regression coverage

Existing skill injection tests remain the end-to-end proof that final
`role.skills` still bootstrap correctly. Add a small extension where helpful to
show that an overridden topology launches with the edited skill set rather than
the preset default.

## Documentation

Update user-facing CLI help text in
[src/cli/commands/session.ts](/Users/tafeng/.codex/worktrees/991b/grove/src/cli/commands/session.ts:64)
to describe `--skills`.

Add at least one short usage example to the relevant session-start docs or help
surface so the blanket vs per-role model is discoverable.

## Open Questions

None remaining for this issue scope. The design deliberately chooses:

- effective-topology persistence over separate override metadata
- repeated `--skills` flags over a semicolon mini-language
- TUI direct editing over exposing raw clause syntax
