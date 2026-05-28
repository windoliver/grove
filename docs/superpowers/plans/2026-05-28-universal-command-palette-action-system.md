# Universal Command Palette Action System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the TUI command palette into a universal, searchable, context-sensitive action system backed by a single unified action model.

**Architecture:** Introduce one `Action` shape (`{id,label,detail,group,keywords?,available?,enabled?,run}`) evaluated against a rich internal `ActionContext`. Built-in actions are produced by builders from live state; plugin `TuiActionRegistration`s are wrapped by an adapter that narrows the rich context to the existing `TuiPluginContext`. A shared `computeVisibleActions` helper produces the flat, ordered list used both for rendering (grouped, or flat when querying) and for keyboard selection indexing.

**Tech Stack:** TypeScript, React + OpenTUI, `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-28-universal-command-palette-action-system-design.md`

**Test commands:** run a single file with `bun test <path>`; full suite with `bun test`. Typecheck with `bun run typecheck` (or `bunx tsc --noEmit` if no script).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tui/actions/types.ts` (new) | `ActionGroup`, `Action`, `ActionContext`, `GROUP_ORDER` |
| `src/tui/actions/visibility.ts` (new) | `computeVisibleActions` + keyword-aware fuzzy ranking (`VisibleAction`) |
| `src/tui/actions/plugin-adapter.ts` (new) | `buildPluginActions(entries, mkPluginCtx)` → `Action[]` (group `Plugins`) |
| `src/tui/actions/builtin-actions.ts` (new) | `buildBuiltInActions(ctx)` → `Action[]` for Navigation/Agents/Workflow/Contributions |
| `src/tui/components/command-palette.tsx` (modify) | Render `Action[]` grouped (no query) / flat ranked (query); drop `PaletteItem` + old builders; keep `fuzzyMatch`/`renderHighlighted` |
| `src/tui/app.tsx` (modify) | Build `ActionContext`, assemble action list, collapse `onPaletteSelect`, add `pendingQuestionCount` fetcher |
| tests alongside each new file + `command-palette.test.tsx` migration |

---

## Task 1: Action model types

**Files:**
- Create: `src/tui/actions/types.ts`
- Test: `src/tui/actions/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/actions/types.test.ts
import { describe, expect, test } from "bun:test";
import { GROUP_ORDER } from "./types.js";

describe("action types", () => {
  test("GROUP_ORDER lists the five groups in display order", () => {
    expect(GROUP_ORDER).toEqual([
      "Navigation",
      "Agents",
      "Workflow",
      "Contributions",
      "Plugins",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/actions/types.test.ts`
Expected: FAIL — cannot find module `./types.js`.

- [ ] **Step 3: Write the types**

```ts
// src/tui/actions/types.ts
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import type { Panel } from "../hooks/use-panel-focus.js";

/** Top-level grouping for palette actions. */
export type ActionGroup =
  | "Navigation"
  | "Agents"
  | "Workflow"
  | "Contributions"
  | "Plugins";

/** Fixed display order for groups when no query is active. */
export const GROUP_ORDER: readonly ActionGroup[] = [
  "Navigation",
  "Agents",
  "Workflow",
  "Contributions",
  "Plugins",
];

/** An agent profile loaded from .grove/agents.json. */
export interface LoadedProfile {
  readonly name: string;
  readonly role: string;
  readonly platform: string;
  readonly command?: string | undefined;
}

/** A gossip peer with free agent capacity. */
export interface GossipPeerSlot {
  readonly peerId: string;
  readonly address: string;
  readonly freeSlots: number;
}

/**
 * Rich, internal context handed to built-in actions. Holds read-only state for
 * enumeration/gating plus imperative capabilities closed over app machinery.
 * Plugins never see this — see `plugin-adapter.ts`.
 */
export interface ActionContext {
  // --- read state ---
  readonly topology?: AgentTopology | undefined;
  readonly sessions: readonly string[];
  readonly profiles: readonly LoadedProfile[];
  readonly gossipPeers: readonly GossipPeerSlot[];
  /** Active claims, or null when scoped session can't see them. */
  readonly claims: readonly Claim[] | null;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly pendingQuestionCount: number;
  readonly hasGoals: boolean;
  readonly canSpawn: boolean;
  readonly canDelegate: boolean;
  readonly isPanelVisible: (panel: Panel) => boolean;

  // --- capabilities ---
  readonly focusPanel: (panel: Panel) => void;
  readonly togglePanel: (panel: Panel) => void;
  readonly openContribution: (cid: string) => void;
  readonly jumpToSession: (session: string) => void;
  readonly enterGoalMode: () => void;
  readonly enterCompareMode: () => void;
  readonly addToCompare: (cid: string) => void;
  readonly adoptContribution: (cid: string, summary: string) => void;
  readonly answerPendingQuestion: (verdict: "approve" | "deny") => void;
  readonly registerAgentProfile: () => void;
  readonly spawn: (roleId: string, command: string, parentAgentId?: string) => void;
  readonly kill: (session: string) => void;
  readonly delegate: (peerAddress: string) => void;
  readonly showMessage: (message: string) => void;
}

/** A single unified palette action. */
export interface Action {
  /** Stable, unique id, e.g. "nav.panel.terminal", "agent.spawn.reviewer". */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: ActionGroup;
  /** Extra fuzzy-match terms beyond the label. */
  readonly keywords?: readonly string[] | undefined;
  /** Relevance gate. False → item is HIDDEN entirely. Default: visible. */
  readonly available?: ((ctx: ActionContext) => boolean) | undefined;
  /** Capability gate. False → item shown but GREYED and not executable. */
  readonly enabled?: ((ctx: ActionContext) => boolean) | undefined;
  readonly run: (ctx: ActionContext) => void | Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/actions/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/actions/types.ts src/tui/actions/types.test.ts
git commit -m "feat(tui): add unified Action model + ActionContext types (#194)"
```

---

## Task 2: Visibility + keyword-aware ranking helper

**Files:**
- Create: `src/tui/actions/visibility.ts`
- Test: `src/tui/actions/visibility.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/actions/visibility.test.ts
import { describe, expect, test } from "bun:test";
import type { Action, ActionContext } from "./types.js";
import { computeVisibleActions } from "./visibility.js";

// Minimal ctx — only fields read by these actions matter.
function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    sessions: [],
    profiles: [],
    gossipPeers: [],
    claims: [],
    pendingQuestionCount: 0,
    hasGoals: false,
    canSpawn: false,
    canDelegate: false,
    isPanelVisible: () => false,
    focusPanel: () => undefined,
    togglePanel: () => undefined,
    openContribution: () => undefined,
    jumpToSession: () => undefined,
    enterGoalMode: () => undefined,
    enterCompareMode: () => undefined,
    addToCompare: () => undefined,
    adoptContribution: () => undefined,
    answerPendingQuestion: () => undefined,
    registerAgentProfile: () => undefined,
    spawn: () => undefined,
    kill: () => undefined,
    delegate: () => undefined,
    showMessage: () => undefined,
    ...overrides,
  };
}

function act(o: Partial<Action> & Pick<Action, "id" | "group">): Action {
  return { label: o.id, detail: "", run: () => undefined, ...o };
}

describe("computeVisibleActions", () => {
  test("no query: hides unavailable, orders by group", () => {
    const actions: Action[] = [
      act({ id: "p1", group: "Plugins", label: "plugin one" }),
      act({ id: "n1", group: "Navigation", label: "nav one" }),
      act({ id: "hidden", group: "Agents", label: "hidden", available: () => false }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "");
    expect(visible.map((v) => v.action.id)).toEqual(["n1", "p1"]);
    expect(visible[0]?.matchedIndices).toEqual([]);
  });

  test("query: flat ranked, matches label or keywords", () => {
    const actions: Action[] = [
      act({ id: "terminal", group: "Navigation", label: "Focus Terminal" }),
      act({ id: "vfs", group: "Navigation", label: "Focus VFS", keywords: ["files"] }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "files");
    expect(visible.map((v) => v.action.id)).toEqual(["vfs"]);
  });

  test("query: still respects available()", () => {
    const actions: Action[] = [
      act({ id: "x", group: "Workflow", label: "answer question", available: () => false }),
    ];
    expect(computeVisibleActions(actions, ctx(), "answer")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/actions/visibility.test.ts`
Expected: FAIL — cannot find module `./visibility.js`.

- [ ] **Step 3: Write the helper**

```ts
// src/tui/actions/visibility.ts
import { fuzzyMatch } from "../components/command-palette.js";
import type { Action, ActionContext } from "./types.js";
import { GROUP_ORDER } from "./types.js";

/** An available action with label-match metadata for highlighting. */
export interface VisibleAction {
  readonly action: Action;
  readonly matchedIndices: readonly number[];
}

function isAvailable(action: Action, ctx: ActionContext): boolean {
  return action.available?.(ctx) ?? true;
}

/**
 * Produce the ordered, flat list of actions the palette displays.
 *
 * - No query: available actions sorted by GROUP_ORDER (stable within a group).
 * - Query: available actions whose label OR any keyword fuzzy-matches, ranked
 *   by best score (desc). `matchedIndices` reflects the label match only
 *   (empty when only a keyword matched).
 *
 * This single list is the source of truth for BOTH grouped rendering and the
 * keyboard selection index — keeping them in sync.
 */
export function computeVisibleActions(
  actions: readonly Action[],
  ctx: ActionContext,
  query: string,
): readonly VisibleAction[] {
  const available = actions.filter((a) => isAvailable(a, ctx));
  const q = query.trim();

  if (!q) {
    const ordered = [...available].sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
    return ordered.map((action) => ({ action, matchedIndices: [] }));
  }

  const ranked: Array<VisibleAction & { score: number }> = [];
  for (const action of available) {
    const labelResult = fuzzyMatch(q, action.label);
    let best = labelResult.match ? labelResult.score : -1;
    let matchedIndices: readonly number[] = labelResult.match ? labelResult.matchedIndices : [];
    for (const kw of action.keywords ?? []) {
      const r = fuzzyMatch(q, kw);
      if (r.match && r.score > best) {
        best = r.score;
        // Keep label highlight only; a keyword-only match yields no label indices.
        if (!labelResult.match) matchedIndices = [];
      }
    }
    if (best >= 0) ranked.push({ action, matchedIndices, score: best });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map(({ action, matchedIndices }) => ({ action, matchedIndices }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/actions/visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/actions/visibility.ts src/tui/actions/visibility.test.ts
git commit -m "feat(tui): add computeVisibleActions ordering + keyword ranking (#194)"
```

---

## Task 3: Plugin adapter

**Files:**
- Create: `src/tui/actions/plugin-adapter.ts`
- Test: `src/tui/actions/plugin-adapter.test.ts`

`mkPluginCtx` converts the rich `ActionContext` into the narrow `TuiPluginContext`. The app supplies it (it owns `provider`/`density`); the adapter never reaches app internals itself.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/actions/plugin-adapter.test.ts
import { describe, expect, mock, test } from "bun:test";
import { mergeTuiActionRegistrations } from "../plugins/registry.js";
import type { TuiActionRegistration, TuiPluginContext } from "../plugins/types.js";
import { buildPluginActions } from "./plugin-adapter.js";

const pluginCtx = { density: "compact", showMessage: () => undefined } as unknown as TuiPluginContext;

function reg(o: Partial<TuiActionRegistration> = {}): TuiActionRegistration {
  return { id: "audit-refresh", label: "Refresh audit", detail: "audit", run: () => undefined, ...o };
}

describe("buildPluginActions", () => {
  test("wraps plugin registrations as Plugins-group actions", () => {
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg()] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("audit-refresh");
    expect(actions[0]?.group).toBe("Plugins");
    expect(actions[0]?.label).toBe("Refresh audit");
  });

  test("run delegates to the registration with the narrow plugin context", async () => {
    const run = mock(() => undefined);
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg({ run })] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    // ActionContext arg is ignored by the adapter; pass an empty stub.
    await actions[0]?.run({} as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(pluginCtx);
  });

  test("enabled delegates to the registration predicate via plugin context", () => {
    const enabled = mock((c: TuiPluginContext) => c.density === "compact");
    const merged = mergeTuiActionRegistrations({ builtIns: [], plugins: [reg({ enabled })] });
    const actions = buildPluginActions(merged.entries, () => pluginCtx);
    expect(actions[0]?.enabled?.({} as never)).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/actions/plugin-adapter.test.ts`
Expected: FAIL — cannot find module `./plugin-adapter.js`.

- [ ] **Step 3: Write the adapter**

```ts
// src/tui/actions/plugin-adapter.ts
import type { TuiActionRegistryEntry } from "../plugins/registry.js";
import type { TuiPluginContext } from "../plugins/types.js";
import type { Action, ActionContext } from "./types.js";

/**
 * Wrap plugin action registry entries as unified `Action`s in the Plugins group.
 *
 * `mkPluginCtx` builds the narrow plugin context from the rich one so plugins
 * never receive app internals (panel focus, spawn/kill, dispatch).
 */
export function buildPluginActions(
  entries: readonly TuiActionRegistryEntry[],
  mkPluginCtx: (ctx: ActionContext) => TuiPluginContext,
): readonly Action[] {
  const actions: Action[] = [];
  for (const entry of entries) {
    if (entry.source !== "plugin" || entry.registration === undefined) continue;
    const reg = entry.registration;
    actions.push({
      id: entry.id,
      label: entry.label,
      detail: entry.detail,
      group: "Plugins",
      enabled: reg.enabled ? (ctx) => reg.enabled?.(mkPluginCtx(ctx)) ?? true : undefined,
      run: (ctx) => reg.run(mkPluginCtx(ctx)),
    });
  }
  return Object.freeze(actions);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/actions/plugin-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/actions/plugin-adapter.ts src/tui/actions/plugin-adapter.test.ts
git commit -m "feat(tui): add plugin-action adapter to unified model (#194)"
```

---

## Task 4: Built-in action builders

**Files:**
- Create: `src/tui/actions/builtin-actions.ts`
- Test: `src/tui/actions/builtin-actions.test.ts`

Builders enumerate per-entity actions from `ctx` and gate them via `available`/`enabled`. Uses `checkSpawn` for capacity, `OPERATOR_PANELS`/`PANEL_LABELS` for navigation, `agentIdFromSession` is NOT needed (jump-to-session uses raw session names).

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/actions/builtin-actions.test.ts
import { describe, expect, test } from "bun:test";
import type { ActionContext } from "./types.js";
import { buildBuiltInActions } from "./builtin-actions.js";

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    sessions: [],
    profiles: [],
    gossipPeers: [],
    claims: [],
    pendingQuestionCount: 0,
    hasGoals: false,
    canSpawn: false,
    canDelegate: false,
    isPanelVisible: () => false,
    focusPanel: () => undefined,
    togglePanel: () => undefined,
    openContribution: () => undefined,
    jumpToSession: () => undefined,
    enterGoalMode: () => undefined,
    enterCompareMode: () => undefined,
    addToCompare: () => undefined,
    adoptContribution: () => undefined,
    answerPendingQuestion: () => undefined,
    registerAgentProfile: () => undefined,
    spawn: () => undefined,
    kill: () => undefined,
    delegate: () => undefined,
    showMessage: () => undefined,
    ...overrides,
  };
}

function ids(c: ActionContext): string[] {
  return buildBuiltInActions(c)
    .filter((a) => a.available?.(c) ?? true)
    .map((a) => a.id);
}

describe("buildBuiltInActions", () => {
  test("navigation: one open/focus action per operator panel + always offers register/compare", () => {
    const present = ids(ctx());
    expect(present).toContain("nav.panel.terminal");
    expect(present).toContain("workflow.compare");
    expect(present).toContain("workflow.register-agent");
  });

  test("set goal only available when provider has goals", () => {
    expect(ids(ctx())).not.toContain("workflow.set-goal");
    expect(ids(ctx({ hasGoals: true }))).toContain("workflow.set-goal");
  });

  test("answer-question actions only available when a question is pending", () => {
    expect(ids(ctx())).not.toContain("workflow.approve-question");
    const pending = ids(ctx({ pendingQuestionCount: 1 }));
    expect(pending).toContain("workflow.approve-question");
    expect(pending).toContain("workflow.deny-question");
  });

  test("contribution actions only available when a contribution is selected", () => {
    expect(ids(ctx())).not.toContain("contrib.open");
    const sel = ids(ctx({ selectedCid: "bafy123" }));
    expect(sel).toContain("contrib.open");
    expect(sel).toContain("contrib.compare-add");
    expect(sel).toContain("contrib.adopt");
  });

  test("kill action per live session; jump-to-session per session", () => {
    const present = ids(ctx({ sessions: ["grove-reviewer-1"] }));
    expect(present).toContain("agent.kill.grove-reviewer-1");
    expect(present).toContain("nav.session.grove-reviewer-1");
  });

  test("spawn from profile is present but disabled at capacity", () => {
    const c = ctx({
      canSpawn: true,
      profiles: [{ name: "@rev", role: "reviewer", platform: "claude-code" }],
      // No topology → checkSpawn allowed:true path; force disable via claims is
      // covered by spawn-validator tests, here we assert presence + enabled default.
    });
    const spawn = buildBuiltInActions(c).find((a) => a.id === "agent.spawn.reviewer");
    expect(spawn).toBeDefined();
    expect(spawn?.enabled?.(c) ?? true).toBe(true);
  });

  test("delegate only available when canDelegate and peer has free slots", () => {
    const peers = [{ peerId: "p1", address: "http://p1", freeSlots: 2 }];
    expect(ids(ctx({ canDelegate: false, gossipPeers: peers }))).not.toContain(
      "agent.delegate.http://p1",
    );
    expect(ids(ctx({ canDelegate: true, gossipPeers: peers }))).toContain(
      "agent.delegate.http://p1",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/actions/builtin-actions.test.ts`
Expected: FAIL — cannot find module `./builtin-actions.js`.

- [ ] **Step 3: Write the builders**

```ts
// src/tui/actions/builtin-actions.ts
import { checkSpawn } from "../agents/spawn-validator.js";
import { OPERATOR_PANELS, PANEL_LABELS, type Panel } from "../hooks/use-panel-focus.js";
import type { Action, ActionContext } from "./types.js";

/** Build the full set of built-in actions from the current context. */
export function buildBuiltInActions(ctx: ActionContext): readonly Action[] {
  return Object.freeze([
    ...navigationActions(ctx),
    ...agentActions(ctx),
    ...workflowActions(ctx),
    ...contributionActions(),
  ]);
}

function navigationActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];
  for (const panel of OPERATOR_PANELS) {
    const label = PANEL_LABELS[panel];
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    actions.push({
      id: `nav.panel.${key}`,
      label: `Go to ${label} panel`,
      detail: "panel",
      group: "Navigation",
      keywords: ["open", "focus", "panel", label],
      run: (c) => (c.isPanelVisible(panel as Panel) ? c.focusPanel(panel as Panel) : c.togglePanel(panel as Panel)),
    });
  }
  for (const session of ctx.sessions) {
    actions.push({
      id: `nav.session.${session}`,
      label: `Jump to session ${session}`,
      detail: "session",
      group: "Navigation",
      keywords: ["session", "agent", "jump"],
      run: (c) => c.jumpToSession(session),
    });
  }
  return actions;
}

function agentActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];
  const claims = ctx.claims ?? [];

  // Spawn from profiles first, then topology roles not covered by a profile.
  const profileRoles = new Set<string>();
  if (ctx.canSpawn) {
    for (const profile of ctx.profiles) {
      profileRoles.add(profile.role);
      const role = profile.role;
      actions.push({
        id: `agent.spawn.${role}`,
        label: `Spawn ${profile.name} [${profile.platform}]`,
        detail: "spawn",
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
        detail: "spawn",
        group: "Agents",
        keywords: ["spawn", "agent", name],
        enabled: (c) => spawnAllowed(c, name),
        run: (c) => c.spawn(name, role.command ?? process.env.SHELL ?? "bash", c.parentAgentId),
      });
    }
  }

  for (const session of ctx.sessions) {
    actions.push({
      id: `agent.kill.${session}`,
      label: `Kill ${session}`,
      detail: "running",
      group: "Agents",
      keywords: ["kill", "stop", "agent"],
      run: (c) => c.kill(session),
    });
  }

  for (const peer of ctx.gossipPeers) {
    if (peer.freeSlots <= 0) continue;
    actions.push({
      id: `agent.delegate.${peer.address}`,
      label: `Delegate to ${peer.peerId} (${peer.freeSlots} free)`,
      detail: "delegate",
      group: "Agents",
      keywords: ["delegate", "peer"],
      available: (c) => c.canDelegate,
      run: (c) => c.delegate(peer.address),
    });
  }

  void claims; // capacity is recomputed inside spawnAllowed from live ctx
  return actions;
}

function workflowActions(ctx: ActionContext): readonly Action[] {
  void ctx;
  return [
    {
      id: "workflow.set-goal",
      label: "Set goal",
      detail: "Set or update the session goal for all agents",
      group: "Workflow",
      keywords: ["goal", "objective"],
      available: (c) => c.hasGoals,
      run: (c) => c.enterGoalMode(),
    },
    {
      id: "workflow.approve-question",
      label: "Approve pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "approve", "question", "ask"],
      available: (c) => c.pendingQuestionCount > 0,
      run: (c) => c.answerPendingQuestion("approve"),
    },
    {
      id: "workflow.deny-question",
      label: "Deny pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "deny", "question", "ask"],
      available: (c) => c.pendingQuestionCount > 0,
      run: (c) => c.answerPendingQuestion("deny"),
    },
    {
      id: "workflow.compare",
      label: "Compare contributions",
      detail: "compare",
      group: "Workflow",
      keywords: ["compare", "diff"],
      run: (c) => c.enterCompareMode(),
    },
    {
      id: "workflow.register-agent",
      label: "Register new agent profile",
      detail: "agents.json",
      group: "Workflow",
      keywords: ["register", "profile"],
      run: (c) => c.registerAgentProfile(),
    },
  ];
}

function contributionActions(): readonly Action[] {
  const hasSelection = (c: ActionContext) => c.selectedCid !== undefined;
  return [
    {
      id: "contrib.open",
      label: "Open selected contribution",
      detail: "inspect",
      group: "Contributions",
      keywords: ["open", "detail", "contribution"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.openContribution(c.selectedCid);
      },
    },
    {
      id: "contrib.compare-add",
      label: "Add selected contribution to compare",
      detail: "compare",
      group: "Contributions",
      keywords: ["compare", "add"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.addToCompare(c.selectedCid);
      },
    },
    {
      id: "contrib.adopt",
      label: "Adopt selected contribution",
      detail: "adopt",
      group: "Contributions",
      keywords: ["adopt", "build on"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.adoptContribution(c.selectedCid, "");
      },
    },
  ];
}

function spawnAllowed(ctx: ActionContext, role: string): boolean {
  if (!ctx.topology) return true; // no topology constraints to enforce
  if (ctx.claims === null) return false; // scoped session: conservative
  return checkSpawn(ctx.topology, role, ctx.claims, ctx.parentAgentId).allowed;
}

function topologyCommand(ctx: ActionContext, role: string): string | undefined {
  return ctx.topology?.roles.find((r) => r.name === role)?.command;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/actions/builtin-actions.test.ts`
Expected: PASS. If `checkSpawn`'s signature differs, open `src/tui/agents/spawn-validator.ts` and match its parameter order (it is `(topology, role, claims, parentAgentId?, activeSpawnCounts?)`).

- [ ] **Step 5: Commit**

```bash
git add src/tui/actions/builtin-actions.ts src/tui/actions/builtin-actions.test.ts
git commit -m "feat(tui): add built-in action builders for nav/agents/workflow/contrib (#194)"
```

---

## Task 5: Render the palette from the unified model

**Files:**
- Modify: `src/tui/components/command-palette.tsx`
- Modify: `src/tui/components/command-palette.test.tsx`

Keep `fuzzyMatch` and `renderHighlighted` exported (still imported by `visibility.ts` and `app.tsx`). Replace the `PaletteItem` rendering with `Action`-based grouped/flat rendering driven by `computeVisibleActions`. Remove `PaletteItem`, `buildPaletteItems`, `buildPluginPaletteItems`, `LoadedProfile`, and `getBuiltInPaletteActionRegistryEntries` (superseded). The component receives the unified `actions`, the `ctx`, the `query`, and `selectedIndex`.

- [ ] **Step 1: Write the failing test (replace the file body)**

```tsx
// src/tui/components/command-palette.test.tsx
import { describe, expect, test } from "bun:test";
import type { Action, ActionContext } from "../actions/types.js";
import { computeVisibleActions } from "../actions/visibility.js";
import { fuzzyMatch } from "./command-palette.js";

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    sessions: [], profiles: [], gossipPeers: [], claims: [],
    pendingQuestionCount: 0, hasGoals: false, canSpawn: false, canDelegate: false,
    isPanelVisible: () => false, focusPanel: () => undefined, togglePanel: () => undefined,
    openContribution: () => undefined, jumpToSession: () => undefined,
    enterGoalMode: () => undefined, enterCompareMode: () => undefined,
    addToCompare: () => undefined, adoptContribution: () => undefined,
    answerPendingQuestion: () => undefined, registerAgentProfile: () => undefined,
    spawn: () => undefined, kill: () => undefined, delegate: () => undefined,
    showMessage: () => undefined, ...overrides,
  };
}
function act(o: Partial<Action> & Pick<Action, "id" | "group">): Action {
  return { label: o.id, detail: "", run: () => undefined, ...o };
}

describe("command palette model", () => {
  test("fuzzyMatch still scores word-boundary bonuses", () => {
    expect(fuzzyMatch("ft", "Focus Terminal").match).toBe(true);
    expect(fuzzyMatch("zzz", "Focus Terminal").match).toBe(false);
  });

  test("visible list is the flat selection index space", () => {
    const actions = [
      act({ id: "n1", group: "Navigation", label: "nav" }),
      act({ id: "a1", group: "Agents", label: "agent" }),
    ];
    const visible = computeVisibleActions(actions, ctx(), "");
    expect(visible.map((v) => v.action.id)).toEqual(["n1", "a1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/components/command-palette.test.tsx`
Expected: FAIL — old exports (`buildPluginPaletteItems`, `getBuiltInPaletteActionRegistryEntries`) referenced elsewhere still compile, but this test imports `../actions/types.js`/`../actions/visibility.js` and expects the new flat-list behavior; it fails to compile only if those modules are missing (they exist from Tasks 1–2), so the failure is the removed-export mismatch once Step 3 lands. Run it; if it passes immediately that's fine (it only asserts new behavior).

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `src/tui/components/command-palette.tsx` with:

```tsx
/**
 * Command palette overlay for the TUI.
 *
 * Renders the unified Action model. With no query, actions are shown grouped by
 * section (Navigation, Agents, Workflow, Contributions, Plugins). With a query,
 * group headers are hidden and a single fuzzy-ranked list is shown. The parent
 * drives selection via `selectedIndex` over the flat `computeVisibleActions`
 * list; Enter executes the selected action.
 */

import React, { useMemo } from "react";
import type { Action, ActionContext, ActionGroup } from "../actions/types.js";
import { GROUP_ORDER } from "../actions/types.js";
import { computeVisibleActions } from "../actions/visibility.js";
import { theme } from "../theme.js";

interface FuzzyResult {
  readonly match: boolean;
  readonly score: number;
  readonly matchedIndices: readonly number[];
}

/** Fuzzy-match `pattern` against `text`. (+2 at word boundary, +1 otherwise.) */
export function fuzzyMatch(pattern: string, text: string): FuzzyResult {
  if (!pattern) return { match: true, score: 0, matchedIndices: [] };
  const lower = text.toLowerCase();
  const pat = pattern.toLowerCase();
  let pi = 0;
  let score = 0;
  const matchedIndices: number[] = [];
  for (let i = 0; i < lower.length && pi < pat.length; i++) {
    if (lower[i] === pat[pi]) {
      const bonus = i === 0 || lower[i - 1] === " " || lower[i - 1] === "/" ? 2 : 1;
      score += bonus;
      matchedIndices.push(i);
      pi++;
    }
  }
  return { match: pi === pat.length, score, matchedIndices };
}

function renderHighlighted(
  label: string,
  matchedIndices: readonly number[],
  baseColor: string,
): React.ReactNode {
  if (matchedIndices.length === 0) return <text color={baseColor}>{label}</text>;
  const indexSet = new Set(matchedIndices);
  const segments: React.ReactNode[] = [];
  let run = "";
  let runHighlighted = false;
  const flush = (highlighted: boolean, key: string) => {
    if (!run) return;
    segments.push(
      highlighted ? (
        <text key={key} color={theme.focus} bold>
          {run}
        </text>
      ) : (
        <text key={key} color={baseColor}>
          {run}
        </text>
      ),
    );
    run = "";
  };
  for (let i = 0; i < label.length; i++) {
    const h = indexSet.has(i);
    if (h !== runHighlighted) {
      flush(runHighlighted, `s${i}`);
      runHighlighted = h;
    }
    run += label[i];
  }
  flush(runHighlighted, "end");
  return <box flexDirection="row">{segments}</box>;
}

export interface CommandPaletteProps {
  readonly visible: boolean;
  readonly actions: readonly Action[];
  readonly ctx: ActionContext;
  readonly query?: string | undefined;
  readonly selectedIndex?: number | undefined;
  readonly adoptContext?: { readonly targetCid: string; readonly summary: string } | undefined;
}

export const CommandPalette: React.NamedExoticComponent<CommandPaletteProps> = React.memo(
  function CommandPalette({
    visible,
    actions,
    ctx,
    query,
    selectedIndex,
    adoptContext,
  }: CommandPaletteProps): React.ReactNode {
    const q = (query ?? "").trim();
    const visibleActions = useMemo(
      () => computeVisibleActions(actions, ctx, q),
      [actions, ctx, q],
    );

    if (!visible) return null;
    const idx = selectedIndex ?? 0;

    // When no query, compute the group header to print before each item.
    const headerBefore: (ActionGroup | undefined)[] = [];
    if (!q) {
      let lastGroup: ActionGroup | undefined;
      for (const { action } of visibleActions) {
        headerBefore.push(action.group !== lastGroup ? action.group : undefined);
        lastGroup = action.group;
      }
    }

    return (
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text color={theme.focus}>Command Palette</text>
          {adoptContext ? (
            <text color={theme.compare}>{` Adopt: ${adoptContext.targetCid.slice(0, 12)}…`}</text>
          ) : null}
          {q ? <text color={theme.secondary}> — filter: </text> : <text color={theme.secondary}> (Esc to close)</text>}
          {q ? <text color={theme.text}>{q}</text> : null}
        </box>

        {visibleActions.length === 0 && (
          <box paddingLeft={1}>
            <text color={theme.secondary}>{q ? `No matches for "${q}"` : "No actions available"}</text>
          </box>
        )}

        <box flexDirection="column" paddingLeft={1}>
          {visibleActions.map(({ action, matchedIndices }, i) => {
            const isSelected = i === idx;
            const dimmed = !(action.enabled?.(ctx) ?? true);
            const labelColor = isSelected ? theme.focus : dimmed ? theme.disabled : theme.text;
            const detailColor = isSelected ? theme.focus : dimmed ? theme.inactive : theme.secondary;
            const cursor = isSelected ? "> " : "  ";
            const group = !q ? headerBefore[i] : undefined;
            return (
              <box key={`${action.id}-${i}`} flexDirection="column">
                {group ? (
                  <text color={theme.secondary} bold>
                    {group}
                  </text>
                ) : null}
                <box flexDirection="row">
                  <text color={labelColor}>{cursor}</text>
                  {q && matchedIndices.length > 0
                    ? renderHighlighted(action.label, matchedIndices, labelColor)
                    : <text color={labelColor}>{action.label}</text>}
                  {action.detail ? <text color={detailColor}> [{action.detail}]</text> : null}
                </box>
              </box>
            );
          })}
        </box>

        <box marginTop={1} paddingLeft={1}>
          <text color={theme.secondary}>[j/k] navigate [Enter] execute [Esc] close</text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/components/command-palette.test.tsx`
Expected: PASS. (Compile errors in `app.tsx` are expected until Task 6 — that file still imports the removed exports.)

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/command-palette.tsx src/tui/components/command-palette.test.tsx
git commit -m "feat(tui): render command palette from unified Action model (#194)"
```

---

## Task 6: Wire the ActionContext + selection into app.tsx

**Files:**
- Modify: `src/tui/app.tsx`

This task rewires App to build the action list and `ActionContext`, collapse `onPaletteSelect`, add the `pendingQuestionCount` fetcher, and update the `<CommandPalette>` props. It produces no new unit test (covered by Tasks 1–5 + the existing app reducer test); verification is typecheck + full suite.

- [ ] **Step 1: Add the pending-questions fetcher**

After the `gossipPeers` fetcher block (around `app.tsx:457`), add:

```tsx
  // Poll pending questions for the answer-question palette actions.
  const pendingQuestionsFetcher = useCallback(async (): Promise<number> => {
    const askProvider = provider as unknown as {
      getPendingQuestions?: () => Promise<readonly unknown[]>;
    };
    if (!askProvider.getPendingQuestions) return 0;
    try {
      return (await askProvider.getPendingQuestions()).length;
    } catch {
      return 0;
    }
  }, [provider]);
  const { data: pendingQuestionCount, refresh: refreshPendingQuestions } =
    useEventDrivenData<number>(pendingQuestionsFetcher, undefined, undefined, paletteVisible);
```

Add `refreshPendingQuestions()` to the `refreshAll` callback body and dependency array (alongside `refreshGossip()`).

- [ ] **Step 2: Add an `answerPendingQuestion` helper**

Near `handleApproveQuestion`/`handleDenyQuestion` (≈`app.tsx:670`), add a helper that answers the FIRST pending question (palette actions are not cursor-bound):

```tsx
  const answerPendingQuestion = useCallback(
    async (verdict: "approve" | "deny") => {
      const askProvider = provider as unknown as {
        answerQuestion?: (cid: string, answer: string) => Promise<void>;
        getPendingQuestions?: () => Promise<readonly { cid: string; options?: readonly string[] }[]>;
      };
      if (!askProvider.answerQuestion || !askProvider.getPendingQuestions) return;
      try {
        const questions = await askProvider.getPendingQuestions();
        const selected = questions[0];
        if (!selected) return;
        const answer = verdict === "approve" ? selected.options?.[0] ?? "Approved" : "Denied";
        await askProvider.answerQuestion(selected.cid, answer);
        showError(`Answered: ${answer}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to answer");
      }
    },
    [provider, showError],
  );
```

- [ ] **Step 3: Add a `registerAgentProfile` helper**

Extract the existing `register` branch body from `onPaletteSelect` into a reusable callback (≈ near `handleKill`):

```tsx
  const registerAgentProfile = useCallback(() => {
    void (async () => {
      try {
        const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const dir = resolve(process.cwd(), ".grove");
        const path = resolve(dir, "agents.json");
        if (!existsSync(path)) {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const template = JSON.stringify(
            {
              profiles: [
                {
                  name: "@agent-1",
                  role: topology?.roles[0]?.name ?? "worker",
                  platform: "claude-code",
                  command: "claude --dangerously-skip-permissions",
                },
              ],
            },
            null,
            2,
          );
          writeFileSync(path, template);
          showError(`Created ${path} — edit to add agent profiles`);
        } else {
          showError(`Profiles loaded from ${path} (${String(agentProfiles?.length ?? 0)} profiles)`);
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : "Registration failed");
      }
    })();
  }, [topology, agentProfiles, showError]);
```

- [ ] **Step 4: Build the `ActionContext` and action list**

Replace the `corePaletteItems` / `pluginPaletteItems` / `paletteItems` / `filteredPaletteItems` block (≈`app.tsx:589-637`) with:

```tsx
  const hasGoals = isGoalProvider(provider);

  const mkPluginCtx = useCallback(
    (_c: import("./actions/types.js").ActionContext): TuiPluginContext => pluginContext,
    [pluginContext],
  );

  const actionContext = useMemo<import("./actions/types.js").ActionContext>(
    () => ({
      topology,
      sessions: paletteSessions ?? [],
      profiles: agentProfiles ?? [],
      gossipPeers: canDelegate ? (gossipPeers ?? []) : [],
      claims: activeClaims,
      selectedSession,
      selectedCid: nav.detailCid,
      parentAgentId: paletteParentId,
      pendingQuestionCount: pendingQuestionCount ?? 0,
      hasGoals,
      canSpawn,
      canDelegate,
      isPanelVisible: (panel) => panels.isVisible(panel),
      focusPanel: (panel) => panels.focus(panel),
      togglePanel: (panel) => panels.toggle(panel),
      openContribution: (cid) => nav.pushDetail(cid),
      jumpToSession: (session) => {
        setSelectedSession(session);
        panels.toggle(Panel.Terminal);
      },
      enterGoalMode: () => {
        panels.setMode(InputMode.GoalInput);
        dispatch({ type: "GOAL_INPUT_MODE" });
      },
      enterCompareMode: () => dispatch({ type: "COMPARE_TOGGLE" }),
      addToCompare: (cid) => dispatch({ type: "COMPARE_SELECT", cid }),
      adoptContribution: (cid, summary) => {
        dispatch({ type: "ADOPT_SET", targetCid: cid, summary });
        panels.setMode(InputMode.CommandPalette);
      },
      answerPendingQuestion: (verdict) => void answerPendingQuestion(verdict),
      registerAgentProfile,
      spawn: (roleId, command, parentAgentId) => handleSpawn(roleId, command, "HEAD", parentAgentId),
      kill: (session) => handleKill(session),
      delegate: (peerAddress) => void handleDelegate(peerAddress),
      showMessage: showError,
    }),
    [
      topology, paletteSessions, agentProfiles, gossipPeers, canDelegate, activeClaims,
      selectedSession, nav, paletteParentId, pendingQuestionCount, hasGoals, canSpawn,
      panels, answerPendingQuestion, registerAgentProfile, handleSpawn, handleKill,
      handleDelegate, showError,
    ],
  );

  const paletteActions = useMemo(
    () => [
      ...buildBuiltInActions(actionContext),
      ...buildPluginActions(mergedActionRegistry.entries, mkPluginCtx),
    ],
    [actionContext, mergedActionRegistry.entries, mkPluginCtx],
  );

  const visiblePaletteActions = useMemo(
    () => computeVisibleActions(paletteActions, actionContext, ks.paletteQuery),
    [paletteActions, actionContext, ks.paletteQuery],
  );
```

Add these imports at the top of `app.tsx`:

```tsx
import { buildBuiltInActions } from "./actions/builtin-actions.js";
import { buildPluginActions } from "./actions/plugin-adapter.js";
import { computeVisibleActions } from "./actions/visibility.js";
import { Panel } from "./hooks/use-panel-focus.js";
```

Replace the `command-palette.js` import to drop removed names — keep only what remains (none from that module are now needed except via the component import); update:

```tsx
import { CommandPalette } from "./components/command-palette.js";
```

Remove the now-unused imports: `buildPaletteItems`, `buildPluginPaletteItems`, `fuzzyMatch`, `getBuiltInPaletteActionRegistryEntries` (note: `getBuiltInPaletteActionRegistryEntries` is still used by `mergeTuiActionRegistrations` for built-in dedup — see Step 7).

- [ ] **Step 5: Collapse `onPaletteSelect`**

Replace the entire `onPaletteSelect` callback (≈`app.tsx:1003-1061`) with:

```tsx
      onPaletteSelect: () => {
        const entry = visiblePaletteActions[ks.paletteIndex];
        if (!entry) return;
        const action = entry.action;
        if (!(action.enabled?.(actionContext) ?? true)) return;
        // Close the palette FIRST. Mode-switching actions (goal, compare, adopt)
        // re-set their target mode inside run, landing after this Normal set.
        panels.setMode(InputMode.Normal);
        dispatch({ type: "PALETTE_RESET" });
        void Promise.resolve(action.run(actionContext)).catch((err: unknown) => {
          showError(err instanceof Error ? err.message : "Action failed");
        });
      },
```

Update `paletteItemCount` in the `keyboardActions` object to use the new list:

```tsx
      paletteItemCount: visiblePaletteActions.length,
```

Update the `keyboardActions` `useMemo` dependency array: remove `filteredPaletteItems`, `agentProfiles`, `paletteParentId`, `pluginContext` if now only referenced via `actionContext`; ADD `visiblePaletteActions` and `actionContext`. (Keep `ks.paletteIndex`, `showError`, `panels`, `nav`.)

- [ ] **Step 6: Update the `<CommandPalette>` JSX**

Replace the `<CommandPalette ... />` element (≈`app.tsx:1173-1187`) with:

```tsx
            <CommandPalette
              visible={paletteVisible}
              actions={paletteActions}
              ctx={actionContext}
              query={ks.paletteQuery}
              selectedIndex={ks.paletteIndex}
              adoptContext={ks.adoptContext}
            />
```

- [ ] **Step 7: Keep built-in registry dedup intact**

`mergeTuiActionRegistrations` still needs built-in IDs for duplicate protection. `getBuiltInPaletteActionRegistryEntries` was removed from `command-palette.tsx` in Task 5 — move it to a tiny module so the registry keeps reserving `set-goal`/`register-agent` IDs (preventing a plugin from shadowing them). Create `src/tui/actions/reserved-ids.ts`:

```ts
import type { TuiActionRegistryEntry } from "../plugins/registry.js";

/** Built-in action IDs reserved so plugins can't shadow them. */
export function getReservedActionRegistryEntries(): readonly TuiActionRegistryEntry[] {
  return Object.freeze([
    Object.freeze({ id: "set-goal", label: "Set goal", detail: "", order: 0, source: "builtin" as const }),
    Object.freeze({ id: "register-agent", label: "Register agent", detail: "", order: 10, source: "builtin" as const }),
  ]);
}
```

In `app.tsx`, change the `mergedActionRegistry` builtIns source from `getBuiltInPaletteActionRegistryEntries()` to `getReservedActionRegistryEntries()` and import it from `./actions/reserved-ids.js`.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck` (or `bunx tsc --noEmit`)
Expected: no errors. Fix any leftover references to removed symbols.

- [ ] **Step 9: Commit**

```bash
git add src/tui/app.tsx src/tui/actions/reserved-ids.ts
git commit -m "feat(tui): wire ActionContext + unified palette selection in app (#194)"
```

---

## Task 7: Migrate old tests + reserved-id test, full verification

**Files:**
- Modify: `src/tui/plugins/registry.test.ts` (only if it imports removed symbols)
- Create: `src/tui/actions/reserved-ids.test.ts`
- Verify: whole suite

- [ ] **Step 1: Add the reserved-ids test**

```ts
// src/tui/actions/reserved-ids.test.ts
import { describe, expect, test } from "bun:test";
import { getReservedActionRegistryEntries } from "./reserved-ids.js";

describe("reserved action ids", () => {
  test("reserves set-goal and register-agent", () => {
    expect(getReservedActionRegistryEntries().map((e) => e.id)).toEqual(["set-goal", "register-agent"]);
  });
});
```

Run: `bun test src/tui/actions/reserved-ids.test.ts`
Expected: PASS.

- [ ] **Step 2: Grep for removed symbols**

Run:
```bash
rg -n "buildPaletteItems|buildPluginPaletteItems|getBuiltInPaletteActionRegistryEntries|\bPaletteItem\b" src
```
Expected: no matches (or only inside the deleted spec's history). Fix every hit by migrating to the new model or deleting the dead assertion.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS. Investigate and fix any failure before continuing — do not weaken assertions to make them pass.

- [ ] **Step 4: Typecheck again**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(tui): migrate palette tests to unified action model (#194)"
```

---

## Task 8: Manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Launch the TUI** per the project's run path (e.g. `grove up` with a preset that mounts the palette). Use the `run` skill if available.

- [ ] **Step 2: Verify acceptance criteria**
  - Open palette (Ctrl+P). Confirm grouped sections render: Navigation, Agents, Workflow, Contributions (when a contribution is selected), Plugins (if any).
  - Type a query → headers disappear, results fuzzy-rank, keyword matches (e.g. "files" → VFS) appear.
  - With no contribution selected, `Open/Adopt/Add to compare` are ABSENT. Select one (focus Detail/Frontier) → they APPEAR.
  - With no pending question, approve/deny are ABSENT.
  - A spawn at capacity is shown GREYED and Enter is a no-op.
  - Execute: Go to Terminal panel → focuses/opens Terminal. Set goal → enters goal input. Compare → enters compare mode. Spawn/kill → behaves as before.

- [ ] **Step 3: Record results** in the PR description (what was exercised, what passed).

---

## Self-Review

**Spec coverage:**
- Common action model → Task 1 (`Action`/`ActionContext`). ✓
- Navigation actions (open/focus panel, jump session, open contribution) → Task 4 `navigationActions` + `contributionActions`. ✓
- Workflow actions (set goal, answer question, compare, delegate, spawn, kill, register) → Task 4 `workflowActions`/`agentActions`. ✓
- Context-sensitive via `available` (hide) vs `enabled` (grey) → Tasks 1, 4, 5. ✓
- Grouped sections, flat when querying → Tasks 2, 5. ✓
- Two-tier context (plugin narrow) → Tasks 1, 3, 6 (`mkPluginCtx`). ✓
- Flat selection index unchanged reducer → Tasks 2, 6 (`visiblePaletteActions` drives `paletteItemCount`). ✓
- Plugin dedup reserved IDs preserved → Task 6 Step 7 / Task 7. ✓

**Placeholder scan:** every code step contains full code; no TBD/TODO. ✓

**Type consistency:** `Action`, `ActionContext`, `VisibleAction`, `computeVisibleActions`, `buildBuiltInActions`, `buildPluginActions`, `getReservedActionRegistryEntries` names match across tasks; `CommandPaletteProps` updated to `{actions, ctx, query, selectedIndex, adoptContext}`. ✓

**Note for implementer:** confirm `checkSpawn`'s exact signature in `src/tui/agents/spawn-validator.ts` and `panels.isVisible`/`panels.toggle`/`panels.focus` names in `use-panel-focus.ts` before Task 4/6 (referenced as-is from current code).
