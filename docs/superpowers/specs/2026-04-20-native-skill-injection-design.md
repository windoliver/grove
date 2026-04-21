# Native Skill Injection — Design

- **Date:** 2026-04-20
- **Issue:** [#262](https://github.com/windoliver/grove/issues/262) (sub-spec 2 of [#202](https://github.com/windoliver/grove/issues/202))
- **Status:** Draft for review

## Summary

Grove currently installs a single hardcoded `SKILL.md` into `~/.claude/skills/grove/` and `~/.codex/skills/grove/` via `grove skill install`. Installation is global and per-machine; every agent on the machine sees the same one skill. Per-task customization is not possible.

This spec adds **per-task native skill injection** from a local catalog: each agent's workspace receives the subset of skills declared on its topology role, written to provider-native paths under the workspace.

## Goals

- Different topology roles receive different skill subsets without reinstall.
- Skills live in a named, directory-shaped catalog rather than a rendered template.
- Injection is bootstrap-time, static for the session's lifetime.
- Users can override bundled skills per workspace without forking grove.
- No new runtime service; no Nexus coupling.

## Non-goals

- Hot-reload of skills mid-session.
- Nexus-hosted skill distribution across machines (deferred to a future sub-spec).
- Agent-driven dynamic skill acquisition at runtime.
- Replacing `grove skill install` for users working outside grove sessions.

## Background

### Current state

- `src/cli/commands/skill.ts` — `grove skill install` writes one rendered `SKILL.md` into `~/.claude/skills/grove/` and `~/.codex/skills/grove/` at install time.
- `src/cli/commands/skill-template.ts` — `renderSkillTemplate({serverUrl, mcpUrl})` produces the file content in memory.
- `src/core/workspace-bootstrap.ts` — writes `.mcp.json`, `.acpxrc.json`, `CLAUDE.md`, `CODEX.md` into each per-task workspace. Sets files read-only (`0o444`). Called by both `SpawnManager` (TUI) and `SessionOrchestrator` (headless).
- `src/core/topology.ts` — `AgentRole` carries `prompt`, `goal`, `platform`, `model`, etc. No skill field today.

### Gap

The install-time, global, single-file model does not support:
- Per-task skill sets (coder vs. reviewer vs. planner with distinct tool vocabularies).
- A growing catalog of multiple skills.
- Skills with sibling assets (scripts, reference docs).
- Workspace-local skill overrides.

## Design

### Architecture

One new module, `src/core/skill-injector.ts`. Pure function called from `bootstrapWorkspace`:

```
(workspacePath, skills, bundledSkillsRoot, workspaceOverrideRoot?)
  → recursive copy of each resolved skill dir
  → into {workspacePath}/.claude/skills/{name}/
  → and  {workspacePath}/.codex/skills/{name}/
```

Two source layers, consulted by name:
1. **Workspace override** — `{workspacePath}/../.grove/skills/{name}/` (sibling to the workspace, inside the user's `.grove` dir). First win.
2. **Bundled catalog** — `{groveRoot}/skills/{name}/`. Ships in the grove repo.

Two write targets, always both (so switching `platform` on a role needs no re-bootstrap).

### Catalog shape

Each skill is a directory:

```
skills/
  grove/
    SKILL.md              # required
    <optional siblings>   # scripts, reference docs, etc. copied verbatim
```

`SKILL.md` is a plain Markdown file with frontmatter (the format Claude Code and Codex already consume). No templating: runtime values like the Nexus URL are delivered via `.mcp.json` env (`GROVE_NEXUS_URL`), which agents read independently.

### Role → skill wiring

`AgentRole` gains an optional list:

```ts
interface AgentRole {
  // ... existing fields
  readonly skills?: readonly string[] | undefined;
}
```

Wire form (snake_case YAML): `skills: [grove, review]`.

`bootstrapWorkspace` receives the resolved role and passes `role.skills` to the injector.

### Components

**`src/core/skill-injector.ts`** (new)

```ts
export interface SkillInjectionOptions {
  workspacePath: string;
  skills: readonly string[];
  bundledSkillsRoot: string;
  workspaceOverrideRoot?: string;
}

export interface InjectionReport {
  injected: ReadonlyArray<{
    name: string;
    source: "override" | "bundled";
    sourcePath: string;
    targets: readonly string[];
  }>;
}

export async function injectSkills(opts: SkillInjectionOptions): Promise<InjectionReport>;

export class SkillResolutionError extends Error {
  readonly skillName: string;
  readonly searchedPaths: readonly string[];
}
```

**`src/core/topology.ts`** — add `skills?: readonly string[]` to `AgentRole` and the snake_case wire schema; pass through in `wireToTopology`.

**`src/core/workspace-bootstrap.ts`** — extend `BootstrapOptions`:

```ts
interface BootstrapOptions {
  // ... existing fields
  skills?: readonly string[] | undefined;
  bundledSkillsRoot?: string | undefined;
  workspaceOverrideRoot?: string | undefined;
}
```

When `skills` is non-empty, call `injectSkills` after the existing config/instruction writes and before `chmod`. Fold the injector's written files into the read-only pass.

Resolution responsibility mirrors the existing `mcpServePath` field: callers (`SpawnManager`, `SessionOrchestrator`) compute absolute paths and pass them in. `bundledSkillsRoot` resolves to the grove install's `skills/` directory; `workspaceOverrideRoot` resolves to `{groveDir}/skills/` (omitted when the caller does not want override lookup). If `skills` is non-empty but `bundledSkillsRoot` is missing, bootstrap throws — the config is incoherent.

Injector behavior: when `workspaceOverrideRoot` is absent or the override dir does not exist, skip the override layer and resolve against `bundledSkillsRoot` only.

**`src/cli/commands/skill.ts`** — refactor `handleSkillInstall` to load `SKILL.md` from the on-disk catalog (`{groveRoot}/skills/grove/SKILL.md`) instead of `renderSkillTemplate`. Preserves the existing CLI contract; ensures the catalog and the install path cannot drift.

**`src/cli/commands/skill-template.ts`** — removed. The template's runtime-var interpolation is no longer needed; MCP config handles URL delivery.

**Bundled catalog** — new top-level `skills/` directory:

```
skills/
  grove/
    SKILL.md    # seeded from the current renderSkillTemplate output (URLs dropped)
```

Repo-root placement matches how other projects lay out Claude Code skills and keeps the catalog as data, not source.

### Data flow

1. `workspace-provisioner` creates a per-task workspace directory.
2. Caller (TUI `SpawnManager` or headless `SessionOrchestrator`) invokes `bootstrapWorkspace` with the role, including `role.skills`.
3. `bootstrapWorkspace` writes `.mcp.json`, `.acpxrc.json`, `CLAUDE.md`, `CODEX.md` as today.
4. If `role.skills` is non-empty, `injectSkills` runs:
   - Resolve each name against override, then bundled root. Collect errors.
   - If any error, throw — no writes.
   - Otherwise recursive-copy each resolved dir to `{workspacePath}/.claude/skills/{name}/` and `{workspacePath}/.codex/skills/{name}/`.
5. `bootstrapWorkspace` `chmod`s all injected files to `0o444` in the same loop that protects existing config files.
6. `AcpxRuntime.spawn()` runs acpx with `cwd: workspacePath`; the agent provider (claude, codex) discovers skills from the workspace-local paths natively.

### Error handling

| Condition | Behavior |
|---|---|
| Unknown skill name | `SkillResolutionError` thrown before any write. Includes `{ name, searchedPaths }`. Bootstrap surfaces it; session setup fails cleanly. |
| Skill dir missing `SKILL.md` | Same error class; treated as malformed. |
| Name appears in both override and bundled | Override wins. Debug-level log entry; no warning. |
| Target dir already exists (workspace reuse, reattach) | Overwrite. Skills are derived state. |
| Copy fails mid-flight (disk full, perms) | Propagate native fs error; bootstrap fails. |
| `skills: []` or field omitted | No-op. No `.claude/skills` / `.codex/skills` dirs created. |

### `grove skill install` disposition

Kept. Refactored to read the same on-disk catalog rather than render an in-memory template. Intended for humans working in a directory that is not a grove-provisioned workspace (e.g., direct `claude` invocation in a personal repo). The template file (`skill-template.ts`) and its tests are removed; install-time tests now exercise the on-disk catalog path.

### Testing

- **`src/core/skill-injector.test.ts`** (new, unit):
  - single bundled skill → both `.claude/skills/{name}` and `.codex/skills/{name}` written with expected contents and `0o444`.
  - workspace override with same name wins (override content lands, bundled does not).
  - unknown skill name → throws `SkillResolutionError`, no files written (scan the target dirs to assert absence).
  - dir-shaped skill with sibling assets → every file copied; sibling paths preserved under each target.
  - empty `skills` list → no target dirs created, no errors.
- **`src/core/workspace-bootstrap.test.ts`** (extend):
  - role with `skills: ["grove"]` produces native paths.
  - role without `skills` leaves native paths absent.
  - injector failure bubbles up as bootstrap failure.
- **`src/core/topology.test.ts`** (extend):
  - wire `skills: [...]` parses into `AgentRole.skills`.
  - strict schema still rejects typos.
- **`src/core/acpx-runtime.integration.test.ts`** (extend):
  - topology with `skills: ["grove"]` → spawned claude agent finds `.claude/skills/grove/SKILL.md` at `cwd`; mirror for codex.
- **`src/cli/commands/skill.test.ts`** (update):
  - `handleSkillInstall` reads from the on-disk catalog; install output is byte-equal to the bundled `SKILL.md` plus any transformations the install path applies (currently none).

### Out of scope

- Multi-machine skill distribution (Nexus-hosted).
- Session-level override flags (e.g., `grove session create --skills ...`).
- Runtime skill acquisition.
- Skill content templating.
- Skill versioning / pinning.

These may become future sub-specs if demand arrives; the design intentionally leaves room by keeping skills name-addressed and dir-shaped.

## Migration

One release step: after merge, existing installs continue to work — the `grove skill install` path still writes to `~/.claude/skills/grove/`. No users are forced to opt in; topologies without a `skills` field behave identically to today.

Agents spawned via grove no longer rely on the global install for the grove skill — bootstrap injects it locally when the role declares `skills: [grove]`. Topologies that don't declare skills receive no skills (same as today's default if a user never ran `grove skill install`).

## Open questions

None remaining from brainstorm.
