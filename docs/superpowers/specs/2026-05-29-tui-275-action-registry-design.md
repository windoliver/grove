# Unified Action Registry (#275)

**Status:** Approved design — ready for implementation plan
**Issue:** https://github.com/windoliver/grove/issues/275
**Date:** 2026-05-29

## Problem

Keybinds, palette entries, and slash commands are wired independently. Adding a
user-invocable action means touching multiple places, discoverability is uneven,
and there is no uniform way to say "this action is disabled in this context with
this reason."

#194 (merged, PR #461) already unified the **command palette** behind a single
`Action` model (`src/tui/actions/types.ts`), and #186 (merged) added a leader-key
keymap with `.grove/keybindings.json` overrides (`src/tui/keymap/keymap.ts`). But:

- The **keybinding resolver still dispatches through a parallel 50-case
  `executeKeymapAction` switch** keyed on `TuiActionId` — it does not go through
  `Action.run`. Remapping a key does not update palette help, and keybinds are
  effectively a second action system.
- There is **no persistent registry API** (`register/list/byId/search`); actions
  are rebuilt every render via `buildBuiltInActions(ctx)`, so nothing can resolve
  an action by id (the keymap can't look one up).
- **Slash commands do not exist.**
- **MCP-exposed prompts and skills are not surfaced as actions** (Grove's MCP
  server exposes tools only; skills have no enumeration API).

#275 makes one registry the single input to the palette, slash surfaces, and the
leader-chord resolver, with MCP prompts and skills plugged in as additional
sources.

## Goals (acceptance criteria)

- A single `ActionRegistry` is the only input to: command palette, slash
  surfaces, and the keyboard leader-chord resolver.
- The keybinding resolver dispatches through `Action.run` via `registry.byId`;
  the `executeKeymapAction` switch is removed.
- Remapping a key in `keybindings.json` updates both dispatch and the palette
  keybind column (single binding source of truth = the keymap).
- Disabled actions render greyed with a `reason` in the palette footer.
- Slash commands work via two surfaces: `/` opens the palette pre-filtered to
  slash-bearing actions, and a dedicated command-line input parses `/<cmd> args`.
- A 2-second leader-chord modal window: after the leader key, focus blurs, the
  follow-up key is captured, and a pending-chord overlay lists candidate
  continuations.
- MCP-exposed prompts (defined by Grove's own MCP server) appear as actions.
- Skills appear as actions, scoped to the selected agent slot's role skill set.

## Decisions (locked during brainstorming)

1. **Delivery:** one cohesive design + one implementation plan delivered as a
   single (large) PR. The plan **sequences work internally** P1 backbone → P2
   slash → P3 prompts → P4 skills so each phase is independently testable.
   (Acknowledged risk: ~20 files across TUI + MCP server + core; big-bang is the
   hardest to review — mitigated by the internal phase sequencing and TDD.)
2. **Registry architecture (Approach A):** a persistent registry of **static
   action descriptors** plus registered **dynamic sources** (`(ctx) => Action[]`
   generators) for per-entity actions. `list/byId/search` expand sources at call
   time. MCP prompts and skills are additional dynamic sources. This is the only
   model where palette, slash, keybind, prompts, and skills all flow through one
   registry.
3. **Binding source of truth:** the keymap file (`keymap.ts` defaults +
   `.grove/keybindings.json` overrides) remains authoritative for keybinds. The
   registry's `keybind` field is **filled from the resolved keymap**, never
   authored on the descriptor.
4. **Leader key stays `space`** (the #186 default), configurable via
   `keybindings.json`. The issue's suggested `ctrl+x` is **not** adopted — it
   would break shipped muscle memory.
5. **MCP prompts source:** Grove's own MCP server defines named prompts from the
   repo `prompts/` directory (self-contained; no generic external MCP client).
6. **Skills source:** bundled `skills/grove/*` + topology-declared role skills,
   enumerated via a new provider method. "Scoped to slot" = gated/ordered by the
   selected agent slot's role skill set; invoked via existing
   `grove_request_skill`.
7. **Slash surfaces:** both — `/` filtered palette (discovery / no-arg) and a
   dedicated command-line input (power / args).

## Out of scope (YAGNI)

- Redesigning inline docks for agent-originated interactions (#193 — already
  merged). We register the permission/question/todo/followup/revert actions so
  docks *can* consume the registry, but do not change dock UI here.
- A generic MCP client that enumerates prompts from arbitrary external servers
  (decision 5 keeps it to Grove's own server).
- Nexus skill-catalog enumeration (decision 6 keeps it to bundled + topology).
- Plugin distribution mechanism (#189).
- Redesigning the DAG view.

---

## Architecture

### 1. Action model extensions — `src/tui/actions/types.ts`

Keep #194's existing fields (`id`, `label`, `detail`, `group`, `keywords`,
`available`, `enabled`, `run`) to avoid churn. **Add:**

```ts
export interface Action {
  // ... existing #194 fields unchanged ...
  /** Slash trigger, e.g. "/cancel". Source of truth for the slash surfaces. */
  readonly slash?: string | undefined;
  /** Palette shows suggested actions first when the filter is empty. */
  readonly suggested?: boolean | undefined;
  /**
   * Filled by the registry from the resolved keymap — NOT authored here.
   * The registry annotates each Action returned from list()/byId()/search().
   */
  readonly keybind?: string | undefined;
  /**
   * Capability gate. Extended from #194's boolean to optionally carry a reason
   * shown in the palette footer when greyed. Boolean returns remain valid.
   */
  readonly enabled?:
    | ((ctx: ActionContext) => boolean | { enabled: boolean; reason?: string })
    | undefined;
  /** May now receive parsed slash args (Surface 2). Optional, back-compat. */
  readonly run: (ctx: ActionContext, args?: readonly string[]) => void | Promise<void>;
}

export type ActionGroup =
  | "Navigation" | "Agents" | "Workflow" | "View"
  | "Contributions" | "Prompts" | "Skills" | "Plugins";
```

`GROUP_ORDER` gains `"Prompts"` and `"Skills"` (before `"Plugins"`). A
`resolveEnabled(action, ctx): { enabled: boolean; reason?: string }` helper
normalizes the boolean | object union for callers (palette + keybind dispatch).

`available` (hidden) vs `enabled` (greyed) distinction from #194 is preserved.

### 2. Registry — `src/tui/actions/registry.ts` (new)

```ts
export type DynamicSource = (ctx: ActionContext) => readonly Action[];

export interface ActionRegistry {
  register(action: Action): void;
  registerDynamic(idPrefix: string, source: DynamicSource): void;
  /** id → keybind string, from the resolved keymap (+ overrides). */
  setBindings(bindings: ReadonlyMap<string, string>): void;
  /** available-filtered; suggested-first then GROUP_ORDER; keybind/slash merged. */
  list(ctx: ActionContext): readonly Action[];
  byId(id: string, ctx: ActionContext): Action | undefined;
  /** fuzzy (reuse fuzzyMatch) over list(); matches label + keywords + slash. */
  search(query: string, ctx: ActionContext): readonly Action[];
}

export function createActionRegistry(): ActionRegistry;
```

- **Pure, no React.** Constructed once at app root (a `useMemo` with empty deps,
  or a module-level factory invoked once).
- **Static actions** registered via `register`. **Per-entity actions**
  (`spawn:<role>`, `kill:<session>`, `jump:<session>`, `delegate:<peer>`) are
  registered as **dynamic sources** wrapping today's builder logic from
  `builtin-actions.ts`. The registry object is therefore stable across renders;
  expansion happens at `list/search/byId` time from live `ctx`.
- **`byId`:** exact match for static actions; for dynamic ids, match the
  registered `idPrefix` then locate the entry within `source(ctx)`.
- **Keybind/slash merge:** `list/byId/search` annotate each returned Action with
  `keybind` from the `setBindings` map (`slash` already lives on the descriptor).
- **Ordering:** when listed with no query, `suggested:true` first, then by
  `GROUP_ORDER`, then declaration order; with a query, fuzzy rank (flat).

### 3. Keybind → Action bridge — `keymap.ts`, `use-keyboard-handler.ts`

Today a `KeyBinding` carries `action: TuiActionId` and is dispatched through the
`executeKeymapAction` switch (~50 cases). Change:

- A binding's `action` field becomes the registry **action id** (a string). A
  one-time **migration table** maps each existing `TuiActionId` → its action id
  (most map 1:1 to existing built-in action ids; panel-target bindings map to
  `nav.focus.<panel>` ids).
- `keymap.ts` exports `resolvedKeymapBindings(resolved): ReadonlyMap<id, keybind>`
  (id → human keybind string) used to feed `registry.setBindings`.
- Dispatch in `use-keyboard-handler.ts` collapses to:

  ```ts
  const action = registry.byId(binding.action, ctx);
  if (!action) return; // unknown id (e.g. stale override) — no-op
  const { enabled } = resolveEnabled(action, ctx);
  if (!enabled) return;
  void Promise.resolve(action.run(ctx)).catch(showError);
  ```

- **`executeKeymapAction` is deleted.** Effect parity is asserted by tests (each
  old `TuiActionId` → action id runs the same observable effect).
- Because `setBindings` is fed from the resolved keymap (including overrides),
  remapping a key updates both dispatch and the palette keybind column from the
  one source.

### 4. Leader-chord modal — `use-keyboard-handler.ts` + overlay

Leader stays `space`. Today only a pending prefix (`keymapPrefix`) is tracked and
`resolveKeyBinding` returns `pending`. Add:

- **2-second window:** a timer armed whenever the prefix is non-empty, reset on
  each follow-up key, expiry clears the prefix (chord cancelled). The timer lives
  in app state / a ref; clears on resolve or `Esc`.
- **Focus blur / capture:** while a chord is pending, `routeKey` intercepts *all*
  keys to the resolver before any focused-panel input handler runs.
- **Pending-chord overlay** — `src/tui/components/leader-overlay.tsx` (new) or a
  status-bar extension: shows the current prefix and candidate continuations,
  derived from bindings whose `sequence` starts with the prefix, each labelled
  from its action (`space → p: palette · t: terminal · ? : help`). Doubles as
  discoverability. Reuses the resolved keymap, so it reflects overrides.

### 5. Slash surfaces — `command-palette.tsx`, `slash-input.tsx` (new)

`slash` on descriptors is the source of truth. A registry-derived **slash index**
(`slash string → action id`) backs resolution.

- **Surface 1 — `/` opens palette pre-filtered:** pressing `/` in Normal mode
  opens the palette in "slash mode" — only actions with a `slash` are shown, and
  the query is seeded after the `/`. Reuses all palette machinery (grouping,
  fuzzy, flat index, Enter-to-run).
- **Surface 2 — command-line input:** a new `InputMode.SlashCommand` renders a
  bottom input line. It parses `/<cmd> <args…>`, resolves `cmd` via the slash
  index, and calls `action.run(ctx, args)`. This is why `run` gained the optional
  `args` param. Arg-bearing actions (e.g. `/spawn reviewer`) read `args`; others
  ignore it. Unknown `/cmd` → footer error; the input stays open for correction.

### 6. MCP-prompt backend — `src/mcp/server.ts`, `src/mcp/prompts.ts` (new), provider

- **Grove MCP server** gains `prompts: {}` capability and registers prompts from
  the repo `prompts/` directory: `src/mcp/prompts.ts` loads each file as a named
  prompt (`name` = file stem, content = template), and `server.registerPrompt`
  wires standard `prompts/list` + `prompts/get`.
- **Provider:** additive `TuiPromptProvider { listMcpPrompts(): Promise<readonly
  PromptInfo[]> }` + `capabilities.prompts`. `NexusDataProvider` implements it
  against the Grove MCP server; `LocalDataProvider` reads `prompts/` directly.
  `PromptInfo = { name; description?; arguments?: readonly PromptArg[] }`.
- **ActionContext** gains `mcpPrompts?: readonly PromptInfo[]` (fetched while the
  palette/slash surface is open, mirroring the `pendingQuestionCount` fetcher
  pattern) and a capability `runPrompt(name, session, args?)`.
- **Dynamic source `prompt.*`** → group `"Prompts"`; `id` = `prompt.<name>`;
  `slash` = `/prompt:<name>` (optional); `available` when a session is selected;
  `run(ctx, args)` = render the template (with args) and deliver it to the
  selected agent through `runPrompt`, which routes via the provider's existing
  agent-message path (ACP / Nexus IPC) — **never** tmux send-keys.
- **Honest scope:** "invoking a prompt" = stage/send the template to the selected
  agent. Parameterized prompts take their arguments via Surface 2.

### 7. Skill backend — provider, `core/runtime-skill-acquisition.ts`

- **Provider:** additive `TuiSkillProvider { listAvailableSkills(): Promise<readonly
  SkillInfo[]> }` + `capabilities.skills`. Enumerates bundled `skills/grove/*`
  plus skills referenced across topology roles. `SkillInfo = { name; description?;
  roles?: readonly string[] }`.
- **Core:** `runtime-skill-acquisition.ts` gains a `listAvailableSkills()` that
  enumerates bundled + known skills (the inverse of the existing
  `requestSkill(name)` resolve path).
- **ActionContext** gains `availableSkills?: readonly SkillInfo[]`,
  `selectedAgentRole?` (derived from `selectedSession` → topology role), and a
  capability `requestSkill(name, session)` (calls `grove_request_skill`).
- **Dynamic source `skill.request.*`** → group `"Skills"`; `id` =
  `skill.request.<name>`; `slash` = `/skill <name>` (resolved via Surface 2);
  **scoped to slot** = `available`/ordering gated to the selected agent slot's
  role skill set; `run` = `requestSkill(name, selectedSession)`.

### 8. Inline docks (#193) — light touch

Register the agent-interaction actions (permission / question / todo / followup /
revert) in the registry so docks can consume the same source, but do **not**
redesign dock UI here. Deferred to a #193 follow-up.

### 9. Wiring — `src/tui/app.tsx`

- Build the registry once at root. Register: static actions (from refactored
  `builtin-actions.ts`), dynamic per-entity sources, the plugin adapter source
  (existing), and the prompt + skill sources.
- Call `registry.setBindings(resolvedKeymapBindings(resolvedKeymap))`; refresh
  when overrides change (existing `useKeybindingOverrides` hook).
- Palette consumes `registry.list(ctx)` / `registry.search(query, ctx)` instead
  of the `buildBuiltInActions(...)` + plugin concat (that concat logic moves into
  registration).
- Keymap dispatch routes through `registry.byId` + `run` (section 3).
- Add `InputMode.SlashCommand` and the `/` handlers (section 5).

## Data flow

```
keymap.ts defaults + .grove/keybindings.json
        │  resolveKeymap(+overrides)
        ▼
resolvedKeymapBindings (id → keybind) ──► registry.setBindings
                                                │
static actions ──► register ───────────────────┤
per-entity builders ──► registerDynamic ───────┤
plugin adapter ──► registerDynamic ────────────┤
prompt source (provider.listMcpPrompts) ───────┤
skill source (provider.listAvailableSkills) ───┤
                                                ▼
                                        ActionRegistry
                          ┌────────────────┼─────────────────┐
                   list/search          byId(id,ctx)     slash index
                          │                 │                 │
                       Palette        Keymap dispatch    Slash input
                    (+ keybind col,   (run after        (/cmd args →
                     reason footer)    enabled check)     run(ctx,args))
```

## Error handling

- `run` is awaited via `Promise.resolve(...).catch(showError)` — failures surface
  in the status bar (existing 5s auto-clear channel).
- Disabled actions (`enabled` → false) never execute; the `reason` shows in the
  palette footer. Unavailable actions are absent from the index space, so
  selection cannot land on them.
- Unknown `/cmd` (Surface 2) → footer error, input stays open. Stale keymap
  override pointing at an unknown id → `byId` returns undefined → no-op.
- Leader-chord timeout → silent prefix reset. `Esc` cancels a pending chord.
- Missing provider capability (`prompts`/`skills`) → the corresponding dynamic
  source yields `[]` (graceful degradation; no error).

## Testing

Targeted TDD runs with a temp `bunfig.toml` (`coverage = false`) per the repo
convention; full-suite/typecheck/check use the repo config.

- **`registry.test.ts`** — register/list/byId/search; dynamic-source expansion;
  `available` filtering; suggested-first + `GROUP_ORDER` sort; keybind/slash
  merge from `setBindings`; dynamic `byId`-by-prefix; `resolveEnabled` union.
- **Keybind bridge** — each migrated `TuiActionId` → action id runs the same
  observable effect (parity); remap via overrides reflects in `list().keybind`;
  unknown id → no-op.
- **Leader modal** — pending prefix capture; 2s timer reset/expiry; candidate
  continuation list derived from bindings; `Esc` cancel; focus capture (panel
  input does not see keys while pending).
- **Slash** — `/` filters palette to slash-bearing actions; command-line parse
  `/cmd a b` → resolve + `run(ctx,["a","b"])`; unknown cmd → footer error.
- **MCP prompts** — `src/mcp/prompts.ts` loads `prompts/` into named prompts;
  server `prompts/list` returns them; provider `listMcpPrompts`; `prompt.*`
  source produces actions, gated on selected session.
- **Skills** — `listAvailableSkills` enumerates bundled + topology; `skill.request.*`
  source `available` gated to selected role (scoped to slot); `run` →
  `requestSkill`.
- **Migration** — update existing palette/keymap tests that reference the old
  concat path / `executeKeymapAction`.

## File summary

| File | Change |
|---|---|
| `src/tui/actions/types.ts` | extend `Action` (`slash`, `suggested`, `keybind`, `enabled` reason union, `run` args); add `Prompts`/`Skills` groups; `resolveEnabled` helper |
| `src/tui/actions/registry.ts` | **new** — `createActionRegistry` (register/registerDynamic/setBindings/list/byId/search) |
| `src/tui/actions/registry.test.ts` | **new** |
| `src/tui/actions/builtin-actions.ts` | refactor builders into static actions + dynamic sources |
| `src/tui/actions/dynamic-sources.ts` | **new** — per-entity + prompt + skill sources (+ tests) |
| `src/tui/keymap/keymap.ts` | binding `action` = registry id; export `resolvedKeymapBindings`; migration table |
| `src/tui/hooks/use-keyboard-handler.ts` | retire `executeKeymapAction`; dispatch via `registry.byId` + `run`; leader 2s modal + focus capture |
| `src/tui/components/command-palette.tsx` | keybind column; disabled `reason` footer; suggested-first; slash mode |
| `src/tui/components/slash-input.tsx` | **new** — `InputMode.SlashCommand` command-line |
| `src/tui/components/leader-overlay.tsx` | **new** — pending-chord overlay |
| `src/tui/provider.ts` | add `TuiPromptProvider`, `TuiSkillProvider`; `capabilities.prompts`/`.skills` |
| `src/tui/nexus-provider.ts` (+ local provider) | implement `listMcpPrompts` / `listAvailableSkills` |
| `src/mcp/server.ts` | `prompts: {}` capability + register prompts from `prompts/` |
| `src/mcp/prompts.ts` | **new** — prompt loader from `prompts/` dir |
| `src/core/runtime-skill-acquisition.ts` | add `listAvailableSkills()` |
| `src/tui/app.tsx` | build/wire registry; `setBindings`; slash modes |
| tests | new registry/source/slash/leader/mcp/skill tests; migrate palette/keymap tests |

## Implementation phasing (within the single PR)

1. **P1 — Backbone:** types extensions, `registry.ts`, refactor `builtin-actions`
   into static + dynamic sources, keybind→Action bridge (delete
   `executeKeymapAction`), leader 2s modal + overlay, palette keybind column +
   reason footer. Fully testable without new backends.
2. **P2 — Slash:** `slash` field wiring, slash index, `/` filtered palette,
   `slash-input.tsx` command-line, `run(ctx,args)`.
3. **P3 — MCP prompts:** server `prompts` capability + `mcp/prompts.ts`, provider
   `listMcpPrompts`, `prompt.*` source.
4. **P4 — Skills:** provider `listAvailableSkills`, core enumeration,
   `skill.request.*` source scoped to slot.
