# TUI Registry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable string panel IDs and a typed TUI registry foundation so built-in panels and future plugin panels can share one registry boundary.

**Architecture:** Keep existing numeric `Panel` constants for current focus and rendering internals, but introduce string IDs at config/plugin boundaries. Add a pure plugin registry model that can merge built-in entries with plugin registrations, and adapt existing panel registry helpers so built-in panel definitions expose stable IDs and can be queried through injectable registries.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, React/OpenTUI types, `bun:test`, Biome.

---

## File Structure

- Create `src/tui/panels/panel-ids.ts`: built-in panel string IDs and conversion helpers between `Panel` and string IDs.
- Create `src/tui/panels/panel-ids.test.ts`: pure tests for ID stability and conversions.
- Create `src/tui/plugins/types.ts`: public TUI plugin/slot/context types; no loading behavior.
- Create `src/tui/plugins/registry.ts`: pure merge/validation helpers for built-in registry entries plus plugin registrations.
- Create `src/tui/plugins/registry.test.ts`: pure tests for duplicate handling, invalid IDs, ordering, and diagnostics.
- Modify `src/tui/panels/panel-registry.ts`: add built-in IDs, slot metadata, string-ID preset helpers, injectable registry query helpers, and built-in-to-TUI-entry conversion.
- Modify `src/tui/panels/panel-registry.test.ts`: add tests for stable IDs, built-in registry entries, string-ID preset filters, and injectable helper behavior.
- Modify `src/tui/panels/panel-manager.tsx`: use stable string IDs for row keys so render identity no longer depends on numeric enum values.

## Task 1: Built-In Panel ID Map

**Files:**
- Create: `src/tui/panels/panel-ids.test.ts`
- Create: `src/tui/panels/panel-ids.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/panels/panel-ids.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import {
  BUILT_IN_PANEL_IDS,
  CORE_PANEL_IDS,
  OPERATOR_PANEL_IDS,
  PanelId,
  idToPanel,
  panelToId,
} from "./panel-ids.js";

describe("panel IDs", () => {
  test("keeps stable string IDs for all built-in panels", () => {
    expect(PanelId.Dag).toBe("dag");
    expect(PanelId.Detail).toBe("detail");
    expect(PanelId.Frontier).toBe("frontier");
    expect(PanelId.Claims).toBe("claims");
    expect(PanelId.AgentList).toBe("agents");
    expect(PanelId.Terminal).toBe("terminal");
    expect(PanelId.Artifact).toBe("artifact");
    expect(PanelId.Vfs).toBe("vfs");
    expect(PanelId.Activity).toBe("activity");
    expect(PanelId.Search).toBe("search");
    expect(PanelId.Threads).toBe("threads");
    expect(PanelId.Outcomes).toBe("outcomes");
    expect(PanelId.Bounties).toBe("bounties");
    expect(PanelId.Gossip).toBe("gossip");
    expect(PanelId.Inbox).toBe("inbox");
    expect(PanelId.Decisions).toBe("decisions");
    expect(PanelId.GitHub).toBe("github");
    expect(PanelId.Plan).toBe("plan");
  });

  test("converts numeric Panel values to stable string IDs", () => {
    expect(panelToId(Panel.Dag)).toBe(PanelId.Dag);
    expect(panelToId(Panel.AgentList)).toBe(PanelId.AgentList);
    expect(panelToId(Panel.GitHub)).toBe(PanelId.GitHub);
  });

  test("converts stable string IDs back to numeric Panel values", () => {
    expect(idToPanel("dag")).toBe(Panel.Dag);
    expect(idToPanel("agents")).toBe(Panel.AgentList);
    expect(idToPanel("github")).toBe(Panel.GitHub);
  });

  test("returns undefined for unknown string IDs", () => {
    expect(idToPanel("missing")).toBeUndefined();
    expect(idToPanel("bad/id")).toBeUndefined();
  });

  test("exports ordered built-in, core, and operator ID lists", () => {
    expect(CORE_PANEL_IDS).toEqual(["dag", "detail", "frontier", "claims"]);
    expect(OPERATOR_PANEL_IDS[0]).toBe("agents");
    expect(OPERATOR_PANEL_IDS[OPERATOR_PANEL_IDS.length - 1]).toBe("plan");
    expect(BUILT_IN_PANEL_IDS).toEqual([...CORE_PANEL_IDS, ...OPERATOR_PANEL_IDS]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test src/tui/panels/panel-ids.test.ts
```

Expected: FAIL because `src/tui/panels/panel-ids.ts` does not exist.

- [ ] **Step 3: Add the panel ID implementation**

Create `src/tui/panels/panel-ids.ts`:

```ts
import { CORE_PANELS, OPERATOR_PANELS, type Panel, Panel } from "../hooks/use-panel-focus.js";

export const PanelId = {
  Dag: "dag",
  Detail: "detail",
  Frontier: "frontier",
  Claims: "claims",
  AgentList: "agents",
  Terminal: "terminal",
  Artifact: "artifact",
  Vfs: "vfs",
  Activity: "activity",
  Search: "search",
  Threads: "threads",
  Outcomes: "outcomes",
  Bounties: "bounties",
  Gossip: "gossip",
  Inbox: "inbox",
  Decisions: "decisions",
  GitHub: "github",
  Plan: "plan",
} as const;

export type BuiltInPanelId = (typeof PanelId)[keyof typeof PanelId];

const PANEL_TO_ID: Readonly<Record<Panel, BuiltInPanelId>> = {
  [Panel.Dag]: PanelId.Dag,
  [Panel.Detail]: PanelId.Detail,
  [Panel.Frontier]: PanelId.Frontier,
  [Panel.Claims]: PanelId.Claims,
  [Panel.AgentList]: PanelId.AgentList,
  [Panel.Terminal]: PanelId.Terminal,
  [Panel.Artifact]: PanelId.Artifact,
  [Panel.Vfs]: PanelId.Vfs,
  [Panel.Activity]: PanelId.Activity,
  [Panel.Search]: PanelId.Search,
  [Panel.Threads]: PanelId.Threads,
  [Panel.Outcomes]: PanelId.Outcomes,
  [Panel.Bounties]: PanelId.Bounties,
  [Panel.Gossip]: PanelId.Gossip,
  [Panel.Inbox]: PanelId.Inbox,
  [Panel.Decisions]: PanelId.Decisions,
  [Panel.GitHub]: PanelId.GitHub,
  [Panel.Plan]: PanelId.Plan,
};

const ID_TO_PANEL = new Map<BuiltInPanelId, Panel>(
  Object.entries(PANEL_TO_ID).map(([panel, id]) => [id, Number(panel) as Panel]),
);

export const CORE_PANEL_IDS: readonly BuiltInPanelId[] = CORE_PANELS.map((panel) => PANEL_TO_ID[panel]);
export const OPERATOR_PANEL_IDS: readonly BuiltInPanelId[] = OPERATOR_PANELS.map(
  (panel) => PANEL_TO_ID[panel],
);
export const BUILT_IN_PANEL_IDS: readonly BuiltInPanelId[] = [
  ...CORE_PANEL_IDS,
  ...OPERATOR_PANEL_IDS,
];

export function panelToId(panel: Panel): BuiltInPanelId {
  return PANEL_TO_ID[panel];
}

export function idToPanel(id: string): Panel | undefined {
  return ID_TO_PANEL.get(id as BuiltInPanelId);
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
bun test src/tui/panels/panel-ids.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/panels/panel-ids.ts src/tui/panels/panel-ids.test.ts
git commit -m "feat(tui): add stable built-in panel ids"
```

## Task 2: TUI Plugin Registry Types And Merge Helper

**Files:**
- Create: `src/tui/plugins/types.ts`
- Create: `src/tui/plugins/registry.ts`
- Create: `src/tui/plugins/registry.test.ts`

- [ ] **Step 1: Write the failing registry tests**

Create `src/tui/plugins/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import type { TuiPanelRegistration } from "./types.js";
import { mergeTuiRegistrations, type TuiRegistryEntry } from "./registry.js";

const NullPanel = () => null;

function builtIn(id: string, order: number, panel: Panel): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot: "operator-panel",
    order,
    source: "builtin",
    builtInPanel: panel,
  };
}

function plugin(id: string, order?: number): TuiPanelRegistration {
  return {
    id,
    label: id,
    slot: "operator-panel",
    ...(order === undefined ? {} : { order }),
    component: NullPanel,
  };
}

describe("mergeTuiRegistrations", () => {
  test("orders built-in and plugin entries by order then id", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag), builtIn("claims", 30, Panel.Claims)],
      plugins: [plugin("eval-results", 20), plugin("audit-feed", 20)],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "dag",
      "audit-feed",
      "eval-results",
      "claims",
    ]);
  });

  test("skips plugin entries that duplicate built-in IDs", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("dag", 20)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag"]);
    expect(result.diagnostics).toEqual([
      {
        id: "dag",
        severity: "error",
        message: "Duplicate TUI panel id: dag",
      },
    ]);
  });

  test("skips plugin entries with unsafe IDs", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("bad/id", 20), plugin("UpperCase", 30)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag"]);
    expect(result.diagnostics).toEqual([
      {
        id: "bad/id",
        severity: "error",
        message: "Invalid TUI panel id: bad/id",
      },
      {
        id: "UpperCase",
        severity: "error",
        message: "Invalid TUI panel id: UpperCase",
      },
    ]);
  });

  test("uses default plugin order after built-ins when order is omitted", () => {
    const result = mergeTuiRegistrations({
      builtIns: [builtIn("dag", 10, Panel.Dag)],
      plugins: [plugin("eval-results")],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["dag", "eval-results"]);
    expect(result.entries[1]?.order).toBe(1000);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test src/tui/plugins/registry.test.ts
```

Expected: FAIL because `src/tui/plugins/types.ts` and `src/tui/plugins/registry.ts` do not exist.

- [ ] **Step 3: Add public plugin types**

Create `src/tui/plugins/types.ts`:

```ts
import type React from "react";
import type { AgentTopology } from "../../core/topology.js";
import type { TuiDataProvider } from "../provider.js";

export type TuiSlot =
  | "operator-panel"
  | "dashboard"
  | "detail-adjacent"
  | "footer"
  | "command-palette";

export interface TuiPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly slots: readonly TuiSlot[];
}

export interface TuiPluginContext {
  readonly provider: TuiDataProvider;
  readonly topology?: AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
}

export interface TuiPanelRegistration {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly defaultVisible?: boolean | undefined;
  readonly order?: number | undefined;
  readonly component: React.ComponentType<TuiPluginContext>;
}
```

- [ ] **Step 4: Add pure registry merge implementation**

Create `src/tui/plugins/registry.ts`:

```ts
import type { Panel } from "../hooks/use-panel-focus.js";
import type { TuiPanelRegistration, TuiSlot } from "./types.js";

const DEFAULT_PLUGIN_ORDER = 1000;
const SAFE_PANEL_ID = /^[a-z][a-z0-9.-]*$/;

export interface TuiRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly order: number;
  readonly source: "builtin" | "plugin";
  readonly builtInPanel?: Panel | undefined;
  readonly registration?: TuiPanelRegistration | undefined;
}

export interface TuiRegistryDiagnostic {
  readonly id: string;
  readonly severity: "error";
  readonly message: string;
}

export interface MergeTuiRegistrationsInput {
  readonly builtIns: readonly TuiRegistryEntry[];
  readonly plugins?: readonly TuiPanelRegistration[] | undefined;
}

export interface MergeTuiRegistrationsResult {
  readonly entries: readonly TuiRegistryEntry[];
  readonly diagnostics: readonly TuiRegistryDiagnostic[];
}

export function isSafeTuiPanelId(id: string): boolean {
  return SAFE_PANEL_ID.test(id);
}

export function mergeTuiRegistrations(
  input: MergeTuiRegistrationsInput,
): MergeTuiRegistrationsResult {
  const entries: TuiRegistryEntry[] = [];
  const diagnostics: TuiRegistryDiagnostic[] = [];
  const seen = new Set<string>();

  for (const entry of input.builtIns) {
    if (!isSafeTuiPanelId(entry.id)) {
      throw new Error(`Built-in TUI panel has invalid id: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Built-in TUI panel id is duplicated: ${entry.id}`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  for (const registration of input.plugins ?? []) {
    if (!isSafeTuiPanelId(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Invalid TUI panel id: ${registration.id}`,
      });
      continue;
    }
    if (seen.has(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Duplicate TUI panel id: ${registration.id}`,
      });
      continue;
    }
    seen.add(registration.id);
    entries.push({
      id: registration.id,
      label: registration.label,
      slot: registration.slot,
      order: registration.order ?? DEFAULT_PLUGIN_ORDER,
      source: "plugin",
      registration,
    });
  }

  entries.sort((a, b) => {
    const orderDelta = a.order - b.order;
    if (orderDelta !== 0) return orderDelta;
    const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDelta !== 0) return sourceDelta;
    return a.id.localeCompare(b.id);
  });

  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

function sourceRank(source: "builtin" | "plugin"): number {
  return source === "builtin" ? 0 : 1;
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run:

```bash
bun test src/tui/plugins/registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/plugins/types.ts src/tui/plugins/registry.ts src/tui/plugins/registry.test.ts
git commit -m "feat(tui): add plugin registry foundation"
```

## Task 3: Add Stable IDs To Built-In Panel Registry

**Files:**
- Modify: `src/tui/panels/panel-registry.ts`
- Modify: `src/tui/panels/panel-registry.test.ts`

- [ ] **Step 1: Add failing tests for built-in registry IDs**

Append these tests to `src/tui/panels/panel-registry.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Stable panel IDs
// ---------------------------------------------------------------------------

describe("stable panel IDs", () => {
  it("assigns a stable string id to every built-in panel definition", () => {
    const registry = getRegistry();
    const ids = registry.map((def) => def.id);

    expect(ids).toEqual([
      "dag",
      "detail",
      "frontier",
      "claims",
      "agents",
      "terminal",
      "artifact",
      "vfs",
      "activity",
      "search",
      "threads",
      "outcomes",
      "bounties",
      "gossip",
      "inbox",
      "decisions",
      "github",
      "plan",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks up a built-in panel definition by string id", () => {
    expect(getPanelDefById("dag")?.panel).toBe(Panel.Dag);
    expect(getPanelDefById("agents")?.panel).toBe(Panel.AgentList);
    expect(getPanelDefById("github")?.panel).toBe(Panel.GitHub);
  });

  it("converts built-in panel definitions into TUI registry entries", () => {
    const entries = getBuiltInTuiRegistryEntries();
    expect(entries[0]).toEqual({
      id: "dag",
      label: "DAG",
      slot: "operator-panel",
      order: 0,
      source: "builtin",
      builtInPanel: Panel.Dag,
    });
    expect(entries.at(-1)).toEqual({
      id: "plan",
      label: "Plan",
      slot: "operator-panel",
      order: 17,
      source: "builtin",
      builtInPanel: Panel.Plan,
    });
  });
});
```

Update the import list in the same file to include:

```ts
  getBuiltInTuiRegistryEntries,
  getPanelDefById,
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: FAIL because `PanelDef.id`, `getPanelDefById`, and `getBuiltInTuiRegistryEntries` do not exist.

- [ ] **Step 3: Modify the panel registry types and imports**

In `src/tui/panels/panel-registry.ts`, add these imports:

```ts
import type { TuiRegistryEntry } from "../plugins/registry.js";
import { panelToId, type BuiltInPanelId } from "./panel-ids.js";
```

Replace the `PanelDef` interface with this base/interface split:

```ts
interface PanelDefBase {
  readonly panel: Panel;
  readonly label: string;
  readonly rowGroup: number;
  readonly kind: "core" | "operator";
  readonly rowPartners?: readonly Panel[];
  readonly keybinding: string;
}

export interface PanelDef extends PanelDefBase {
  readonly id: BuiltInPanelId;
  readonly slot: "operator-panel";
}
```

- [ ] **Step 4: Build `PANEL_REGISTRY` from a base registry**

Rename the existing `PANEL_REGISTRY` declaration to `PANEL_REGISTRY_BASE` and change its type:

```ts
const PANEL_REGISTRY_BASE: readonly PanelDefBase[] = [
```

Keep the existing array contents unchanged. After the closing array, add:

```ts
export const PANEL_REGISTRY: readonly PanelDef[] = Object.freeze(
  PANEL_REGISTRY_BASE.map((def) =>
    Object.freeze({
      ...def,
      id: panelToId(def.panel),
      slot: "operator-panel" as const,
    }),
  ),
);
```

Remove the old `export const PANEL_REGISTRY: readonly PanelDef[] = [` declaration so there is only one exported `PANEL_REGISTRY`.

- [ ] **Step 5: Add lookup and built-in entry helpers**

Add these functions after `getRegistry()`:

```ts
export function getPanelDefById(id: BuiltInPanelId): PanelDef | undefined {
  return PANEL_REGISTRY.find((def) => def.id === id);
}

export function getBuiltInTuiRegistryEntries(): readonly TuiRegistryEntry[] {
  return PANEL_REGISTRY.map((def, order) => ({
    id: def.id,
    label: def.label,
    slot: def.slot,
    order,
    source: "builtin",
    builtInPanel: def.panel,
  }));
}
```

- [ ] **Step 6: Run the focused tests to verify they pass**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/panels/panel-registry.ts src/tui/panels/panel-registry.test.ts
git commit -m "feat(tui): expose built-in panel registry ids"
```

## Task 4: Add String-ID Preset Filters

**Files:**
- Modify: `src/tui/panels/panel-registry.ts`
- Modify: `src/tui/panels/panel-registry.test.ts`

- [ ] **Step 1: Add failing tests for preset panel IDs**

Append these tests to `src/tui/panels/panel-registry.test.ts`:

```ts
// ---------------------------------------------------------------------------
// getPresetPanelIds()
// ---------------------------------------------------------------------------

describe("getPresetPanelIds", () => {
  it("returns stable string IDs for review-loop", () => {
    expect([...(getPresetPanelIds("review-loop") ?? [])]).toEqual([
      "dag",
      "detail",
      "claims",
      "terminal",
    ]);
  });

  it("returns stable string IDs for swarm-ops", () => {
    expect([...(getPresetPanelIds("swarm-ops") ?? [])]).toEqual([
      "dag",
      "detail",
      "claims",
      "terminal",
      "frontier",
      "outcomes",
      "bounties",
    ]);
  });

  it("returns undefined for unknown preset", () => {
    expect(getPresetPanelIds("unknown-preset")).toBeUndefined();
  });
});
```

Update the import list in the same file to include:

```ts
  getPresetPanelIds,
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: FAIL because `getPresetPanelIds` does not exist.

- [ ] **Step 3: Add string-ID preset filter data**

In `src/tui/panels/panel-registry.ts`, add `PanelId` to the existing panel ID import:

```ts
import { PanelId, panelToId, type BuiltInPanelId } from "./panel-ids.js";
```

After `PRESET_PANELS`, add:

```ts
export const PRESET_PANEL_IDS: Readonly<Record<string, ReadonlySet<BuiltInPanelId>>> = {
  "review-loop": new Set([PanelId.Dag, PanelId.Detail, PanelId.Claims, PanelId.Terminal]),
  "swarm-ops": new Set([
    PanelId.Dag,
    PanelId.Detail,
    PanelId.Claims,
    PanelId.Terminal,
    PanelId.Frontier,
    PanelId.Outcomes,
    PanelId.Bounties,
  ]),
  "federated-swarm": new Set([
    PanelId.Dag,
    PanelId.Detail,
    PanelId.Claims,
    PanelId.Terminal,
    PanelId.Frontier,
    PanelId.Gossip,
  ]),
};

export function getPresetPanelIds(
  presetName?: string,
): ReadonlySet<BuiltInPanelId> | undefined {
  if (!presetName) return undefined;
  return PRESET_PANEL_IDS[presetName];
}
```

Keep `PRESET_PANELS` and `getPresetPanels()` unchanged for existing callers.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/panels/panel-registry.ts src/tui/panels/panel-registry.test.ts
git commit -m "feat(tui): add preset panel id filters"
```

## Task 5: Make Registry Query Helpers Accept Injected Registries

**Files:**
- Modify: `src/tui/panels/panel-registry.ts`
- Modify: `src/tui/panels/panel-registry.test.ts`

- [ ] **Step 1: Add failing tests for injected registry helpers**

Append these tests to `src/tui/panels/panel-registry.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Injectable registry helpers
// ---------------------------------------------------------------------------

describe("injectable registry helpers", () => {
  it("groups an injected registry instead of always reading PANEL_REGISTRY", () => {
    const registry = getRegistry().filter((def) => def.id === "claims");
    const groups = getRowGroups(registry);
    expect(groups.size).toBe(1);
    expect(groups.get(2)?.map((def) => def.id)).toEqual(["claims"]);
  });

  it("computes visible panels from an injected registry", () => {
    const registry = getRegistry().filter((def) => def.id === "dag" || def.id === "claims");
    const visible = getVisiblePanelsForLayout(initialPanelState(), "grid", undefined, registry);
    expect(visible.map((def) => def.id)).toEqual(["dag", "claims"]);
  });

  it("computes active panels from an injected registry", () => {
    const registry = getRegistry().filter((def) => def.id === "dag" || def.id === "claims");
    const active = getActivePanelsForLayout(initialPanelState(), "grid", registry);
    expect([...active]).toEqual([Panel.Dag, Panel.Claims]);
  });
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: FAIL because `getRowGroups`, `getVisiblePanelsForLayout`, and `getActivePanelsForLayout` do not accept injected registries yet.

- [ ] **Step 3: Update `getRowGroups`**

Replace the `getRowGroups()` signature and first lines with:

```ts
export function getRowGroups(registry: readonly PanelDef[] = PANEL_REGISTRY): Map<number, readonly PanelDef[]> {
  const groups = new Map<number, PanelDef[]>();
  for (const def of registry) {
    let group = groups.get(def.rowGroup);
    if (group === undefined) {
      group = [];
      groups.set(def.rowGroup, group);
    }
    group.push(def);
  }
  return groups;
}
```

- [ ] **Step 4: Update `getVisiblePanelsForLayout`**

Replace the function signature and registry reference with:

```ts
export function getVisiblePanelsForLayout(
  panelState: PanelFocusState,
  mode: LayoutMode,
  allowedPanels?: ReadonlySet<Panel>,
  registry: readonly PanelDef[] = PANEL_REGISTRY,
): readonly PanelDef[] {
  if (mode === "tab") {
    const def = registry.find((d) => d.panel === panelState.focused);
    return def !== undefined ? [def] : [];
  }

  return registry.filter(
    (def) =>
      isPanelVisible(panelState, def.panel) &&
      (allowedPanels === undefined || allowedPanels.has(def.panel)),
  );
}
```

- [ ] **Step 5: Update `getActivePanelsForLayout`**

Replace the function signature and registry loop with:

```ts
export function getActivePanelsForLayout(
  panelState: PanelFocusState,
  mode: LayoutMode,
  registry: readonly PanelDef[] = PANEL_REGISTRY,
): ReadonlySet<Panel> {
  if (mode === "tab") {
    return new Set([panelState.focused]);
  }

  const active = new Set<Panel>();
  for (const def of registry) {
    if (isPanelVisible(panelState, def.panel)) {
      active.add(def.panel);
    }
  }
  return active;
}
```

- [ ] **Step 6: Run the focused tests to verify they pass**

Run:

```bash
bun test src/tui/panels/panel-registry.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/panels/panel-registry.ts src/tui/panels/panel-registry.test.ts
git commit -m "feat(tui): allow injected panel registries"
```

## Task 6: Use Stable IDs In PanelManager Row Rendering

**Files:**
- Modify: `src/tui/panels/panel-manager.tsx`

- [ ] **Step 1: Make render keys use string IDs**

In `src/tui/panels/panel-manager.tsx`, locate the row rendering block near the end of the component and change the `PanelChrome` key from:

```tsx
<PanelChrome key={def.panel} panel={def.panel} focused={isFocused(def.panel)}>
```

to:

```tsx
<PanelChrome key={def.id} panel={def.panel} focused={isFocused(def.panel)}>
```

- [ ] **Step 2: Run targeted typecheck through the existing package command**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/panels/panel-manager.tsx
git commit -m "refactor(tui): key panel rows by stable ids"
```

## Task 7: Full Verification

**Files:**
- Verify only; no file changes expected.

- [ ] **Step 1: Run focused TUI registry tests**

Run:

```bash
bun test src/tui/panels/panel-ids.test.ts src/tui/plugins/registry.test.ts src/tui/panels/panel-registry.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Confirm verification did not modify files**

Run:

```bash
git status --short
```

Expected: no output. If output appears, stop and inspect the changed files because
verification for this task should not modify the working tree.

## Self-Review

- **Spec coverage:** This plan covers Track 1 from the approved design: stable string IDs, pure TUI registry types, duplicate ID diagnostics, preset filtering by string ID, built-in registry entry conversion, injectable registry query helpers, and render keys based on stable IDs.
- **Out of scope by design:** Dynamic local plugin loading, plugin component rendering, layout config, scroll anchoring, agent identity UX, collaboration protocol models, recipes, memory, and distributions each belong to separate implementation plans after this foundation lands.
- **Type consistency:** Built-in string IDs use `BuiltInPanelId`; public plugin IDs use `string` validated by `isSafeTuiPanelId`; existing focus/render code still uses numeric `Panel`; registry entries bridge both shapes through optional `builtInPanel`.
