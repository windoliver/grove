# Unified Action Registry (#275) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a single persistent `ActionRegistry` the only input to the TUI command palette, slash surfaces, and the keyboard leader-chord resolver, with MCP prompts and skills plugged in as additional sources.

**Architecture:** Approach A — a persistent registry holds static `Action` descriptors plus registered dynamic sources (`(ctx) => Action[]`). `list/byId/search` expand the sources from live `ActionContext` at call time. Keybinds are merged in from the resolved keymap (keymap file stays the binding source of truth). The keymap resolver dispatches through `registry.byId(...).run(ctx)`, retiring the `executeKeymapAction` switch. Slash and MCP-prompt/skill sources are additive layers on the same registry.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, React 19 / OpenTUI, `bun:test`, Biome. MCP via `@modelcontextprotocol/sdk` (`McpServer`).

**Spec:** `docs/superpowers/specs/2026-05-29-tui-275-action-registry-design.md`

---

## Execution Notes

This repo's `bunfig.toml` enables coverage thresholds globally. For the targeted
TDD commands in this plan, run the listed files with a temporary config that
disables coverage. Wherever a step says **[focused-test] `<files>`**, run:

```bash
tmpdir=$(mktemp -d /tmp/grove-bunfig.XXXXXX)
tmp="$tmpdir/bunfig.toml"
printf '[test]\ncoverage = false\n' > "$tmp"
PATH="$HOME/.bun/bin:$PATH" bun --config="$tmp" test <files>
rc=$?
rm -rf "$tmpdir"
exit $rc
```

For `bun run typecheck`, `bun run check`, and full-suite commands, use the
repository config as written. Run `bun run check` (Biome) before each commit.

## Phasing

The plan is one document delivered as one PR, sequenced into 4 internally
independent phases. Each phase ends green and is independently testable:

- **Phase 1 — Backbone** (Tasks 1–8): registry, dynamic-source refactor,
  keybind→Action bridge, leader modal, palette cheatsheet + reason footer.
- **Phase 2 — Slash** (Tasks 9–11): `slash` wiring, `/` filtered palette,
  command-line input.
- **Phase 3 — MCP prompts** (Tasks 12–14): Grove server prompts, provider,
  `prompt.*` source.
- **Phase 4 — Skills** (Tasks 15–17): skill enumeration, provider, slot-scoped
  `skill.request.*` source.

## File Structure

| File | Responsibility |
|---|---|
| `src/tui/actions/types.ts` | `Action`/`ActionContext`/`ActionGroup` + `resolveEnabled` |
| `src/tui/actions/registry.ts` | **new** — `createActionRegistry` |
| `src/tui/actions/dynamic-sources.ts` | **new** — per-entity + prompt + skill dynamic sources |
| `src/tui/actions/builtin-actions.ts` | static actions (per-entity logic moves out) |
| `src/tui/actions/register-builtins.ts` | **new** — populate a registry from built-ins + sources |
| `src/tui/actions/visibility.ts` | suggested-first ordering |
| `src/tui/keymap/keymap-action-map.ts` | **new** — binding→registry-id map + `resolvedKeymapBindings` |
| `src/tui/hooks/use-keyboard-handler.ts` | dispatch via registry; leader 2s modal + capture |
| `src/tui/components/command-palette.tsx` | keybind column, reason footer |
| `src/tui/components/leader-overlay.tsx` | **new** — pending-chord overlay |
| `src/tui/components/slash-input.tsx` | **new** — `/cmd args` command-line |
| `src/tui/provider.ts` | `TuiPromptProvider`, `TuiSkillProvider`, capabilities |
| `src/tui/nexus-provider.ts` (+ local) | implement prompt/skill listing |
| `src/mcp/prompts.ts` | **new** — load `prompts/` into named MCP prompts |
| `src/mcp/server.ts` | register prompts + `prompts: {}` capability |
| `src/core/runtime-skill-acquisition.ts` | `listAvailableSkills()` |
| `src/tui/app.tsx` | build/wire registry; slash modes |

---

# Phase 1 — Backbone

## Task 1: Action model extensions

**Files:**
- Modify: `src/tui/actions/types.ts`
- Test: `src/tui/actions/types.test.ts` (exists — add cases)

- [ ] **Step 1: Write the failing test**

Append to `src/tui/actions/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GROUP_ORDER, resolveEnabled, type Action, type ActionContext } from "./types.js";

describe("ActionGroup order", () => {
  test("includes Prompts and Skills before Plugins", () => {
    expect(GROUP_ORDER).toEqual([
      "Navigation",
      "Agents",
      "Workflow",
      "View",
      "Contributions",
      "Prompts",
      "Skills",
      "Plugins",
    ]);
  });
});

describe("resolveEnabled", () => {
  const base = { id: "x", label: "X", detail: "", group: "View", run: () => {} } as const;
  const ctx = {} as ActionContext;

  test("undefined enabled → enabled, no reason", () => {
    expect(resolveEnabled(base as Action, ctx)).toEqual({ enabled: true });
  });
  test("boolean enabled is normalized", () => {
    const a = { ...base, enabled: () => false } as Action;
    expect(resolveEnabled(a, ctx)).toEqual({ enabled: false });
  });
  test("object enabled carries a reason", () => {
    const a = { ...base, enabled: () => ({ enabled: false, reason: "at capacity" }) } as Action;
    expect(resolveEnabled(a, ctx)).toEqual({ enabled: false, reason: "at capacity" });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

[focused-test] `src/tui/actions/types.test.ts`
Expected: FAIL — `resolveEnabled` not exported; `GROUP_ORDER` lacks Prompts/Skills.

- [ ] **Step 3: Implement the extensions**

In `src/tui/actions/types.ts`, replace the `ActionGroup` union and `GROUP_ORDER`:

```ts
export type ActionGroup =
  | "Navigation"
  | "Agents"
  | "Workflow"
  | "View"
  | "Contributions"
  | "Prompts"
  | "Skills"
  | "Plugins";

export const GROUP_ORDER: readonly ActionGroup[] = [
  "Navigation",
  "Agents",
  "Workflow",
  "View",
  "Contributions",
  "Prompts",
  "Skills",
  "Plugins",
];
```

Replace the `Action` interface's `enabled` and `run` members and add the three
new optional fields (keep all other members unchanged):

```ts
export interface Action {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: ActionGroup;
  readonly keywords?: readonly string[] | undefined;
  /** Slash trigger, e.g. "/cancel". Source of truth for the slash surfaces. */
  readonly slash?: string | undefined;
  /** Palette shows suggested actions first when the filter is empty. */
  readonly suggested?: boolean | undefined;
  /** Filled by the registry from the resolved keymap — never authored here. */
  readonly keybind?: string | undefined;
  readonly available?: ((ctx: ActionContext) => boolean) | undefined;
  /** Capability gate. boolean OR { enabled, reason } for a greyed footer note. */
  readonly enabled?:
    | ((ctx: ActionContext) => boolean | { enabled: boolean; reason?: string })
    | undefined;
  readonly run: (ctx: ActionContext, args?: readonly string[]) => void | Promise<void>;
}

/** Normalize the boolean | object `enabled` union to a single shape. */
export function resolveEnabled(
  action: Action,
  ctx: ActionContext,
): { enabled: boolean; reason?: string } {
  const result = action.enabled?.(ctx);
  if (result === undefined) return { enabled: true };
  if (typeof result === "boolean") return { enabled: result };
  return result;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

[focused-test] `src/tui/actions/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. (Existing `enabled?.(ctx) ?? true` call sites still compile —
a boolean-returning predicate is still assignable; object returns are new.)

- [ ] **Step 6: Commit**

```bash
git add src/tui/actions/types.ts src/tui/actions/types.test.ts
git commit -m "feat(tui): #275 extend Action model (slash, suggested, keybind, enabled reason)"
```

---

## Task 2: Registry core

**Files:**
- Create: `src/tui/actions/registry.ts`
- Test: `src/tui/actions/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/actions/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createActionRegistry } from "./registry.js";
import type { Action, ActionContext } from "./types.js";

const ctx = {} as ActionContext;
const action = (over: Partial<Action> & Pick<Action, "id">): Action => ({
  label: over.id,
  detail: "",
  group: "View",
  run: () => {},
  ...over,
});

describe("ActionRegistry", () => {
  test("list returns registered static actions", () => {
    const r = createActionRegistry();
    r.register(action({ id: "a", group: "View" }));
    r.register(action({ id: "b", group: "Navigation" }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["b", "a"]); // Navigation before View
  });

  test("suggested actions sort first within the no-query list", () => {
    const r = createActionRegistry();
    r.register(action({ id: "plain", group: "View" }));
    r.register(action({ id: "star", group: "View", suggested: true }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["star", "plain"]);
  });

  test("available=false hides an action from list", () => {
    const r = createActionRegistry();
    r.register(action({ id: "hidden", available: () => false }));
    r.register(action({ id: "shown" }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["shown"]);
  });

  test("dynamic sources expand at list time", () => {
    const r = createActionRegistry();
    r.registerDynamic("kill.", (c) =>
      (["s1", "s2"] as const).map((s) => action({ id: `kill.${s}`, group: "Agents" })),
    );
    expect(r.list(ctx).map((x) => x.id)).toEqual(["kill.s1", "kill.s2"]);
  });

  test("byId resolves static and dynamic-by-prefix", () => {
    const r = createActionRegistry();
    r.register(action({ id: "static.one" }));
    r.registerDynamic("kill.", () => [action({ id: "kill.s1", group: "Agents" })]);
    expect(r.byId("static.one", ctx)?.id).toBe("static.one");
    expect(r.byId("kill.s1", ctx)?.id).toBe("kill.s1");
    expect(r.byId("kill.absent", ctx)).toBeUndefined();
  });

  test("setBindings annotates keybind on list/byId results", () => {
    const r = createActionRegistry();
    r.register(action({ id: "view.quit", group: "View" }));
    r.setBindings(new Map([["view.quit", "q"]]));
    expect(r.byId("view.quit", ctx)?.keybind).toBe("q");
    expect(r.list(ctx)[0]?.keybind).toBe("q");
  });

  test("search fuzzy-matches label and slash", () => {
    const r = createActionRegistry();
    r.register(action({ id: "view.quit", label: "Quit grove", group: "View" }));
    r.register(action({ id: "view.refresh", label: "Refresh", slash: "/reload", group: "View" }));
    expect(r.search("quit", ctx).map((x) => x.id)).toEqual(["view.quit"]);
    expect(r.search("reload", ctx).map((x) => x.id)).toEqual(["view.refresh"]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

[focused-test] `src/tui/actions/registry.test.ts`
Expected: FAIL — `./registry.js` does not exist.

- [ ] **Step 3: Implement the registry**

Create `src/tui/actions/registry.ts`:

```ts
import { fuzzyMatch } from "./fuzzy.js";
import { computeVisibleActions } from "./visibility.js";
import type { Action, ActionContext } from "./types.js";

export type DynamicSource = (ctx: ActionContext) => readonly Action[];

export interface ActionRegistry {
  register(action: Action): void;
  registerDynamic(idPrefix: string, source: DynamicSource): void;
  setBindings(bindings: ReadonlyMap<string, string>): void;
  list(ctx: ActionContext): readonly Action[];
  byId(id: string, ctx: ActionContext): Action | undefined;
  search(query: string, ctx: ActionContext): readonly Action[];
}

export function createActionRegistry(): ActionRegistry {
  const statics: Action[] = [];
  const dynamics: { prefix: string; source: DynamicSource }[] = [];
  let bindings: ReadonlyMap<string, string> = new Map();

  const annotate = (a: Action): Action => {
    const keybind = bindings.get(a.id);
    return keybind === undefined ? a : { ...a, keybind };
  };

  const expand = (ctx: ActionContext): Action[] => {
    const out: Action[] = [...statics];
    for (const { source } of dynamics) out.push(...source(ctx));
    return out.map(annotate);
  };

  return {
    register(action) {
      statics.push(action);
    },
    registerDynamic(prefix, source) {
      dynamics.push({ prefix, source });
    },
    setBindings(next) {
      bindings = next;
    },
    list(ctx) {
      // computeVisibleActions filters `available` and applies suggested-first +
      // GROUP_ORDER ordering (Task 7). No-query path returns ordered actions.
      return computeVisibleActions(expand(ctx), ctx, "").map((v) => v.action);
    },
    byId(id, ctx) {
      const direct = statics.find((a) => a.id === id);
      if (direct !== undefined) return annotate(direct);
      const owner = dynamics.find((d) => id.startsWith(d.prefix));
      if (owner === undefined) return undefined;
      const found = owner.source(ctx).find((a) => a.id === id);
      return found === undefined ? undefined : annotate(found);
    },
    search(query, ctx) {
      return computeVisibleActions(expand(ctx), ctx, query).map((v) => v.action);
    },
  };
}

// Re-export so callers have one import site.
export { fuzzyMatch };
```

- [ ] **Step 4: Run the focused test to verify it passes**

[focused-test] `src/tui/actions/registry.test.ts`
Expected: PASS. (Requires Task 7's suggested-first ordering for the
`suggested` test — if running Task 2 before Task 7, that one case fails; do Task
7's `visibility.ts` change now if executing strictly in order, OR accept the one
red case until Task 7. Recommended: implement Task 7 Step 3's `visibility.ts`
ordering as part of this step so all cases pass.)

- [ ] **Step 5: Commit**

```bash
git add src/tui/actions/registry.ts src/tui/actions/registry.test.ts
git commit -m "feat(tui): #275 persistent ActionRegistry (static + dynamic sources)"
```

---

## Task 3: Refactor built-ins into static actions + dynamic sources

**Files:**
- Create: `src/tui/actions/dynamic-sources.ts`
- Create: `src/tui/actions/register-builtins.ts`
- Modify: `src/tui/actions/builtin-actions.ts`
- Test: `src/tui/actions/dynamic-sources.test.ts`
- Test: `src/tui/actions/builtin-actions.test.ts` (exists — keep green)

The per-entity actions in `builtin-actions.ts` (sessions, spawn roles, kills,
delegates) become dynamic sources; everything else stays static.

- [ ] **Step 1: Write the failing test**

Create `src/tui/actions/dynamic-sources.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { sessionNavSource, spawnSource, killSource, delegateSource } from "./dynamic-sources.js";
import type { ActionContext } from "./types.js";

const baseCtx = (over: Partial<ActionContext>): ActionContext =>
  ({
    sessions: [],
    profiles: [],
    gossipPeers: [],
    claims: [],
    pendingQuestionCount: 0,
    hasGoals: false,
    canSpawn: true,
    canDelegate: false,
    isPanelVisible: () => false,
    focusedPanel: 0,
    frontierSliceCount: 0,
    ...over,
  }) as ActionContext;

describe("dynamic sources", () => {
  test("sessionNavSource emits one nav action per session", () => {
    const ids = sessionNavSource(baseCtx({ sessions: ["s1", "s2"] })).map((a) => a.id);
    expect(ids).toEqual(["nav.session.s1", "nav.session.s2"]);
  });
  test("killSource emits one kill action per session", () => {
    const ids = killSource(baseCtx({ sessions: ["s1"] })).map((a) => a.id);
    expect(ids).toEqual(["agent.kill.s1"]);
  });
  test("spawnSource is empty when canSpawn is false", () => {
    expect(spawnSource(baseCtx({ canSpawn: false, profiles: [] }))).toEqual([]);
  });
  test("delegateSource skips peers with no free slots", () => {
    const ctx = baseCtx({
      canDelegate: true,
      gossipPeers: [
        { peerId: "p1", address: "a1", freeSlots: 0 },
        { peerId: "p2", address: "a2", freeSlots: 2 },
      ],
    });
    expect(delegateSource(ctx).map((a) => a.id)).toEqual(["agent.delegate.a2"]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

[focused-test] `src/tui/actions/dynamic-sources.test.ts`
Expected: FAIL — `./dynamic-sources.js` missing.

- [ ] **Step 3: Create `dynamic-sources.ts`**

Move the per-entity builders out of `builtin-actions.ts` into
`src/tui/actions/dynamic-sources.ts`. Copy the exact bodies from
`builtin-actions.ts` (sessions loop in `navigationActions`, spawn loops + kill
loop + delegate loop in `agentActions`) into these named sources:

```ts
import { checkSpawn } from "../agents/spawn-validator.js";
import type { Action, ActionContext, DynamicSource } from "./types.js";

export const sessionNavSource: DynamicSource = (ctx) =>
  ctx.sessions.map((session) => ({
    id: `nav.session.${session}`,
    label: `Jump to session ${session}`,
    detail: "session",
    group: "Navigation",
    keywords: ["session", "agent", "jump"],
    run: (c) => c.jumpToSession(session),
  }));

export const spawnSource: DynamicSource = (ctx) => {
  const actions: Action[] = [];
  if (!ctx.canSpawn) return actions;
  const profileRoles = new Set<string>();
  for (const profile of ctx.profiles) {
    if (profileRoles.has(profile.role)) continue;
    profileRoles.add(profile.role);
    const role = profile.role;
    actions.push({
      id: `agent.spawn.${role}`,
      label: `Spawn ${profile.name} [${profile.platform}]`,
      detail: spawnDetail(ctx, role),
      group: "Agents",
      keywords: ["spawn", "agent", role],
      enabled: (c) => spawnAllowed(c, role),
      run: (c) => {
        const command = profile.command ?? topologyCommand(c, role) ?? process.env.SHELL ?? "bash";
        c.spawn(role, command, c.parentAgentId);
      },
    });
  }
  for (const role of ctx.topology?.roles ?? []) {
    if (profileRoles.has(role.name)) continue;
    const name = role.name;
    actions.push({
      id: `agent.spawn.${name}`,
      label: `Spawn ${name}`,
      detail: spawnDetail(ctx, name),
      group: "Agents",
      keywords: ["spawn", "agent", name],
      enabled: (c) => spawnAllowed(c, name),
      run: (c) => c.spawn(name, role.command ?? process.env.SHELL ?? "bash", c.parentAgentId),
    });
  }
  return actions;
};

export const killSource: DynamicSource = (ctx) =>
  ctx.sessions.map((session) => ({
    id: `agent.kill.${session}`,
    label: `Kill ${session}`,
    detail: "running",
    group: "Agents",
    keywords: ["kill", "stop", "agent"],
    run: (c) => c.kill(session),
  }));

export const delegateSource: DynamicSource = (ctx) =>
  ctx.gossipPeers
    .filter((peer) => peer.freeSlots > 0)
    .map((peer) => ({
      id: `agent.delegate.${peer.address}`,
      label: `Delegate to ${peer.peerId} (${peer.freeSlots} free)`,
      detail: "delegate",
      group: "Agents",
      keywords: ["delegate", "peer"],
      available: (c) => c.canDelegate,
      run: (c) => c.delegate(peer.address),
    }));

// Copied verbatim from builtin-actions.ts (keep one source of truth — re-export).
function spawnAllowed(ctx: ActionContext, role: string): boolean {
  if (!ctx.topology) return true;
  if (ctx.claims === null) return false;
  return checkSpawn(ctx.topology, role, ctx.claims, ctx.parentAgentId).allowed;
}
function spawnDetail(ctx: ActionContext, role: string): string {
  if (!ctx.topology || ctx.claims === null) return "spawn";
  const check = checkSpawn(ctx.topology, role, ctx.claims, ctx.parentAgentId);
  const max = check.maxInstances !== undefined ? String(check.maxInstances) : "∞";
  const suffix = !check.allowed ? " (at capacity)" : "";
  const edges = ctx.topology.roles.find((r) => r.name === role)?.edges;
  const edgeSuffix = edges && edges.length > 0 ? ` → ${edges.map((e) => e.target).join(", ")}` : "";
  return `${check.currentInstances}/${max}${suffix}${edgeSuffix}`;
}
function topologyCommand(ctx: ActionContext, role: string): string | undefined {
  return ctx.topology?.roles.find((r) => r.name === role)?.command;
}
```

Add the `DynamicSource` type to `types.ts` (so `registry.ts` and
`dynamic-sources.ts` share it) by adding this export to `src/tui/actions/types.ts`:

```ts
export type DynamicSource = (ctx: ActionContext) => readonly Action[];
```

Then update `registry.ts` to import `DynamicSource` from `./types.js` instead of
declaring it locally (remove the local `export type DynamicSource` line there;
add it to the existing type import).

- [ ] **Step 4: Trim `builtin-actions.ts` to static only**

In `src/tui/actions/builtin-actions.ts`:
- Delete the `sessions` loop inside `navigationActions` (kept in `sessionNavSource`).
- Delete the spawn loops, kill loop, and delegate loop inside `agentActions`
  (kept in `dynamic-sources.ts`); `agentActions` now returns only the static
  `agent.broadcast` and `agent.direct-message` actions.
- Delete the now-unused `spawnAllowed`/`spawnDetail`/`topologyCommand` helpers
  and the `checkSpawn` import from this file.
- Keep `buildBuiltInActions` returning the static set (navigation panel actions,
  `focusedPanelActions`, the trimmed `agentActions`, `workflowActions`,
  `viewActions`, `contributionActions`).

- [ ] **Step 5: Create `register-builtins.ts`**

Create `src/tui/actions/register-builtins.ts`:

```ts
import { buildBuiltInActions } from "./builtin-actions.js";
import { delegateSource, killSource, sessionNavSource, spawnSource } from "./dynamic-sources.js";
import type { ActionContext } from "./types.js";
import type { ActionRegistry } from "./registry.js";

/**
 * Populate a registry with all built-in actions. Static actions that do not
 * depend on per-entity state are registered once via a context-free snapshot;
 * per-entity actions are registered as dynamic sources.
 *
 * `buildBuiltInActions` is pure over the static subset, so a throwaway empty
 * context is safe for enumerating the static descriptors (their `run`/`enabled`
 * receive the LIVE ctx at call time).
 */
export function registerBuiltInActions(registry: ActionRegistry, emptyCtx: ActionContext): void {
  for (const action of buildBuiltInActions(emptyCtx)) registry.register(action);
  registry.registerDynamic("nav.session.", sessionNavSource);
  registry.registerDynamic("agent.spawn.", spawnSource);
  registry.registerDynamic("agent.kill.", killSource);
  registry.registerDynamic("agent.delegate.", delegateSource);
}
```

- [ ] **Step 6: Run focused tests + existing builtin tests**

[focused-test] `src/tui/actions/dynamic-sources.test.ts src/tui/actions/builtin-actions.test.ts`
Expected: dynamic-sources PASS. Fix any `builtin-actions.test.ts` cases that
asserted per-entity actions — move those assertions into
`dynamic-sources.test.ts` (the spawn-at-capacity case asserts `spawnSource`
emits an action whose `enabled(ctx)` is false at capacity).

- [ ] **Step 7: Typecheck + check + commit**

```bash
bun run typecheck && bun run check
git add src/tui/actions/dynamic-sources.ts src/tui/actions/register-builtins.ts \
  src/tui/actions/builtin-actions.ts src/tui/actions/types.ts \
  src/tui/actions/registry.ts src/tui/actions/dynamic-sources.test.ts \
  src/tui/actions/builtin-actions.test.ts
git commit -m "feat(tui): #275 split built-ins into static actions + dynamic sources"
```

---

## Task 4: Keybind → registry-id map

**Files:**
- Create: `src/tui/keymap/keymap-action-map.ts`
- Test: `src/tui/keymap/keymap-action-map.test.ts`

This bridges the keymap's `TuiActionId` / panel-target bindings to registry
action ids, and produces the id→keybind map for `registry.setBindings`. Keymap
types are NOT changed (they stay strict).

- [ ] **Step 1: Write the failing test**

Create `src/tui/keymap/keymap-action-map.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { PanelId } from "../panels/panel-ids.js";
import { bindingToActionId, resolvedKeymapBindings } from "./keymap-action-map.js";
import { resolveBuiltinKeymap, type KeyBinding } from "./keymap.js";

describe("bindingToActionId", () => {
  test("maps a non-panel action binding to its registry id", () => {
    const b = { id: "quit", action: "quit", sequence: ["q"], label: "Quit", context: "global", layer: "normal", preferred: true } as KeyBinding;
    expect(bindingToActionId(b)).toBe("view.quit");
  });
  test("maps a focus_panel binding to nav.panel.<id>", () => {
    const b = {
      id: `focus_panel:${PanelId.Terminal}`,
      action: "focus_panel",
      sequence: ["t"],
      label: "Terminal",
      context: "navigation",
      layer: "normal",
      panel: Panel.Terminal,
      preferred: true,
    } as KeyBinding;
    expect(bindingToActionId(b)).toBe("nav.panel.terminal");
  });
});

describe("resolvedKeymapBindings", () => {
  test("produces id→keybind entries from a resolved keymap", () => {
    const map = resolvedKeymapBindings(resolveBuiltinKeymap("default"));
    expect(map.get("view.quit")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

[focused-test] `src/tui/keymap/keymap-action-map.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the map**

Create `src/tui/keymap/keymap-action-map.ts`. The `TuiActionId`→registry-id
table must cover every `TuiActionId` from `keymap.ts`. Panel-target bindings map
via the panel's `PanelId` to the `nav.panel.<id>` ids produced by
`navigationActions` (note: those ids derive from `PANEL_LABELS[panel]`
lowercased — e.g. `nav.panel.terminal`; verify each against
`builtin-actions.ts`).

```ts
import { PANEL_LABELS } from "../hooks/use-panel-focus.js";
import { panelToId } from "../panels/panel-ids.js";
import {
  formatKeySequence,
  type KeyBinding,
  type ResolvedKeymap,
  type TuiActionId,
} from "./keymap.js";

/** Non-panel TuiActionId → registry action id. */
const ACTION_ID_BY_TUI: Readonly<Record<Exclude<TuiActionId, "focus_panel" | "toggle_panel">, string>> = {
  quit: "view.quit",
  help: "view.help",
  palette: "view.palette", // special: opens the palette (handled in dispatch, see Task 5)
  refresh: "view.refresh",
  zoom_cycle: "view.zoom",
  zoom_reset: "view.zoom-reset",
  layout_toggle: "view.layout",
  view_cycle: "view.view-mode",
  cycle_panel_next: "nav.panel.next",
  cycle_panel_prev: "nav.panel.prev",
  search_start: "view.search",
  terminal_input: "nav.terminal.input",
  compare_toggle: "workflow.compare",
  artifact_prev: "artifact.prev",
  artifact_next: "artifact.next",
  artifact_diff: "artifact.diff",
  artifact_diff_mode: "artifact.diff-mode",
  approve: "workflow.approve-question",
  deny: "workflow.deny-question",
  broadcast: "agent.broadcast",
  direct_message: "agent.direct-message",
  cursor_down: "nav.cursor-down",
  cursor_up: "nav.cursor-up",
  select: "nav.select",
  page_next: "nav.page-next",
  page_prev: "nav.page-prev",
  vfs_navigate: "nav.vfs-navigate",
  terminal_scroll_up: "nav.terminal.scroll-up",
  terminal_scroll_down: "nav.terminal.scroll-down",
  terminal_scroll_bottom: "nav.terminal.scroll-bottom",
  frontier_tab_next: "nav.frontier.next-slice",
  frontier_tab_prev: "nav.frontier.prev-slice",
  frontier_adopt: "contrib.frontier-adopt",
  compare_select: "workflow.compare-select",
  compare_adopt_a: "workflow.compare-adopt-a",
  compare_adopt_b: "workflow.compare-adopt-b",
};

export function bindingToActionId(binding: KeyBinding): string {
  if (binding.action === "focus_panel" || binding.action === "toggle_panel") {
    const id = panelToId(binding.panel);
    const label = PANEL_LABELS[binding.panel];
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `nav.panel.${key}`; // matches navigationActions() id derivation
  }
  return ACTION_ID_BY_TUI[binding.action];
}

/** id → human keybind label, last-writer-wins on duplicate ids. */
export function resolvedKeymapBindings(keymap: ResolvedKeymap): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const binding of keymap.bindings) {
    if (!binding.preferred) continue;
    const id = bindingToActionId(binding);
    if (id !== undefined && !map.has(id)) map.set(id, formatKeySequence(binding.sequence));
  }
  return map;
}
```

> **Note for the implementer:** several mapped registry ids
> (`nav.terminal.input`, `artifact.*`, `nav.cursor-*`, `nav.select`,
> `nav.page-*`, `nav.vfs-navigate`, `workflow.compare-*`) do **not** yet exist as
> built-in actions — they were panel/cursor behaviors living only in the keymap
> switch. Task 5 adds them as static actions so `byId` resolves them. Keep the id
> strings here in exact sync with Task 5's new actions.

- [ ] **Step 4: Run the focused test to verify it passes**

[focused-test] `src/tui/keymap/keymap-action-map.test.ts`
Expected: PASS. If `view.palette` or `nav.panel.terminal` assertions fail, fix
the id strings to match `builtin-actions.ts` derivation.

- [ ] **Step 5: Commit**

```bash
git add src/tui/keymap/keymap-action-map.ts src/tui/keymap/keymap-action-map.test.ts
git commit -m "feat(tui): #275 keymap binding → registry action id map"
```

---

## Task 5: Add missing keymap-only actions; route dispatch through registry

**Files:**
- Modify: `src/tui/actions/builtin-actions.ts` (add panel/cursor static actions)
- Modify: `src/tui/hooks/use-keyboard-handler.ts` (replace `executeKeymapAction`)
- Modify: `src/tui/actions/types.ts` (add the capabilities the new actions need)
- Test: `src/tui/hooks/use-keyboard-handler.test.ts` (exists — add parity cases)

The old `executeKeymapAction` switch (lines 111–278) had focus-gated behaviors
(e.g. `artifact_next` only when `focused === Panel.Artifact`). Each becomes an
action whose `available`/`run` reads `ctx.focusedPanel` and calls a capability.

- [ ] **Step 1: Write the failing parity test**

Add to `src/tui/hooks/use-keyboard-handler.test.ts` a case asserting a keymap
match dispatches through the registry:

```ts
import { describe, expect, test } from "bun:test";
import { createActionRegistry } from "../actions/registry.js";
import type { Action, ActionContext } from "../actions/types.js";
import { dispatchKeymapBinding } from "./use-keyboard-handler.js";
import type { KeyBinding } from "../keymap/keymap.js";

test("dispatchKeymapBinding runs the registry action for a binding", () => {
  let ran = false;
  const r = createActionRegistry();
  r.register({ id: "view.refresh", label: "Refresh", detail: "", group: "View", run: () => { ran = true; } } as Action);
  const binding = { id: "refresh", action: "refresh", sequence: ["r"], label: "Refresh", context: "global", layer: "normal", preferred: true } as KeyBinding;
  const handled = dispatchKeymapBinding(binding, r, {} as ActionContext, () => {});
  expect(handled).toBe(true);
  expect(ran).toBe(true);
});

test("dispatchKeymapBinding skips disabled actions", () => {
  let ran = false;
  const r = createActionRegistry();
  r.register({ id: "view.refresh", label: "Refresh", detail: "", group: "View", enabled: () => false, run: () => { ran = true; } } as Action);
  const binding = { id: "refresh", action: "refresh", sequence: ["r"], label: "Refresh", context: "global", layer: "normal", preferred: true } as KeyBinding;
  expect(dispatchKeymapBinding(binding, r, {} as ActionContext, () => {})).toBe(false);
  expect(ran).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/hooks/use-keyboard-handler.test.ts`
Expected: FAIL — `dispatchKeymapBinding` not exported.

- [ ] **Step 3: Add the missing static actions + capabilities**

In `src/tui/actions/types.ts`, add the capabilities the migrated actions call
(append to the `ActionContext` capabilities block):

```ts
  // Keymap-migrated capabilities (#275)
  readonly enterTerminalInput: () => void;
  readonly artifactPrev: () => void;
  readonly artifactNext: () => void;
  readonly artifactDiffToggle: () => void;
  readonly artifactDiffModeToggle: () => void;
  readonly cursorDown: () => void;
  readonly cursorUp: () => void;
  readonly selectRow: () => void;
  readonly pageNext: () => void;
  readonly pagePrev: () => void;
  readonly vfsNavigate: () => void;
  readonly terminalScrollUp: () => void;
  readonly terminalScrollDown: () => void;
  readonly compareSelect: () => void;
  readonly compareAdoptA: () => void;
  readonly compareAdoptB: () => void;
  readonly frontierAdopt: () => void;
  readonly openPalette: () => void;
```

> **Parity caution:** `frontier_adopt` is NOT the same as `contrib.adopt`.
> `contrib.adopt` adopts `selectedCid`; `frontier_adopt` adopts the frontier
> panel's cursor entry. They get distinct ids/capabilities. `frontierAdopt()`
> closes over the existing `onFrontierAdopt(frontierEntries()[cursor]...)` flow in
> `app.tsx` (the same logic the old switch's `frontier_adopt` case ran), gated on
> `focusedPanel === Panel.Frontier`.

In `src/tui/actions/builtin-actions.ts`, add a `keymapMigratedActions()` group
and include it in `buildBuiltInActions`. Each action's `available` mirrors the
old switch's focus gate. Example (write the full set — one per id from Task 4's
table that wasn't already a built-in):

```ts
import { Panel } from "../hooks/use-panel-focus.js";

function keymapMigratedActions(): readonly Action[] {
  return [
    { id: "view.palette", label: "Open command palette", detail: "view", group: "View",
      keywords: ["palette", "command"], run: (c) => c.openPalette() },
    { id: "nav.terminal.input", label: "Enter terminal input", detail: "terminal", group: "Navigation",
      keywords: ["terminal", "input", "type"], available: (c) => c.focusedPanel === Panel.Terminal,
      run: (c) => c.enterTerminalInput() },
    { id: "artifact.prev", label: "Previous artifact", detail: "artifact", group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.artifactPrev() },
    { id: "artifact.next", label: "Next artifact", detail: "artifact", group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.artifactNext() },
    { id: "artifact.diff", label: "Toggle artifact diff", detail: "artifact", group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.artifactDiffToggle() },
    { id: "artifact.diff-mode", label: "Cycle artifact diff mode", detail: "artifact", group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.artifactDiffModeToggle() },
    { id: "nav.cursor-down", label: "Move cursor down", detail: "nav", group: "Navigation",
      run: (c) => c.cursorDown() },
    { id: "nav.cursor-up", label: "Move cursor up", detail: "nav", group: "Navigation",
      run: (c) => c.cursorUp() },
    { id: "nav.select", label: "Select row", detail: "nav", group: "Navigation",
      run: (c) => c.selectRow() },
    { id: "nav.page-next", label: "Next page", detail: "nav", group: "Navigation",
      run: (c) => c.pageNext() },
    { id: "nav.page-prev", label: "Previous page", detail: "nav", group: "Navigation",
      run: (c) => c.pagePrev() },
    { id: "nav.vfs-navigate", label: "Open VFS entry", detail: "vfs", group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Vfs, run: (c) => c.vfsNavigate() },
    { id: "nav.terminal.scroll-up", label: "Scroll terminal up", detail: "terminal", group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Terminal, run: (c) => c.terminalScrollUp() },
    { id: "nav.terminal.scroll-down", label: "Scroll terminal down", detail: "terminal", group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Terminal, run: (c) => c.terminalScrollDown() },
    { id: "workflow.compare-select", label: "Select for compare", detail: "compare", group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Frontier, run: (c) => c.compareSelect() },
    { id: "workflow.compare-adopt-a", label: "Adopt compare A", detail: "compare", group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.compareAdoptA() },
    { id: "workflow.compare-adopt-b", label: "Adopt compare B", detail: "compare", group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Artifact, run: (c) => c.compareAdoptB() },
    { id: "contrib.frontier-adopt", label: "Adopt frontier entry", detail: "frontier", group: "Contributions",
      keywords: ["adopt", "frontier"], available: (c) => c.focusedPanel === Panel.Frontier,
      run: (c) => c.frontierAdopt() },
  ];
}
```

Add `...keymapMigratedActions()` to the `buildBuiltInActions` array.

> Note: `approve/deny`→`workflow.approve-question/deny-question` and
> `nav.panel.next/prev` already exist as built-ins; do not duplicate. The
> `workflow.approve-question`/`deny-question` actions are `available` only when
> `pendingQuestionCount === 1` — the keymap binding will be a no-op (returns
> false) when 0 or >1 pending, matching the old switch's `focused === Decisions`
> gate intent. If exact parity with the old Decisions-panel gate is required, add
> a `focusedPanel === Panel.Decisions` clause to those actions' `available`.

- [ ] **Step 4: Replace `executeKeymapAction` with registry dispatch**

In `src/tui/hooks/use-keyboard-handler.ts`:
- Delete the entire `executeKeymapAction` function (lines 111–278).
- Add the new dispatch helper and the registry/ctx to `KeyboardActions`:

```ts
import type { ActionRegistry } from "../actions/registry.js";
import { resolveEnabled, type ActionContext } from "../actions/types.js";
import { bindingToActionId } from "../keymap/keymap-action-map.js";

export function dispatchKeymapBinding(
  binding: KeyBinding,
  registry: ActionRegistry,
  ctx: ActionContext,
  onError: (message: string) => void,
): boolean {
  const id = bindingToActionId(binding);
  const action = registry.byId(id, ctx);
  if (action === undefined) return false;
  if (!resolveEnabled(action, ctx).enabled) return false;
  void Promise.resolve(action.run(ctx)).catch((e) =>
    onError(e instanceof Error ? e.message : "Action failed"),
  );
  return true;
}
```

- Add to `KeyboardActions`: `readonly registry: ActionRegistry;`,
  `readonly actionContext: ActionContext;`, `readonly onActionError: (m: string) => void;`.
- In `routeKey`, replace the `case "match":` body:

```ts
        case "match":
          actions.onKeymapPrefixChange?.([]);
          if (
            dispatchKeymapBinding(
              result.binding,
              actions.registry,
              actions.actionContext,
              actions.onActionError,
            )
          )
            return true;
          if (keymapPrefix.length > 0) return true;
          break;
```

- [ ] **Step 5: Run focused + full keyboard tests**

[focused-test] `src/tui/hooks/use-keyboard-handler.test.ts`
Expected: new parity cases PASS. Update existing tests that referenced
`executeKeymapAction` to call `dispatchKeymapBinding` with a registry stub.

- [ ] **Step 6: Typecheck + check + commit**

```bash
bun run typecheck && bun run check
git add src/tui/actions/builtin-actions.ts src/tui/actions/types.ts \
  src/tui/hooks/use-keyboard-handler.ts src/tui/hooks/use-keyboard-handler.test.ts
git commit -m "feat(tui): #275 dispatch keymap through registry; retire executeKeymapAction"
```

---

## Task 6: Leader-chord 2s modal + capture + overlay

**Files:**
- Create: `src/tui/keymap/leader-chord.ts` (pure helpers)
- Create: `src/tui/components/leader-overlay.tsx`
- Test: `src/tui/keymap/leader-chord.test.ts`
- Modify: `src/tui/hooks/use-keyboard-handler.ts` (capture while pending)

- [ ] **Step 1: Write the failing test**

Create `src/tui/keymap/leader-chord.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { candidateContinuations } from "./leader-chord.js";
import { resolveBuiltinKeymap } from "./keymap.js";

describe("candidateContinuations", () => {
  test("lists next-key options for a pending leader prefix", () => {
    const km = resolveBuiltinKeymap("default");
    const cands = candidateContinuations(km.bindings, ["space"]);
    // Each candidate is { key, label } for a binding whose sequence starts with space.
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => typeof c.key === "string" && typeof c.label === "string")).toBe(true);
  });
  test("returns [] for a prefix with no children", () => {
    const km = resolveBuiltinKeymap("default");
    expect(candidateContinuations(km.bindings, ["nonexistent-token"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/keymap/leader-chord.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper**

Create `src/tui/keymap/leader-chord.ts`:

```ts
import { formatKeySequence, type KeyBinding, type KeySequence } from "./keymap.js";

export interface ChordCandidate {
  readonly key: string;
  readonly label: string;
}

/** Next-key options for bindings whose sequence extends `prefix` by ≥1 token. */
export function candidateContinuations(
  bindings: readonly KeyBinding[],
  prefix: KeySequence,
): readonly ChordCandidate[] {
  const out: ChordCandidate[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    if (b.sequence.length <= prefix.length) continue;
    if (!prefix.every((t, i) => b.sequence[i] === t)) continue;
    const nextToken = b.sequence[prefix.length];
    if (nextToken === undefined || seen.has(nextToken)) continue;
    seen.add(nextToken);
    out.push({ key: formatKeySequence([nextToken]), label: b.label });
  }
  return out;
}

/** Window after the leader key during which the chord stays armed. */
export const LEADER_CHORD_TIMEOUT_MS = 2000;
```

- [ ] **Step 4: Create the overlay component**

Create `src/tui/components/leader-overlay.tsx`:

```tsx
import React from "react";
import { candidateContinuations, type ChordCandidate } from "../keymap/leader-chord.js";
import { formatKeySequence, type KeyBinding } from "../keymap/keymap.js";
import { theme } from "../theme.js";

export interface LeaderOverlayProps {
  readonly prefix: readonly string[];
  readonly bindings: readonly KeyBinding[];
}

export function LeaderOverlay({ prefix, bindings }: LeaderOverlayProps): React.ReactNode {
  if (prefix.length === 0) return null;
  const candidates: readonly ChordCandidate[] = candidateContinuations(bindings, prefix);
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text color={theme.focus}>{formatKeySequence(prefix)} </text>
      {candidates.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: candidates are positional
        <text key={`${c.key}-${i}`} color={theme.secondary}>
          {`${c.key}:${c.label}  `}
        </text>
      ))}
    </box>
  );
}
```

- [ ] **Step 5: Add the 2s timer + capture (wiring is finished in Task 8)**

In `src/tui/hooks/use-keyboard-handler.ts`, the pending prefix already routes all
Normal-mode keys to the resolver (lines 435–460), which IS the capture behavior.
Add an explicit guard so a pending prefix is never leaked to later handlers: at
the start of `routeKey`, after computing `keymapPrefix`, leave the existing flow
intact (it already `return`s on pending/match/miss-with-prefix). No code change
needed here beyond Task 5. The 2s timer is owned by `app.tsx` (Task 8): it arms a
`setTimeout` on prefix change and clears the prefix on expiry.

- [ ] **Step 6: Run focused test + commit**

[focused-test] `src/tui/keymap/leader-chord.test.ts`
Expected: PASS.

```bash
bun run check
git add src/tui/keymap/leader-chord.ts src/tui/keymap/leader-chord.test.ts \
  src/tui/components/leader-overlay.tsx
git commit -m "feat(tui): #275 leader-chord candidates + overlay + 2s window constant"
```

---

## Task 7: Palette — suggested-first, keybind column, reason footer

**Files:**
- Modify: `src/tui/actions/visibility.ts` (suggested-first ordering)
- Modify: `src/tui/components/command-palette.tsx` (keybind column + reason footer)
- Test: `src/tui/actions/visibility.test.ts` (exists — add case)
- Test: `src/tui/components/command-palette.test.tsx` (exists — add cases)

- [ ] **Step 1: Write the failing tests**

Add to `src/tui/actions/visibility.test.ts`:

```ts
test("no-query order puts suggested actions first, then GROUP_ORDER", () => {
  const mk = (id: string, group: any, suggested?: boolean) =>
    ({ id, label: id, detail: "", group, suggested, run: () => {} }) as any;
  const actions = [mk("v", "View"), mk("n", "Navigation"), mk("s", "View", true)];
  const out = computeVisibleActions(actions, {} as any, "").map((x) => x.action.id);
  expect(out).toEqual(["s", "n", "v"]);
});
```

Add to `src/tui/components/command-palette.test.tsx` (follow the file's existing
render-assertion style) a case asserting a disabled action's `reason` renders in
the footer and a `keybind` renders on the row. Use the existing test's render
harness; assert the rendered output contains the reason string and the keybind
string.

- [ ] **Step 2: Run to verify they fail**

[focused-test] `src/tui/actions/visibility.test.ts src/tui/components/command-palette.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement suggested-first ordering**

In `src/tui/actions/visibility.ts`, replace the no-query sort:

```ts
  if (!q) {
    const rank = (a: Action) => (a.suggested ? 0 : 1);
    const ordered = [...available].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    });
    return ordered.map((action) => ({ action, matchedIndices: [] }));
  }
```

Also extend the query branch to fuzzy-match `slash` (so `search("reload")` finds
`/reload`): inside the keyword loop, after the keywords, add:

```ts
    if (action.slash) {
      const r = fuzzyMatch(q, action.slash);
      if (r.match && r.score > best) best = r.score;
    }
```

- [ ] **Step 4: Implement keybind column + reason footer**

In `src/tui/components/command-palette.tsx`:
- Import `resolveEnabled` from `../actions/types.js`.
- In the row map, compute `const { enabled, reason } = resolveEnabled(action, ctx);`
  and use `const dimmed = !enabled;`. When `action.keybind` is set, render it
  right-aligned after the detail:

```tsx
                  {action.detail ? <text color={detailColor}> [{action.detail}]</text> : null}
                  {action.keybind ? (
                    <text color={theme.secondary}>{`  ${action.keybind}`}</text>
                  ) : null}
```

- Track the selected row's disabled reason and render it in the footer box:

```tsx
        <box marginTop={1} paddingLeft={1} flexDirection="column">
          <text color={theme.secondary}>[j/k] navigate [Enter] execute [Esc] close</text>
          {selectedReason ? <text color={theme.disabled}>{selectedReason}</text> : null}
        </box>
```

where `selectedReason` is computed from the selected `visibleActions[idx]`:

```tsx
    const selected = visibleActions[idx]?.action;
    const selectedReason = selected ? resolveEnabled(selected, ctx).reason : undefined;
```

- [ ] **Step 5: Run focused tests**

[focused-test] `src/tui/actions/visibility.test.ts src/tui/components/command-palette.test.tsx`
Expected: PASS. (The Task 2 `suggested` registry case now passes too.)

- [ ] **Step 6: Commit**

```bash
bun run check
git add src/tui/actions/visibility.ts src/tui/actions/visibility.test.ts \
  src/tui/components/command-palette.tsx src/tui/components/command-palette.test.tsx
git commit -m "feat(tui): #275 palette suggested-first + keybind column + reason footer"
```

---

## Task 8: Wire the registry into app.tsx

**Files:**
- Modify: `src/tui/app.tsx`

Replace the per-render `buildBuiltInActions`/`buildPluginActions` concat with a
once-built registry; feed bindings; route keyboard + palette through it; arm the
leader timer; render the overlay.

- [ ] **Step 1: Build the registry once**

Near the action wiring (after `actionContext` is defined, ~line 921), add:

```ts
  const registry = useMemo(() => {
    const r = createActionRegistry();
    registerBuiltInActions(r, actionContext); // static descriptors enumerated once
    r.registerDynamic("plugin.", (c) =>
      buildPluginActions(mergedActionRegistry.entries, mkPluginCtx),
    );
    return r;
    // Built once: actionContext closures are stable; live state flows via ctx at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

> If `buildPluginActions` needs live `mergedActionRegistry.entries`, capture them
> through a ref updated in an effect so the dynamic source reads the latest set
> without rebuilding the registry. Add:
> `const pluginEntriesRef = useRef(mergedActionRegistry.entries);` + an effect
> setting `pluginEntriesRef.current = mergedActionRegistry.entries;` and read
> `pluginEntriesRef.current` inside the dynamic source.

- [ ] **Step 2: Feed keybinds whenever the resolved keymap changes**

After `resolvedKeymap` is defined (~line 155), add:

```ts
  useEffect(() => {
    registry.setBindings(resolvedKeymapBindings(resolvedKeymap));
  }, [registry, resolvedKeymap]);
```

- [ ] **Step 3: Replace palette action sourcing**

Replace `paletteActions`/`filteredActions` (lines 1069–1079):

```ts
  const filteredActions = useMemo(
    () =>
      ks.paletteQuery.trim()
        ? registry.search(ks.paletteQuery, actionContext)
        : registry.list(actionContext),
    [registry, actionContext, ks.paletteQuery],
  );
```

Pass `filteredActions` to `<CommandPalette actions={filteredActions} ... />` and
to the `paletteItemCount`/`onPaletteSelect` index logic (it already uses the flat
list).

- [ ] **Step 4: Pass registry + ctx into the keyboard handler**

Where `KeyboardActions` is assembled (the object passed to `routeKey`), add:

```ts
    registry,
    actionContext,
    onActionError: showError,
```

- [ ] **Step 5: Arm the leader 2s timer**

Where `keymapPrefix`/`setKeymapPrefix` live (~line 159), add:

```ts
  useEffect(() => {
    if (keymapPrefix.length === 0) return;
    const t = setTimeout(() => setKeymapPrefix([]), LEADER_CHORD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [keymapPrefix]);
```

- [ ] **Step 6: Render the overlay**

Near the status bar / palette render, add (visible only when a chord is pending
and the palette is not open):

```tsx
        {!paletteVisible && keymapPrefix.length > 0 ? (
          <LeaderOverlay prefix={keymapPrefix} bindings={resolvedKeymap.bindings} />
        ) : null}
```

- [ ] **Step 7: Update imports**

Add to `src/tui/app.tsx` imports:

```ts
import { createActionRegistry } from "./actions/registry.js";
import { registerBuiltInActions } from "./actions/register-builtins.js";
import { resolvedKeymapBindings } from "./keymap/keymap-action-map.js";
import { LEADER_CHORD_TIMEOUT_MS } from "./keymap/leader-chord.js";
import { LeaderOverlay } from "./components/leader-overlay.js";
```

Remove the now-unused `buildBuiltInActions` and `computeVisibleActions` imports
if no longer referenced.

- [ ] **Step 8: Provide the new capabilities in `actionContext`**

The `actionContext` useMemo (~line 921) must now supply every capability added in
Task 5 (`openPalette`, `enterTerminalInput`, `artifactPrev`, …). Wire each to the
existing `KeyboardActions` handlers already present in `app.tsx` (e.g.
`openPalette: () => { onSpawnPalette(); panels.setMode(InputMode.CommandPalette); }`,
`artifactNext: handleArtifactNext`, `cursorDown: () => nav.cursorDown(...)`,
etc.). Reuse the existing callbacks — do not duplicate logic.

- [ ] **Step 9: Typecheck, check, full test suite**

```bash
bun run typecheck && bun run check && bun test
```
Expected: PASS. Fix any remaining references to deleted symbols.

- [ ] **Step 10: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): #275 wire ActionRegistry into app (palette + keymap + leader overlay)"
```

---

# Phase 2 — Slash

## Task 9: Slash field on actions + slash index

**Files:**
- Modify: `src/tui/actions/builtin-actions.ts` (add `slash` to common actions)
- Create: `src/tui/actions/slash-index.ts`
- Test: `src/tui/actions/slash-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/actions/slash-index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildSlashIndex } from "./slash-index.js";
import type { Action } from "./types.js";

const a = (id: string, slash?: string): Action =>
  ({ id, label: id, detail: "", group: "View", slash, run: () => {} }) as Action;

describe("buildSlashIndex", () => {
  test("maps slash trigger → action id, ignoring actions without slash", () => {
    const idx = buildSlashIndex([a("view.quit", "/quit"), a("view.refresh")]);
    expect(idx.get("/quit")).toBe("view.quit");
    expect(idx.size).toBe(1);
  });
  test("resolveSlash parses /cmd args", () => {
    const idx = buildSlashIndex([a("agent.spawn", "/spawn")]);
    const r = resolveSlash(idx, "/spawn reviewer fast");
    expect(r).toEqual({ id: "agent.spawn", args: ["reviewer", "fast"] });
  });
  test("resolveSlash returns undefined for unknown command", () => {
    expect(resolveSlash(buildSlashIndex([]), "/nope")).toBeUndefined();
  });
});

import { resolveSlash } from "./slash-index.js";
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/actions/slash-index.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the index**

Create `src/tui/actions/slash-index.ts`:

```ts
import type { Action } from "./types.js";

export function buildSlashIndex(actions: readonly Action[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const a of actions) {
    if (a.slash && !map.has(a.slash)) map.set(a.slash, a.id);
  }
  return map;
}

export interface SlashResolution {
  readonly id: string;
  readonly args: readonly string[];
}

export function resolveSlash(
  index: ReadonlyMap<string, string>,
  input: string,
): SlashResolution | undefined {
  const tokens = input.trim().split(/\s+/).filter((t) => t.length > 0);
  const cmd = tokens[0];
  if (cmd === undefined) return undefined;
  const id = index.get(cmd);
  if (id === undefined) return undefined;
  return { id, args: tokens.slice(1) };
}
```

- [ ] **Step 4: Add `slash` to common built-in actions**

In `src/tui/actions/builtin-actions.ts`, add `slash` to high-value actions
(write them all): `view.quit` → `slash: "/quit"`, `view.refresh` →
`slash: "/refresh"`, `view.search` → `slash: "/search"`, `view.help` →
`slash: "/help"`, `workflow.set-goal` → `slash: "/goal"`,
`workflow.compare` → `slash: "/compare"`, `agent.broadcast` →
`slash: "/broadcast"`, `agent.direct-message` → `slash: "/dm"`. Mark
`view.palette`, `view.search`, `workflow.set-goal` with `suggested: true`.

- [ ] **Step 5: Run focused test + commit**

[focused-test] `src/tui/actions/slash-index.test.ts`
Expected: PASS.

```bash
bun run check
git add src/tui/actions/slash-index.ts src/tui/actions/slash-index.test.ts \
  src/tui/actions/builtin-actions.ts
git commit -m "feat(tui): #275 slash index + slash triggers on built-in actions"
```

---

## Task 10: `/` opens the palette in slash mode

**Files:**
- Modify: `src/tui/hooks/use-keyboard-handler.ts` (`/` in Normal opens palette)
- Modify: `src/tui/components/command-palette.tsx` (slash-mode filter)
- Modify: `src/tui/app.tsx` (pass slash mode + seed query)
- Test: `src/tui/components/command-palette.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/tui/components/command-palette.test.tsx`: when `slashMode` is true,
only actions with a `slash` field render. Assert that a non-slash action is
absent and a slash action is present.

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/components/command-palette.test.tsx`
Expected: FAIL — `slashMode` prop unknown.

- [ ] **Step 3: Add `slashMode` to the palette**

In `src/tui/components/command-palette.tsx`, add `readonly slashMode?: boolean;`
to `CommandPaletteProps`, and when true, pre-filter actions to those with a
`slash` before `computeVisibleActions`:

```tsx
    const source = slashMode ? actions.filter((a) => a.slash) : actions;
    const visibleActions = useMemo(
      () => computeVisibleActions(source, ctx, q),
      [source, ctx, q],
    );
```

- [ ] **Step 4: `/` opens slash-mode palette**

In `src/tui/hooks/use-keyboard-handler.ts`, the existing `/` handler only fires
when `focused === Panel.Search` (line 541). Add, in Normal mode before that,
when no panel-specific `/` applies:

```ts
  if (input === "/" && mode === InputMode.Normal && focused !== Panel.Search) {
    actions.onSlashPaletteOpen();
    return true;
  }
```

Add `readonly onSlashPaletteOpen: () => void;` to `KeyboardActions`.

- [ ] **Step 5: Wire in app.tsx**

Add `onSlashPaletteOpen` to the keyboard actions: open the palette with a
`slashMode` flag set in app state, then pass `slashMode` to `<CommandPalette>`.
Add a `const [slashMode, setSlashMode] = useState(false);`, set true on slash
open and false on every palette close path (`handleCommandPaletteClose`).

- [ ] **Step 6: Run focused test + full check + commit**

[focused-test] `src/tui/components/command-palette.test.tsx`
Expected: PASS.

```bash
bun run typecheck && bun run check
git add src/tui/components/command-palette.tsx src/tui/hooks/use-keyboard-handler.ts \
  src/tui/app.tsx src/tui/components/command-palette.test.tsx
git commit -m "feat(tui): #275 '/' opens slash-filtered command palette"
```

---

## Task 11: Dedicated command-line input

**Files:**
- Create: `src/tui/components/slash-input.tsx`
- Modify: `src/tui/hooks/use-panel-focus.ts` (add `InputMode.SlashCommand`)
- Modify: `src/tui/hooks/use-keyboard-handler.ts` (SlashCommand input mode)
- Modify: `src/tui/app.tsx` (state + submit → resolveSlash → run)
- Test: `src/tui/components/slash-input.test.tsx`

- [ ] **Step 1: Add the input mode**

In `src/tui/hooks/use-panel-focus.ts`, add `SlashCommand` to the `InputMode`
enum.

- [ ] **Step 2: Write the failing test**

Create `src/tui/components/slash-input.test.tsx` asserting the component renders
the current buffer with a leading `/` prompt and an error line when `error` is
set. Follow the existing component-test render style.

- [ ] **Step 3: Run to verify it fails**

[focused-test] `src/tui/components/slash-input.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the component**

Create `src/tui/components/slash-input.tsx`:

```tsx
import React from "react";
import { theme } from "../theme.js";

export interface SlashInputProps {
  readonly visible: boolean;
  readonly buffer: string;
  readonly error?: string | undefined;
}

export function SlashInput({ visible, buffer, error }: SlashInputProps): React.ReactNode {
  if (!visible) return null;
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text color={theme.focus}>/</text>
        <text color={theme.text}>{buffer}</text>
        <text color={theme.secondary}>▏</text>
      </box>
      {error ? <text color={theme.disabled}>{error}</text> : null}
    </box>
  );
}
```

- [ ] **Step 5: Handle SlashCommand keys**

In `src/tui/hooks/use-keyboard-handler.ts`, add a handler block mirroring the
Search/Goal input modes:

```ts
  if (mode === InputMode.SlashCommand) {
    if (input === "return") {
      actions.onSlashSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onSlashBackspace();
      return true;
    }
    if (input === "space") {
      actions.onSlashChar(" ");
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onSlashChar(input);
      return true;
    }
    return true;
  }
```

Add `onSlashSubmit`, `onSlashChar`, `onSlashBackspace` to `KeyboardActions`. Also
make Surface 1's `/` open the command line when a power-user setting prefers it —
for now `/` opens the slash palette (Task 10) and a distinct binding (e.g.
`:` ) opens the command line: add `if (input === ":" && mode === InputMode.Normal) { actions.onSlashCommandOpen(); return true; }`
and `onSlashCommandOpen` to `KeyboardActions`.

- [ ] **Step 6: Wire submit in app.tsx**

Add slash command-line state (`slashBuffer`, `slashError`) and handlers:

```ts
  const onSlashSubmit = useCallback(() => {
    const index = buildSlashIndex(registry.list(actionContext));
    const r = resolveSlash(index, `/${slashBuffer}`);
    if (r === undefined) {
      setSlashError(`Unknown command: /${slashBuffer.split(/\s+/)[0] ?? ""}`);
      return;
    }
    const action = registry.byId(r.id, actionContext);
    setSlashBuffer("");
    setSlashError(undefined);
    panels.setMode(InputMode.Normal);
    if (action) void Promise.resolve(action.run(actionContext, r.args)).catch(showError);
  }, [registry, actionContext, slashBuffer, panels, showError]);
```

Render `<SlashInput visible={panels.state.mode === InputMode.SlashCommand} buffer={slashBuffer} error={slashError} />`.
Wire `onSlashChar`/`onSlashBackspace`/`onSlashCommandOpen` to update
`slashBuffer` and set mode `SlashCommand`.

- [ ] **Step 7: Run focused tests + full suite + commit**

[focused-test] `src/tui/components/slash-input.test.tsx`
Then: `bun run typecheck && bun run check && bun test`

```bash
git add src/tui/components/slash-input.tsx src/tui/components/slash-input.test.tsx \
  src/tui/hooks/use-panel-focus.ts src/tui/hooks/use-keyboard-handler.ts src/tui/app.tsx
git commit -m "feat(tui): #275 dedicated slash command-line input (/cmd args)"
```

---

# Phase 3 — MCP prompts

## Task 12: Grove MCP server exposes prompts from `prompts/`

**Files:**
- Create: `src/mcp/prompts.ts`
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/prompts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadPromptDefinitions } from "./prompts.js";

describe("loadPromptDefinitions", () => {
  test("loads .md files from a prompts dir as named prompts", async () => {
    const defs = await loadPromptDefinitions(new URL("../../prompts/", import.meta.url).pathname);
    expect(Array.isArray(defs)).toBe(true);
    // Each def has a name (file stem) and a non-empty template body.
    for (const d of defs) {
      expect(typeof d.name).toBe("string");
      expect(d.template.length).toBeGreaterThan(0);
    }
  });

  test("returns [] for a missing directory", async () => {
    expect(await loadPromptDefinitions("/no/such/dir")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/mcp/prompts.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the loader**

Create `src/mcp/prompts.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export interface PromptDefinition {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

/** Load each *.md / *.txt file in `dir` as a named prompt (name = file stem). */
export async function loadPromptDefinitions(dir: string): Promise<readonly PromptDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const defs: PromptDefinition[] = [];
  for (const entry of entries.sort()) {
    const ext = extname(entry).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") continue;
    const template = (await readFile(join(dir, entry), "utf8")).trim();
    if (template.length === 0) continue;
    const name = basename(entry, ext);
    const firstLine = template.split("\n", 1)[0]?.replace(/^#+\s*/, "") ?? name;
    defs.push({ name, description: firstLine.slice(0, 120), template });
  }
  return defs;
}
```

- [ ] **Step 4: Register prompts in the MCP server**

In `src/mcp/server.ts`:
- Change the server capabilities to include prompts:

```ts
  const server = new McpServer(
    { name: "grove-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );
```

- Add a `promptsDir?: string` field to `McpPresetConfig` (or read from
  `deps`). After the tool registrations, before `return server;`:

```ts
  const promptsDir = preset?.promptsDir;
  if (promptsDir !== undefined) {
    for (const def of await loadPromptDefinitions(promptsDir)) {
      server.registerPrompt(
        def.name,
        { title: def.name, description: def.description, argsSchema: {} },
        () => ({ messages: [{ role: "user", content: { type: "text", text: def.template } }] }),
      );
    }
  }
```

- Import `loadPromptDefinitions` at the top.

- [ ] **Step 5: Run focused test + full suite + commit**

[focused-test] `src/mcp/prompts.test.ts`
Then `bun run typecheck && bun run check`.

```bash
git add src/mcp/prompts.ts src/mcp/prompts.test.ts src/mcp/server.ts
git commit -m "feat(mcp): #275 expose prompts from prompts/ dir (prompts capability)"
```

---

## Task 13: Provider prompt listing

**Files:**
- Modify: `src/tui/provider.ts` (`TuiPromptProvider`, capability)
- Modify: `src/tui/nexus-provider.ts`, `src/tui/local-provider.ts`,
  `src/tui/store-backed-provider.ts`, `src/tui/remote-provider.ts`
- Test: `src/tui/local-provider.test.ts` (+ `src/tui/provider.conformance.ts` if
  the new method warrants a shared conformance assertion)

- [ ] **Step 1: Add the interface + capability**

In `src/tui/provider.ts`:

```ts
export interface PromptInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly arguments?: readonly { name: string; required?: boolean }[] | undefined;
}

export interface TuiPromptProvider {
  listMcpPrompts(): Promise<readonly PromptInfo[]>;
}
```

Add `readonly prompts: boolean;` to `ProviderCapabilities`.

- [ ] **Step 2: Write the failing test**

Add to `src/tui/local-provider.test.ts` a case asserting the local provider
returns the prompt names loaded from `prompts/` and reports
`capabilities.prompts === true`.

- [ ] **Step 3: Run to verify it fails**

[focused-test] `src/tui/local-provider.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- `src/tui/local-provider.ts`: implement `listMcpPrompts` via
  `loadPromptDefinitions` over the repo `prompts/` dir; set
  `capabilities.prompts = true`.
- `src/tui/nexus-provider.ts`: implement `listMcpPrompts` by calling the Grove
  MCP server's `prompts/list` (reuse the existing MCP client/transport the
  provider already holds; if none, fall back to `loadPromptDefinitions` and set
  the capability accordingly).
- Add `prompts: false` to every other `ProviderCapabilities` literal:
  `src/tui/store-backed-provider.ts`, `src/tui/remote-provider.ts`,
  `src/tui/provider-shared.ts`, plus any in `src/tui/provider.ts`. Run
  `bun run typecheck` to find them all (the new required field makes each missing
  literal a compile error).

- [ ] **Step 5: Run focused + typecheck + commit**

```bash
bun run typecheck && bun run check
git add src/tui/provider.ts src/tui/local-provider.ts src/tui/nexus-provider.ts \
  src/tui/store-backed-provider.ts src/tui/remote-provider.ts src/tui/provider-shared.ts \
  src/tui/local-provider.test.ts
git commit -m "feat(tui): #275 TuiPromptProvider.listMcpPrompts + capability"
```

---

## Task 14: `prompt.*` dynamic source

**Files:**
- Modify: `src/tui/actions/types.ts` (`mcpPrompts`, `runPrompt`)
- Modify: `src/tui/actions/dynamic-sources.ts` (`promptSource`)
- Modify: `src/tui/app.tsx` (fetch prompts while palette open; wire `runPrompt`)
- Test: `src/tui/actions/dynamic-sources.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/tui/actions/dynamic-sources.test.ts`:

```ts
import { promptSource } from "./dynamic-sources.js";

test("promptSource emits a Prompts-group action per prompt, gated on selected session", () => {
  const ctx = baseCtx({
    selectedSession: "s1",
    mcpPrompts: [{ name: "triage", description: "Triage" }],
  });
  const actions = promptSource(ctx);
  expect(actions.map((a) => a.id)).toEqual(["prompt.triage"]);
  expect(actions[0]?.group).toBe("Prompts");
  expect(actions[0]?.available?.(baseCtx({ mcpPrompts: ctx.mcpPrompts }))).toBe(false); // no session
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/actions/dynamic-sources.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `ActionContext`**

In `src/tui/actions/types.ts`, add:

```ts
  readonly mcpPrompts?: readonly import("../provider.js").PromptInfo[] | undefined;
  readonly runPrompt: (name: string, session: string, args?: readonly string[]) => void;
```

- [ ] **Step 4: Implement `promptSource`**

Add to `src/tui/actions/dynamic-sources.ts`:

```ts
export const promptSource: DynamicSource = (ctx) =>
  (ctx.mcpPrompts ?? []).map((p) => ({
    id: `prompt.${p.name}`,
    label: `Prompt: ${p.name}`,
    detail: p.description ?? "prompt",
    group: "Prompts" as const,
    slash: `/prompt:${p.name}`,
    keywords: ["prompt", p.name],
    available: (c) => c.selectedSession !== undefined,
    run: (c, args) => {
      if (c.selectedSession) c.runPrompt(p.name, c.selectedSession, args);
    },
  }));
```

Register it in `register-builtins.ts`:
`registry.registerDynamic("prompt.", promptSource);`

- [ ] **Step 5: Wire fetch + `runPrompt` in app.tsx**

- Fetch prompts when the palette/slash surface opens (mirror the
  `pendingQuestionCount` fetcher): `if (capabilities.prompts) provider.listMcpPrompts()`
  → store in state → feed `actionContext.mcpPrompts`.
- Implement `runPrompt(name, session, args)` by delivering the prompt to the
  selected agent through the provider's existing agent-message path (ACP / Nexus
  IPC — the same call the broadcast/direct-message flow uses). **Do not** use
  tmux send-keys.

- [ ] **Step 6: Run focused + full suite + commit**

```bash
bun run typecheck && bun run check && bun test
git add src/tui/actions/types.ts src/tui/actions/dynamic-sources.ts \
  src/tui/actions/register-builtins.ts src/tui/app.tsx src/tui/actions/dynamic-sources.test.ts
git commit -m "feat(tui): #275 prompt.* action source (Prompts group)"
```

---

# Phase 4 — Skills

## Task 15: Skill enumeration in core

**Files:**
- Modify: `src/core/runtime-skill-acquisition.ts`
- Test: `src/core/runtime-skill-acquisition.test.ts` (exists — add case)

- [ ] **Step 1: Write the failing test**

Add a case asserting `listAvailableSkills()` returns bundled skill names
(enumerated from `skills/grove/*`) plus any provided topology skills, de-duped.

```ts
test("listAvailableSkills enumerates bundled + topology skills (deduped)", async () => {
  const svc = createRuntimeSkillAcquisitionService(/* existing test deps */);
  const skills = await svc.listAvailableSkills(["custom-role-skill"]);
  expect(skills.map((s) => s.name)).toContain("custom-role-skill");
  expect(new Set(skills.map((s) => s.name)).size).toBe(skills.length); // deduped
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/core/runtime-skill-acquisition.test.ts`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement `listAvailableSkills`**

Add to the service in `src/core/runtime-skill-acquisition.ts`:

```ts
export interface AvailableSkill {
  readonly name: string;
  readonly source: "bundled" | "topology" | "catalog";
}

// inside the service object/class:
async listAvailableSkills(topologySkills: readonly string[] = []): Promise<readonly AvailableSkill[]> {
  const bundled = await listBundledSkillNames(); // read skills/grove/* dir stems
  const seen = new Set<string>();
  const out: AvailableSkill[] = [];
  for (const name of bundled) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "bundled" });
  }
  for (const name of topologySkills) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "topology" });
  }
  return out;
}
```

Implement `listBundledSkillNames()` by reading the bundled skills directory the
existing resolver already references (reuse its path constant — do not hardcode a
new one).

- [ ] **Step 4: Run focused test + commit**

```bash
bun run typecheck && bun run check
git add src/core/runtime-skill-acquisition.ts src/core/runtime-skill-acquisition.test.ts
git commit -m "feat(core): #275 listAvailableSkills (bundled + topology)"
```

---

## Task 16: Provider skill listing

**Files:**
- Modify: `src/tui/provider.ts` (`TuiSkillProvider`, capability)
- Modify: `src/tui/nexus-provider.ts`, `src/tui/local-provider.ts`,
  `src/tui/store-backed-provider.ts`, `src/tui/remote-provider.ts`,
  `src/tui/provider-shared.ts`
- Test: `src/tui/local-provider.test.ts`

- [ ] **Step 1: Add the interface + capability**

```ts
export interface SkillInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly roles?: readonly string[] | undefined;
}
export interface TuiSkillProvider {
  listAvailableSkills(): Promise<readonly SkillInfo[]>;
}
```

Add `readonly skills: boolean;` to `ProviderCapabilities` and set
`skills: false` on every existing capabilities literal
(`src/tui/store-backed-provider.ts`, `src/tui/remote-provider.ts`,
`src/tui/provider-shared.ts`, `src/tui/nexus-provider.ts` — `bun run typecheck`
finds them).

- [ ] **Step 2: Write the failing conformance test**

In `src/tui/local-provider.test.ts`, assert the provider returns skill names and
reports `capabilities.skills === true`.

- [ ] **Step 3: Run to verify it fails → implement → verify pass**

[focused-test] `src/tui/local-provider.test.ts` (FAIL first). Implement
`listAvailableSkills` in `src/tui/local-provider.ts` and `src/tui/nexus-provider.ts`
by delegating to the core `listAvailableSkills` (Task 15), passing the active
topology's role skills. Re-run: PASS.

- [ ] **Step 4: Commit**

```bash
bun run typecheck && bun run check
git add src/tui/provider.ts src/tui/local-provider.ts src/tui/nexus-provider.ts \
  src/tui/store-backed-provider.ts src/tui/remote-provider.ts src/tui/provider-shared.ts \
  src/tui/local-provider.test.ts
git commit -m "feat(tui): #275 TuiSkillProvider.listAvailableSkills + capability"
```

---

## Task 17: Slot-scoped `skill.request.*` source

**Files:**
- Modify: `src/tui/actions/types.ts` (`availableSkills`, `selectedAgentRole`, `requestSkill`)
- Modify: `src/tui/actions/dynamic-sources.ts` (`skillSource`)
- Modify: `src/tui/actions/register-builtins.ts`
- Modify: `src/tui/app.tsx` (fetch skills; derive selected role; wire `requestSkill`)
- Test: `src/tui/actions/dynamic-sources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { skillSource } from "./dynamic-sources.js";

test("skillSource scopes to the selected agent's role skills", () => {
  const ctx = baseCtx({
    selectedSession: "s1",
    selectedAgentRole: "reviewer",
    availableSkills: [
      { name: "code-review", roles: ["reviewer"] },
      { name: "writing", roles: ["author"] },
    ],
  });
  expect(skillSource(ctx).map((a) => a.id)).toEqual(["skill.request.code-review"]);
});

test("skillSource is empty without a selected session", () => {
  expect(skillSource(baseCtx({ availableSkills: [{ name: "x" }] }))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

[focused-test] `src/tui/actions/dynamic-sources.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `ActionContext`**

```ts
  readonly availableSkills?: readonly import("../provider.js").SkillInfo[] | undefined;
  readonly selectedAgentRole?: string | undefined;
  readonly requestSkill: (skillName: string, session: string) => void;
```

- [ ] **Step 4: Implement `skillSource`**

```ts
export const skillSource: DynamicSource = (ctx) => {
  if (ctx.selectedSession === undefined) return [];
  const role = ctx.selectedAgentRole;
  return (ctx.availableSkills ?? [])
    .filter((s) => role === undefined || s.roles === undefined || s.roles.includes(role))
    .map((s) => ({
      id: `skill.request.${s.name}`,
      label: `Request skill: ${s.name}`,
      detail: s.description ?? "skill",
      group: "Skills" as const,
      slash: `/skill ${s.name}`,
      keywords: ["skill", "request", s.name],
      available: (c) => c.selectedSession !== undefined,
      run: (c) => {
        if (c.selectedSession) c.requestSkill(s.name, c.selectedSession);
      },
    }));
};
```

Register: `registry.registerDynamic("skill.request.", skillSource);`

- [ ] **Step 5: Wire app.tsx**

- Fetch skills when the palette opens (if `capabilities.skills`) → state →
  `actionContext.availableSkills`.
- Derive `selectedAgentRole` from `selectedSession` via the active topology
  (session → agent → role lookup already available in app state).
- `requestSkill(name, session)` calls the existing `grove_request_skill` path
  (via provider/MCP) — reuse the runtime-skill request flow; do not invent a new
  transport.

- [ ] **Step 6: Run full suite + commit**

```bash
bun run typecheck && bun run check && bun test
git add src/tui/actions/types.ts src/tui/actions/dynamic-sources.ts \
  src/tui/actions/register-builtins.ts src/tui/app.tsx src/tui/actions/dynamic-sources.test.ts
git commit -m "feat(tui): #275 slot-scoped skill.request.* action source (Skills group)"
```

---

## Final verification

- [ ] **Run the whole suite + typecheck + lint:**

```bash
bun run typecheck && bun run check && bun test
```
Expected: all PASS, coverage thresholds met.

- [ ] **Manual smoke (per the grove TUI E2E recipe):** launch the TUI, confirm
  (1) palette shows keybinds + suggested-first + greyed reasons; (2) a remapped
  key in `.grove/keybindings.json` updates both dispatch and the palette column;
  (3) leader `space` shows the pending-chord overlay and times out after 2s;
  (4) `/` opens the slash-filtered palette and `:` opens the command line, `/spawn <role>`
  works; (5) Prompts group lists `prompts/` entries and delivers to the selected
  agent via ACP/IPC; (6) Skills group is scoped to the selected agent's role.

- [ ] **Open the PR** referencing #275 and listing the four phases.

---

## Self-Review notes (filled by plan author)

- **Spec coverage:** registry API (T2), keybind bridge + retire switch (T4/T5),
  leader 2s modal + overlay (T6/T8), palette cheatsheet + reason (T7), both slash
  surfaces (T10/T11), Grove MCP prompts (T12–T14), slot-scoped skills (T15–T17),
  error handling (dispatch `.catch(showError)`, unknown-slash footer, missing
  capability → empty source), graceful degradation — all mapped.
- **Inline docks (#193):** intentionally not a task — spec §8 marks it a light
  touch / non-goal; the agent-interaction actions already exist as workflow
  actions and are registered, so docks can consume them later.
- **Type consistency:** `DynamicSource` defined once in `types.ts`; registry id
  strings in `keymap-action-map.ts` (T4) must match the action ids created in
  T3/T5 — the implementer keeps them in sync (note in T4).
