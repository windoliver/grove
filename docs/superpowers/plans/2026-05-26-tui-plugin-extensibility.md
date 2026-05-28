# TUI Plugin Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trusted local-code TUI extension surface so callers can register custom default-visible panels and custom command palette actions without editing core workflow-specific TUI code.

**Architecture:** Extend the existing `src/tui/plugins/` registry foundation with action registrations and extension bundles, then wire `App`, `CommandPalette`, and `PanelManager` to consume merged registries. Built-ins remain first-class and unchanged when no extensions are passed; plugin mistakes produce diagnostics and skipped entries.

**Tech Stack:** Bun 1.3.x, bun:test, TypeScript strict mode, React/OpenTUI, Biome.

---

## File Structure

- Modify `src/tui/plugins/types.ts`: public `TuiExtension`, `TuiActionRegistration`, and `showMessage` context field.
- Modify `src/tui/plugins/registry.ts`: shared ID validation, panel registration collection, action registration collection, and action merge helper.
- Modify `src/tui/plugins/registry.test.ts`: tests for extension collection and action registry behavior.
- Create `src/tui/plugins/actions.ts`: small action execution helper used by `App`.
- Create `src/tui/plugins/actions.test.ts`: tests for action callback execution and failure propagation.
- Modify `src/tui/components/command-palette.tsx`: add plugin-action palette item kind, built-in fixed action registry entries, and plugin action item builder.
- Create `src/tui/components/command-palette.test.tsx`: tests for plugin action palette item projection.
- Create `src/tui/panels/plugin-panels.ts`: pure helper selecting default-visible plugin operator panels.
- Create `src/tui/panels/plugin-panels.test.ts`: tests for plugin panel visibility selection.
- Modify `src/tui/panels/panel-manager.tsx`: render default-visible plugin panels with normal panel chrome.
- Modify `src/tui/app.tsx`: accept `extensions`, merge panel/action registries, build `TuiPluginContext`, pass plugin panel entries to `PanelManager`, append plugin actions to palette items, and execute plugin actions.
- Create `docs/tui/tui-extensions.md`: extension author guide with examples and safety notes.

## Test Command Pattern

Partial `bun test` runs inherit coverage thresholds from `bunfig.toml`. Use this focused-test wrapper for red/green steps unless the step explicitly says to run full verification:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/registry.test.ts
rm "$tmp"
```

### Task 1: Extend Plugin Types and Registries

**Files:**
- Modify: `src/tui/plugins/types.ts`
- Modify: `src/tui/plugins/registry.ts`
- Test: `src/tui/plugins/registry.test.ts`

- [ ] **Step 1: Write the failing registry tests**

Extend `src/tui/plugins/registry.test.ts` with action and extension coverage. Keep the existing panel tests, replace the current imports with these imports, then add the helpers and test blocks.

```ts
import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import {
  collectTuiActionRegistrations,
  collectTuiPanelRegistrations,
  mergeTuiRegistrations,
  mergeTuiActionRegistrations,
  type TuiActionRegistryEntry,
  type TuiRegistryEntry,
} from "./registry.js";
import type {
  TuiActionRegistration,
  TuiExtension,
  TuiPanelRegistration,
} from "./types.js";

function builtInAction(id: string, order: number): TuiActionRegistryEntry {
  return {
    id,
    label: id,
    detail: `${id} detail`,
    order,
    source: "builtin",
    builtInAction: id,
  };
}

function action(id: string, order?: number): TuiActionRegistration {
  return {
    id,
    label: id,
    detail: `${id} detail`,
    ...(order === undefined ? {} : { order }),
    run: () => undefined,
  };
}

describe("TuiExtension collection", () => {
  test("flattens panel and action registrations from extensions", () => {
    const panel = plugin("audit-panel", 20);
    const refresh = action("audit-refresh", 30);
    const extension: TuiExtension = {
      id: "audit",
      name: "Audit",
      version: "1.0.0",
      panels: [panel],
      actions: [refresh],
    };

    expect(collectTuiPanelRegistrations([extension])).toEqual([panel]);
    expect(collectTuiActionRegistrations([extension])).toEqual([refresh]);
  });

  test("returns empty frozen arrays when extensions are absent", () => {
    expect(collectTuiPanelRegistrations()).toEqual([]);
    expect(collectTuiActionRegistrations()).toEqual([]);
  });
});

describe("mergeTuiActionRegistrations", () => {
  test("orders built-in and plugin action entries by order then id", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10), builtInAction("set-goal", 30)],
      plugins: [action("audit-refresh", 20), action("audit-export", 20)],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "register-agent",
      "audit-export",
      "audit-refresh",
      "set-goal",
    ]);
  });

  test("skips plugin actions that duplicate built-in action IDs", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("register-agent", 20)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["register-agent"]);
    expect(result.diagnostics).toEqual([
      {
        id: "register-agent",
        severity: "error",
        message: "Duplicate TUI action id: register-agent",
      },
    ]);
  });

  test("skips plugin actions with unsafe IDs", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("bad/id", 20), action("UpperCase", 30)],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual(["register-agent"]);
    expect(result.diagnostics).toEqual([
      {
        id: "bad/id",
        severity: "error",
        message: "Invalid TUI action id: bad/id",
      },
      {
        id: "UpperCase",
        severity: "error",
        message: "Invalid TUI action id: UpperCase",
      },
    ]);
  });

  test("uses default plugin action order 1000 when order is omitted", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [action("audit-refresh")],
    });

    expect(result.entries.map((entry) => [entry.id, entry.order])).toEqual([
      ["register-agent", 10],
      ["audit-refresh", 1000],
    ]);
  });

  test("uses default action order and reports diagnostics for invalid orders", () => {
    const result = mergeTuiActionRegistrations({
      builtIns: [builtInAction("register-agent", 10)],
      plugins: [
        action("nan-action", Number.NaN),
        action("infinite-action", Number.POSITIVE_INFINITY),
      ],
    });

    expect(result.entries.map((entry) => [entry.id, entry.order])).toEqual([
      ["register-agent", 10],
      ["infinite-action", 1000],
      ["nan-action", 1000],
    ]);
    expect(result.diagnostics).toEqual([
      {
        id: "nan-action",
        severity: "error",
        message: "Invalid TUI action order for nan-action; using default order 1000",
      },
      {
        id: "infinite-action",
        severity: "error",
        message: "Invalid TUI action order for infinite-action; using default order 1000",
      },
    ]);
  });

  test("throws when built-in action IDs are unsafe or duplicated", () => {
    expect(() =>
      mergeTuiActionRegistrations({
        builtIns: [builtInAction("bad/id", 10)],
      }),
    ).toThrow("Built-in TUI action has invalid id: bad/id");

    expect(() =>
      mergeTuiActionRegistrations({
        builtIns: [builtInAction("register-agent", 10), builtInAction("register-agent", 20)],
      }),
    ).toThrow("Built-in TUI action id is duplicated: register-agent");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/registry.test.ts
rm "$tmp"
```

Expected: FAIL with missing exports for `collectTuiActionRegistrations`, `collectTuiPanelRegistrations`, `mergeTuiActionRegistrations`, `TuiActionRegistryEntry`, `TuiActionRegistration`, and `TuiExtension`.

- [ ] **Step 3: Add the plugin types**

Modify `src/tui/plugins/types.ts` so the public contracts include action registrations and extension bundles. Keep the existing exports and add these fields/types.

```ts
export interface TuiPluginContext {
  readonly provider: TuiDataProvider;
  readonly topology?: AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
  readonly showMessage: (message: string) => void;
}

export interface TuiPanelRegistration {
  readonly id: string;
  readonly label: string;
  readonly slot: TuiSlot;
  readonly defaultVisible?: boolean | undefined;
  readonly order?: number | undefined;
  readonly component: React.ComponentType<TuiPluginContext>;
}

export interface TuiActionRegistration {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly order?: number | undefined;
  readonly enabled?: ((context: TuiPluginContext) => boolean) | undefined;
  readonly run: (context: TuiPluginContext) => void | Promise<void>;
}

export interface TuiExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly panels?: readonly TuiPanelRegistration[] | undefined;
  readonly actions?: readonly TuiActionRegistration[] | undefined;
}
```

- [ ] **Step 4: Add action registry helpers**

Modify `src/tui/plugins/registry.ts`. Keep `TuiRegistryEntry` for panel compatibility, add action entries and extension collectors, and refactor the order helper to accept a kind label.

```ts
import type {
  TuiActionRegistration,
  TuiExtension,
  TuiPanelRegistration,
  TuiSlot,
} from "./types.js";

const DEFAULT_PLUGIN_ORDER = 1000;
const SAFE_TUI_ID = /^[a-z][a-z0-9.-]*$/;

export interface TuiActionRegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly order: number;
  readonly source: "builtin" | "plugin";
  readonly builtInAction?: string | undefined;
  readonly registration?: TuiActionRegistration | undefined;
}

export interface MergeTuiActionRegistrationsInput {
  readonly builtIns: readonly TuiActionRegistryEntry[];
  readonly plugins?: readonly TuiActionRegistration[] | undefined;
}

export interface MergeTuiActionRegistrationsResult {
  readonly entries: readonly TuiActionRegistryEntry[];
  readonly diagnostics: readonly TuiRegistryDiagnostic[];
}

export function isSafeTuiId(id: string): boolean {
  return SAFE_TUI_ID.test(id);
}

export function isSafeTuiPanelId(id: string): boolean {
  return isSafeTuiId(id);
}

export function collectTuiPanelRegistrations(
  extensions?: readonly TuiExtension[] | undefined,
): readonly TuiPanelRegistration[] {
  return Object.freeze((extensions ?? []).flatMap((extension) => extension.panels ?? []));
}

export function collectTuiActionRegistrations(
  extensions?: readonly TuiExtension[] | undefined,
): readonly TuiActionRegistration[] {
  return Object.freeze((extensions ?? []).flatMap((extension) => extension.actions ?? []));
}

export function mergeTuiActionRegistrations(
  input: MergeTuiActionRegistrationsInput,
): MergeTuiActionRegistrationsResult {
  const entries: TuiActionRegistryEntry[] = [];
  const diagnostics: TuiRegistryDiagnostic[] = [];
  const seen = new Set<string>();

  for (const entry of input.builtIns) {
    if (!isSafeTuiId(entry.id)) {
      throw new Error(`Built-in TUI action has invalid id: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`Built-in TUI action id is duplicated: ${entry.id}`);
    }
    seen.add(entry.id);
    entries.push(entry);
  }

  for (const registration of input.plugins ?? []) {
    if (!isSafeTuiId(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Invalid TUI action id: ${registration.id}`,
      });
      continue;
    }
    if (seen.has(registration.id)) {
      diagnostics.push({
        id: registration.id,
        severity: "error",
        message: `Duplicate TUI action id: ${registration.id}`,
      });
      continue;
    }
    seen.add(registration.id);
    const order = resolvePluginOrder(registration.id, registration.order, "action", diagnostics);
    entries.push({
      id: registration.id,
      label: registration.label,
      detail: registration.detail,
      order,
      source: "plugin",
      registration,
    });
  }

  entries.sort(compareRegistryEntries);
  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

function compareRegistryEntries(
  a: { readonly id: string; readonly order: number; readonly source: "builtin" | "plugin" },
  b: { readonly id: string; readonly order: number; readonly source: "builtin" | "plugin" },
): number {
  const orderDelta = a.order - b.order;
  if (orderDelta !== 0) return orderDelta;
  const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
  if (sourceDelta !== 0) return sourceDelta;
  return a.id.localeCompare(b.id);
}

function resolvePluginOrder(
  id: string,
  order: number | undefined,
  kind: "panel" | "action",
  diagnostics: TuiRegistryDiagnostic[],
): number {
  if (order === undefined) return DEFAULT_PLUGIN_ORDER;
  if (Number.isFinite(order)) return order;

  diagnostics.push({
    id,
    severity: "error",
    message: `Invalid TUI ${kind} order for ${id}; using default order ${DEFAULT_PLUGIN_ORDER}`,
  });
  return DEFAULT_PLUGIN_ORDER;
}
```

In the existing `mergeTuiRegistrations`, replace the old inline sort with `entries.sort(compareRegistryEntries)` and call `resolvePluginOrder(registration.id, registration.order, "panel", diagnostics)`.

- [ ] **Step 5: Run registry tests green**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/registry.test.ts
rm "$tmp"
```

Expected: PASS for all `src/tui/plugins/registry.test.ts` tests.

- [ ] **Step 6: Commit registry contracts**

Run:

```bash
git add src/tui/plugins/types.ts src/tui/plugins/registry.ts src/tui/plugins/registry.test.ts
git commit -m "feat(tui): add extension registry contracts"
```

### Task 2: Project Plugin Actions Into Palette Items

**Files:**
- Modify: `src/tui/components/command-palette.tsx`
- Test: `src/tui/components/command-palette.test.tsx`

- [ ] **Step 1: Write failing palette item tests**

Create `src/tui/components/command-palette.test.tsx`.

```tsx
import { describe, expect, mock, test } from "bun:test";
import type { TuiDataProvider } from "../provider.js";
import type { TuiActionRegistration, TuiPluginContext } from "../plugins/types.js";
import { mergeTuiActionRegistrations } from "../plugins/registry.js";
import {
  buildPluginPaletteItems,
  getBuiltInPaletteActionRegistryEntries,
} from "./command-palette.js";

function providerStub(): TuiDataProvider {
  return {
    capabilities: {
      outcomes: false,
      artifacts: false,
      vfs: false,
      messaging: false,
      costTracking: false,
      askUser: false,
      github: false,
      bounties: false,
      gossip: false,
      goals: false,
      sessions: false,
      handoffs: false,
    },
    getDashboard: async () => {
      throw new Error("getDashboard not used");
    },
    getContributions: async () => [],
    getContribution: async () => undefined,
    getClaims: async () => [],
    getFrontier: async () => ({
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    }),
    getActivity: async () => [],
    getDag: async () => ({ contributions: [] }),
    getHotThreads: async () => [],
    close: () => undefined,
  };
}

function context(): TuiPluginContext {
  return {
    provider: providerStub(),
    density: "compact",
    showMessage: () => undefined,
  };
}

function action(overrides: Partial<TuiActionRegistration> = {}): TuiActionRegistration {
  return {
    id: "audit-refresh",
    label: "Refresh audit panel",
    detail: "audit",
    run: () => undefined,
    ...overrides,
  };
}

describe("plugin palette items", () => {
  test("includes fixed built-in action IDs for duplicate protection", () => {
    expect(getBuiltInPaletteActionRegistryEntries().map((entry) => entry.id)).toEqual([
      "set-goal",
      "register-agent",
    ]);
  });

  test("projects enabled plugin actions into palette items", () => {
    const refresh = action();
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(items.map((item) => [item.kind, item.id, item.label, item.detail, item.enabled])).toEqual([
      ["plugin-action", "audit-refresh", "Refresh audit panel", "audit", true],
    ]);
    expect(items[0]?.pluginAction).toBe(refresh);
  });

  test("projects disabled plugin actions as non-executable palette items", () => {
    const refresh = action({ enabled: () => false });
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(items[0]?.enabled).toBe(false);
  });

  test("evaluates enabled predicate with the plugin context", () => {
    const enabled = mock((ctx: TuiPluginContext) => ctx.density === "compact");
    const refresh = action({ enabled });
    const merged = mergeTuiActionRegistrations({
      builtIns: getBuiltInPaletteActionRegistryEntries(),
      plugins: [refresh],
    });

    const items = buildPluginPaletteItems(merged.entries, context());

    expect(items[0]?.enabled).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the failing palette tests**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/components/command-palette.test.tsx
rm "$tmp"
```

Expected: FAIL because `buildPluginPaletteItems` and `getBuiltInPaletteActionRegistryEntries` are not exported, and `PaletteItem` has no `plugin-action` kind.

- [ ] **Step 3: Add plugin palette item support**

Modify `src/tui/components/command-palette.tsx`.

Add imports:

```ts
import type { TuiActionRegistryEntry } from "../plugins/registry.js";
import type { TuiActionRegistration, TuiPluginContext } from "../plugins/types.js";
```

Change `PaletteItem`:

```ts
export interface PaletteItem {
  readonly kind: "spawn" | "kill" | "register" | "delegate" | "goal" | "plugin-action";
  /** For spawn: role name. For kill: session name. For delegate: peer address. For plugin-action: action id. */
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly detail: string;
  readonly pluginAction?: TuiActionRegistration | undefined;
}
```

Add fixed built-in action entries and plugin projection helpers below `LoadedProfile`:

```ts
const BUILT_IN_PALETTE_ACTIONS: readonly TuiActionRegistryEntry[] = Object.freeze([
  Object.freeze({
    id: "set-goal",
    label: "Set goal",
    detail: "Set or update the session goal for all agents",
    order: 0,
    source: "builtin" as const,
    builtInAction: "goal",
  }),
  Object.freeze({
    id: "register-agent",
    label: "[r] Register new agent profile",
    detail: "agents.json",
    order: 10,
    source: "builtin" as const,
    builtInAction: "register",
  }),
]);

export function getBuiltInPaletteActionRegistryEntries(): readonly TuiActionRegistryEntry[] {
  return BUILT_IN_PALETTE_ACTIONS;
}

export function buildPluginPaletteItems(
  entries: readonly TuiActionRegistryEntry[],
  context: TuiPluginContext,
): readonly PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const entry of entries) {
    if (entry.source !== "plugin" || entry.registration === undefined) continue;
    const enabled = entry.registration.enabled?.(context) ?? true;
    items.push({
      kind: "plugin-action",
      id: entry.id,
      label: entry.label,
      detail: entry.detail,
      enabled,
      pluginAction: entry.registration,
    });
  }
  return Object.freeze(items);
}
```

- [ ] **Step 4: Run palette tests green**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/components/command-palette.test.tsx
rm "$tmp"
```

Expected: PASS for all command palette plugin item tests.

- [ ] **Step 5: Commit palette projection**

Run:

```bash
git add src/tui/components/command-palette.tsx src/tui/components/command-palette.test.tsx
git commit -m "feat(tui): project plugin actions into palette"
```

### Task 3: Execute Plugin Actions From App

**Files:**
- Create: `src/tui/plugins/actions.ts`
- Create: `src/tui/plugins/actions.test.ts`
- Modify: `src/tui/app.tsx`

- [ ] **Step 1: Write failing action execution tests**

Create `src/tui/plugins/actions.test.ts`.

```ts
import { describe, expect, test } from "bun:test";
import type { TuiDataProvider } from "../provider.js";
import { runTuiActionRegistration } from "./actions.js";
import type { TuiActionRegistration, TuiPluginContext } from "./types.js";

function context(): TuiPluginContext {
  return {
    provider: {} as TuiDataProvider,
    density: "comfortable",
    showMessage: () => undefined,
  };
}

describe("runTuiActionRegistration", () => {
  test("runs synchronous action callbacks with plugin context", async () => {
    let receivedDensity = "";
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: (ctx) => {
        receivedDensity = ctx.density;
      },
    };

    await runTuiActionRegistration(action, context());

    expect(receivedDensity).toBe("comfortable");
  });

  test("runs asynchronous action callbacks", async () => {
    let completed = false;
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: async () => {
        await Promise.resolve();
        completed = true;
      },
    };

    await runTuiActionRegistration(action, context());

    expect(completed).toBe(true);
  });

  test("propagates action failures to the caller", async () => {
    const action: TuiActionRegistration = {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: () => {
        throw new Error("audit failed");
      },
    };

    await expect(runTuiActionRegistration(action, context())).rejects.toThrow("audit failed");
  });
});
```

- [ ] **Step 2: Run the failing action tests**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/actions.test.ts
rm "$tmp"
```

Expected: FAIL because `src/tui/plugins/actions.ts` does not exist.

- [ ] **Step 3: Add the action execution helper**

Create `src/tui/plugins/actions.ts`.

```ts
import type { TuiActionRegistration, TuiPluginContext } from "./types.js";

export async function runTuiActionRegistration(
  action: TuiActionRegistration,
  context: TuiPluginContext,
): Promise<void> {
  await action.run(context);
}
```

- [ ] **Step 4: Run action tests green**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/actions.test.ts
rm "$tmp"
```

Expected: PASS for all action execution tests.

- [ ] **Step 5: Wire extensions and plugin action execution into `App`**

Modify `src/tui/app.tsx`.

Add imports:

```ts
import {
  buildPaletteItems,
  buildPluginPaletteItems,
  CommandPalette,
  fuzzyMatch,
  getBuiltInPaletteActionRegistryEntries,
} from "./components/command-palette.js";
import {
  collectTuiActionRegistrations,
  mergeTuiActionRegistrations,
} from "./plugins/registry.js";
import { runTuiActionRegistration } from "./plugins/actions.js";
import type { TuiExtension, TuiPluginContext } from "./plugins/types.js";
```

Add `extensions` to `AppProps`:

```ts
  /** Trusted local-code TUI extensions. Grove does not dynamically load these. */
  readonly extensions?: readonly TuiExtension[] | undefined;
```

Destructure it in `App`:

```ts
export function App({
  provider,
  intervalMs,
  tmux,
  topology,
  presetName,
  groveDir,
  userConfig,
  eventBus,
  screenContext,
  extensions,
}: AppProps): React.ReactNode {
```

After `showError`, build plugin action registrations and context:

```ts
  const pluginActionRegistrations = useMemo(
    () => collectTuiActionRegistrations(extensions),
    [extensions],
  );
  const mergedActionRegistry = useMemo(
    () =>
      mergeTuiActionRegistrations({
        builtIns: getBuiltInPaletteActionRegistryEntries(),
        plugins: pluginActionRegistrations,
      }),
    [pluginActionRegistrations],
  );
  const pluginContext = useMemo<TuiPluginContext>(
    () => ({
      provider,
      topology,
      selectedSession,
      selectedCid: nav.detailCid,
      density: ks.layoutMode === "tab" ? "compact" : "comfortable",
      showMessage: showError,
    }),
    [provider, topology, selectedSession, nav.detailCid, ks.layoutMode, showError],
  );
```

Add a diagnostic reporting effect:

```ts
  useEffect(() => {
    for (const diagnostic of mergedActionRegistry.diagnostics) {
      showError(diagnostic.message);
    }
  }, [mergedActionRegistry.diagnostics, showError]);
```

Split core and plugin palette items:

```ts
  const corePaletteItems = useMemo(
    () =>
      buildPaletteItems(
        topology,
        activeClaims ?? [],
        paletteSessions ?? [],
        tmux !== undefined,
        canSpawn,
        true,
        paletteParentId,
        canDelegate ? (gossipPeers ?? undefined) : undefined,
        agentProfiles ?? undefined,
        hasGoals,
      ),
    [
      topology,
      activeClaims,
      paletteSessions,
      tmux,
      canSpawn,
      canDelegate,
      paletteParentId,
      gossipPeers,
      agentProfiles,
      hasGoals,
    ],
  );
  const pluginPaletteItems = useMemo(
    () => buildPluginPaletteItems(mergedActionRegistry.entries, pluginContext),
    [mergedActionRegistry.entries, pluginContext],
  );
  const paletteItems = useMemo(
    () => [...corePaletteItems, ...pluginPaletteItems],
    [corePaletteItems, pluginPaletteItems],
  );
```

In `onPaletteSelect`, add a plugin-action branch before resetting the palette:

```ts
        } else if (item.kind === "plugin-action" && item.pluginAction !== undefined) {
          void runTuiActionRegistration(item.pluginAction, pluginContext).catch((err: unknown) => {
            showError(err instanceof Error ? err.message : "Plugin action failed");
          });
```

Add `pluginContext` and `mergedActionRegistry.entries` to memo dependencies where TypeScript requires them.

- [ ] **Step 6: Run focused action and type tests**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/plugins/actions.test.ts src/tui/components/command-palette.test.tsx src/tui/plugins/registry.test.ts
rm "$tmp"
bun run typecheck
```

Expected: focused tests PASS; `bun run typecheck` PASS.

- [ ] **Step 7: Commit App action wiring**

Run:

```bash
git add src/tui/app.tsx src/tui/plugins/actions.ts src/tui/plugins/actions.test.ts
git commit -m "feat(tui): execute plugin palette actions"
```

### Task 4: Render Default-Visible Plugin Panels

**Files:**
- Create: `src/tui/panels/plugin-panels.ts`
- Create: `src/tui/panels/plugin-panels.test.ts`
- Modify: `src/tui/panels/panel-manager.tsx`

- [ ] **Step 1: Write failing plugin panel selection tests**

Create `src/tui/panels/plugin-panels.test.ts`.

```ts
import { describe, expect, test } from "bun:test";
import type React from "react";
import { Panel } from "../hooks/use-panel-focus.js";
import type { TuiRegistryEntry } from "../plugins/registry.js";
import type { TuiPluginContext } from "../plugins/types.js";
import { getDefaultVisiblePluginPanelEntries } from "./plugin-panels.js";

const NullPanel: React.ComponentType<TuiPluginContext> = () => null;

function builtInEntry(id: string, order: number, panel: Panel): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot: "operator-panel",
    order,
    source: "builtin",
    builtInPanel: panel,
  };
}

function pluginEntry(id: string, defaultVisible?: boolean): TuiRegistryEntry {
  return {
    id,
    label: id,
    slot: "operator-panel",
    order: 1000,
    source: "plugin",
    registration: {
      id,
      label: id,
      slot: "operator-panel",
      ...(defaultVisible === undefined ? {} : { defaultVisible }),
      component: NullPanel,
    },
  };
}

describe("getDefaultVisiblePluginPanelEntries", () => {
  test("returns only plugin operator panels with defaultVisible true", () => {
    const entries: readonly TuiRegistryEntry[] = [
      builtInEntry("dag", 0, Panel.Dag),
      pluginEntry("audit-panel", true),
      pluginEntry("hidden-panel", false),
      pluginEntry("implicit-hidden"),
    ];

    expect(getDefaultVisiblePluginPanelEntries(entries).map((entry) => entry.id)).toEqual([
      "audit-panel",
    ]);
  });

  test("skips plugin entries without registrations", () => {
    const entries: readonly TuiRegistryEntry[] = [
      {
        id: "broken-panel",
        label: "Broken",
        slot: "operator-panel",
        order: 1000,
        source: "plugin",
      },
    ];

    expect(getDefaultVisiblePluginPanelEntries(entries)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the failing plugin panel tests**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/panels/plugin-panels.test.ts
rm "$tmp"
```

Expected: FAIL because `src/tui/panels/plugin-panels.ts` does not exist.

- [ ] **Step 3: Add the plugin panel selection helper**

Create `src/tui/panels/plugin-panels.ts`.

```ts
import type { TuiRegistryEntry } from "../plugins/registry.js";

export function getDefaultVisiblePluginPanelEntries(
  entries: readonly TuiRegistryEntry[],
): readonly TuiRegistryEntry[] {
  return Object.freeze(
    entries.filter(
      (entry) =>
        entry.source === "plugin" &&
        entry.slot === "operator-panel" &&
        entry.registration !== undefined &&
        entry.registration.defaultVisible === true,
    ),
  );
}
```

- [ ] **Step 4: Run plugin panel helper tests green**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/panels/plugin-panels.test.ts
rm "$tmp"
```

Expected: PASS for all plugin panel selection tests.

- [ ] **Step 5: Render plugin panels in `PanelManager`**

Modify `src/tui/panels/panel-manager.tsx`.

Add imports:

```ts
import type { TuiRegistryEntry } from "../plugins/registry.js";
import type { TuiPluginContext } from "../plugins/types.js";
import { getDefaultVisiblePluginPanelEntries } from "./plugin-panels.js";
```

Add props to `PanelManagerProps`:

```ts
  /** Merged built-in and plugin panel entries. Defaults to built-ins only. */
  readonly registryEntries?: readonly TuiRegistryEntry[] | undefined;
  /** Context passed to trusted plugin panel components. */
  readonly pluginContext?: TuiPluginContext | undefined;
```

Change `PanelChrome` to accept a title string:

```tsx
function PanelChrome({
  title,
  focused,
  children,
}: {
  readonly title: string;
  readonly focused: boolean;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const borderColor = focused ? theme.focus : theme.inactive;
  const titleColor = focused ? theme.focus : theme.secondary;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      border
      borderStyle="round"
      borderColor={borderColor}
      opacity={focused ? 1.0 : 0.7}
    >
      <box>
        <text color={titleColor} bold={focused}>
          {` ${title} `}
        </text>
      </box>
      {children}
    </box>
  );
}
```

When rendering built-ins, pass `title={PANEL_LABELS[def.panel]}`. In tab mode:

```tsx
          <PanelChrome title={PANEL_LABELS[panelState.focused]} focused>
            {renderPanel(panelState.focused)}
          </PanelChrome>
```

Inside `PanelManager`, destructure `registryEntries` and `pluginContext`, then derive plugin panels:

```ts
    const pluginPanelEntries = getDefaultVisiblePluginPanelEntries(registryEntries ?? []);
```

After the existing built-in grid row mapping, render plugin rows:

```tsx
        {pluginContext !== undefined
          ? pluginPanelEntries.map((entry) => {
              const Component = entry.registration?.component;
              if (Component === undefined) return null;
              return (
                <box key={entry.id} flexDirection="row" flexGrow={1}>
                  <PanelChrome title={entry.label} focused={false}>
                    <Component {...pluginContext} />
                  </PanelChrome>
                </box>
              );
            })
          : null}
```

The built-in row grouping still calls `getRowGroups()` with the built-in registry. This preserves current built-in layout and appends default-visible plugin panels after built-ins.

- [ ] **Step 6: Wire merged panel entries through `App`**

Modify `src/tui/app.tsx`.

Add imports:

```ts
import {
  collectTuiPanelRegistrations,
  mergeTuiRegistrations,
} from "./plugins/registry.js";
import { getBuiltInTuiRegistryEntries } from "./panels/panel-registry.js";
```

After the action registry memo from Task 3, build the merged panel registry:

```ts
  const pluginPanelRegistrations = useMemo(
    () => collectTuiPanelRegistrations(extensions),
    [extensions],
  );
  const mergedPanelRegistry = useMemo(
    () =>
      mergeTuiRegistrations({
        builtIns: getBuiltInTuiRegistryEntries(),
        plugins: pluginPanelRegistrations,
      }),
    [pluginPanelRegistrations],
  );
```

Add a panel diagnostic reporting effect:

```ts
  useEffect(() => {
    for (const diagnostic of mergedPanelRegistry.diagnostics) {
      showError(diagnostic.message);
    }
  }, [mergedPanelRegistry.diagnostics, showError]);
```

Pass panel registry and context to `PanelManager`:

```tsx
          registryEntries={mergedPanelRegistry.entries}
          pluginContext={pluginContext}
```

- [ ] **Step 7: Run focused panel tests and typecheck**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test src/tui/panels/plugin-panels.test.ts src/tui/panels/panel-registry.test.ts
rm "$tmp"
bun run typecheck
```

Expected: focused tests PASS; `bun run typecheck` PASS.

- [ ] **Step 8: Commit plugin panel rendering**

Run:

```bash
git add src/tui/app.tsx src/tui/panels/panel-manager.tsx src/tui/panels/plugin-panels.ts src/tui/panels/plugin-panels.test.ts
git commit -m "feat(tui): render plugin operator panels"
```

### Task 5: Document the Trusted Extension Surface

**Files:**
- Create: `docs/tui/tui-extensions.md`

- [ ] **Step 1: Create the TUI extension guide**

Create `docs/tui/tui-extensions.md`.

````markdown
# TUI Extensions

Grove's first TUI extension surface is trusted local code. The TUI does not
load arbitrary module paths, remote plugins, or package manifests. Application
code passes typed extension objects into the TUI.

## Extension Shape

```ts
import type { TuiExtension } from "../src/tui/plugins/types.js";

export const auditExtension: TuiExtension = {
  id: "audit",
  name: "Audit tools",
  version: "1.0.0",
  panels: [
    {
      id: "audit-panel",
      label: "Audit",
      slot: "operator-panel",
      defaultVisible: true,
      component: AuditPanel,
    },
  ],
  actions: [
    {
      id: "audit-refresh",
      label: "Refresh audit panel",
      detail: "audit",
      run: (context) => {
        context.showMessage("Audit refresh requested");
      },
    },
  ],
};
```

## Panel Registrations

Panel IDs must be lowercase and may contain lowercase letters, numbers, dots,
and hyphens. Plugin panels use the `operator-panel` slot. The first
implementation renders plugin panels when `defaultVisible` is `true`.

Panel components receive `TuiPluginContext`:

```ts
interface TuiPluginContext {
  readonly provider: TuiDataProvider;
  readonly topology?: AgentTopology | undefined;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly density: "comfortable" | "compact";
  readonly showMessage: (message: string) => void;
}
```

## Command Palette Actions

Actions appear in the command palette alongside built-in actions. Disabled
actions stay visible but cannot execute.

```ts
{
  id: "audit-export",
  label: "Export audit summary",
  detail: "audit",
  enabled: (context) => context.selectedCid !== undefined,
  run: async (context) => {
    context.showMessage(`Exporting ${context.selectedCid}`);
  },
}
```

## Safety Model

Extensions are trusted local code running in the TUI process. Grove validates
registration IDs, rejects duplicates, and limits the context object, but it does
not sandbox extension JavaScript. Do not load untrusted code as a TUI extension.

## Compatibility

Built-in IDs are reserved. A plugin entry that duplicates a built-in ID is
skipped and reported as a diagnostic. Optional context fields may be added in
future versions; existing context fields should keep their meaning.
````

- [ ] **Step 2: Check docs formatting**

Run:

```bash
bunx biome check docs/tui/tui-extensions.md
```

Expected: PASS for the new guide.

- [ ] **Step 3: Commit documentation**

Run:

```bash
git add docs/tui/tui-extensions.md
git commit -m "docs(tui): document local extension surface"
```

### Task 6: Final Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused tests without coverage thresholds**

Run:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
bun --config "$tmp" test \
  src/tui/plugins/registry.test.ts \
  src/tui/plugins/actions.test.ts \
  src/tui/components/command-palette.test.tsx \
  src/tui/panels/plugin-panels.test.ts \
  src/tui/panels/panel-registry.test.ts
rm "$tmp"
```

Expected: PASS for every focused TUI extension test.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```bash
bun test --timeout 60000
bun test --cwd packages/ask-user --timeout 60000
```

Expected: PASS. If the root test command fails only because the existing global coverage threshold is evaluated against a partial run, rerun the exact focused command from Step 1 and report the coverage-threshold behavior in the final summary.

- [ ] **Step 4: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS or known pre-existing warnings only. If pre-existing warnings remain, record their file paths and confirm no new diagnostics point at files changed for this issue.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: PASS with no output.

- [ ] **Step 6: Review changed files**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff -- src/tui/plugins src/tui/components/command-palette.tsx src/tui/panels src/tui/app.tsx docs/tui/tui-extensions.md
```

Expected: only issue #189 extension-surface files are changed beyond the committed spec and plan docs.

## Self-Review Checklist

- Spec coverage: Tasks 1-4 cover extension contracts, registry validation, plugin action palette projection/execution, and default-visible plugin panel rendering. Task 5 covers documentation. Task 6 covers verification.
- Type consistency: `TuiExtension`, `TuiPluginContext`, `TuiActionRegistration`, `TuiActionRegistryEntry`, `buildPluginPaletteItems`, and `runTuiActionRegistration` use the same names across tasks.
- Scope control: The plan does not add dynamic plugin loading, remote plugins, sandboxing, marketplace packaging, or plugin keyboard toggles.
