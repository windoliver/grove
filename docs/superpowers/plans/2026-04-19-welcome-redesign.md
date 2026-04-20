# Welcome Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic `src/tui/views/welcome.tsx` with an adaptive welcome module that fast-paths returning operators to a rich session list (Enter-to-resume) and walks first-time users through a two-screen mode-first wizard (Local vs Connected, optional Tab-to-customize covering preset, name, and keybinding).

**Architecture:** Decompose welcome into a `views/welcome/` directory with ~10 single-purpose sub-views plus three pure modules (`router.ts`, `relative-time.ts`, `keymap-presets.ts`) and per-screen pure keyboard routers mirroring `screens/running-keyboard.ts`. Top-level `index.tsx` routes based on grove existence and session count; `TuiApp` gains an `onNewSession` callback and widens `onResume` to take a session id.

**Tech Stack:** React + opentui/react for rendering, bun:test for unit tests, Zod for JSON validation (already in use), existing `config-loader.ts` machinery (issue #195) for keybinding preset persistence.

**Spec:** `docs/superpowers/specs/2026-04-19-welcome-redesign-design.md` (commit `0f39369`).

---

## File Inventory

**New files:**
- `src/tui/views/welcome/router.ts` — pure routing decision + mode-default preset resolver
- `src/tui/views/welcome/router.test.ts`
- `src/tui/views/welcome/relative-time.ts` — pure timestamp → label formatter
- `src/tui/views/welcome/relative-time.test.ts`
- `src/tui/views/welcome/keymap-presets.ts` — load vim/emacs preset JSONs, merge into config
- `src/tui/views/welcome/keymap-presets.test.ts`
- `src/tui/keymaps/vim.json`
- `src/tui/keymaps/emacs.json`
- `src/tui/views/welcome/session-row.tsx` — rich/compact row renderer (pure compute + component)
- `src/tui/views/welcome/session-row.test.ts`
- `src/tui/views/welcome/fast-path-keyboard.ts` — pure key router for fast-path
- `src/tui/views/welcome/fast-path-keyboard.test.ts`
- `src/tui/views/welcome/fast-path.tsx`
- `src/tui/views/welcome/mode-picker-keyboard.ts`
- `src/tui/views/welcome/mode-picker-keyboard.test.ts`
- `src/tui/views/welcome/mode-picker.tsx`
- `src/tui/views/welcome/customize-keyboard.ts`
- `src/tui/views/welcome/customize-keyboard.test.ts`
- `src/tui/views/welcome/customize.tsx`
- `src/tui/views/welcome/first-run.tsx`
- `src/tui/views/welcome/new-session-keyboard.ts`
- `src/tui/views/welcome/new-session-keyboard.test.ts`
- `src/tui/views/welcome/new-session.tsx`
- `src/tui/views/welcome/connect.tsx`
- `src/tui/views/welcome/index.tsx` — top-level router + glossary overlay host
- `src/tui/views/welcome/glossary.ts` — concept definitions (moved from old welcome.tsx)

**Modified files:**
- `src/tui/tui-app.tsx` — new `onNewSession` prop; `onResume(sessionId?)` signature; import from `./views/welcome/index.js`; state handling for new-session transition.
- `src/tui/main.ts` — implement `onNewSession` callback; thread `sessionId` through `onResume`.

**Deleted files:**
- `src/tui/views/welcome.tsx`

---

## Task 1: Pure Router Module

**Files:**
- Create: `src/tui/views/welcome/router.ts`
- Test: `src/tui/views/welcome/router.test.ts`

Router decides which branch (fast-path, first-run, connect, new-session) to render based on grove state. Also exposes mode→default-preset resolution used by first-run.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provider.js";
import {
  resolveDefaultPreset,
  resolveInitialRoute,
  type WelcomeMode,
  type WelcomeRoute,
} from "./router.js";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    goal: "goal",
    status: "active",
    createdAt: new Date().toISOString(),
    contributionCount: 0,
    ...over,
  } as SessionRecord;
}

describe("resolveInitialRoute", () => {
  test("no grove → first-run mode step", () => {
    const r = resolveInitialRoute({ groveExists: false, sessions: [] });
    expect(r).toEqual({ kind: "first-run", step: "mode" });
  });

  test("grove exists, zero sessions → fast-path", () => {
    const r = resolveInitialRoute({ groveExists: true, sessions: [] });
    expect(r).toEqual({ kind: "fast-path" });
  });

  test("grove exists, active sessions → fast-path", () => {
    const r = resolveInitialRoute({
      groveExists: true,
      sessions: [session(), session({ id: "s2", status: "completed" })],
    });
    expect(r).toEqual({ kind: "fast-path" });
  });

  test("grove exists with archived-only sessions → fast-path", () => {
    const r = resolveInitialRoute({
      groveExists: true,
      sessions: [session({ status: "archived" })],
    });
    expect(r).toEqual({ kind: "fast-path" });
  });
});

describe("resolveDefaultPreset", () => {
  const presets = [
    { name: "coder", description: "" },
    { name: "reviewer-pair", description: "" },
    { name: "team-pair", description: "" },
    { name: "team-swarm", description: "" },
  ];

  test("local mode → first preset", () => {
    expect(resolveDefaultPreset("local", presets)).toBe("coder");
  });

  test("connected mode → first team-* preset", () => {
    expect(resolveDefaultPreset("connected", presets)).toBe("team-pair");
  });

  test("connected mode with no team preset → first preset fallback", () => {
    expect(
      resolveDefaultPreset("connected", [
        { name: "coder", description: "" },
        { name: "reviewer-pair", description: "" },
      ]),
    ).toBe("coder");
  });

  test("empty preset list returns undefined", () => {
    expect(resolveDefaultPreset("local", [])).toBeUndefined();
    expect(resolveDefaultPreset("connected", [])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/router.test.ts`
Expected: FAIL — `Cannot find module './router.js'`

- [ ] **Step 3: Implement router module**

Create `src/tui/views/welcome/router.ts`:

```ts
/**
 * Pure routing decisions for the welcome flow.
 *
 * Decides which top-level branch (fast-path, first-run, connect, new-session)
 * the welcome UI should render based on grove existence and session inventory.
 * Also resolves the default preset for each first-run mode.
 *
 * Kept free of React and I/O so it can be unit-tested in isolation.
 */

import type { SessionRecord } from "../../provider.js";

/** First-run mode axis: backend selection. */
export type WelcomeMode = "local" | "connected";

/** Route the welcome UI should render. */
export type WelcomeRoute =
  | { readonly kind: "fast-path" }
  | { readonly kind: "first-run"; readonly step: "mode" | "customize" }
  | { readonly kind: "new-session" }
  | { readonly kind: "connect"; readonly returnTo: "fast-path" | "first-run" };

/** Input for initial route resolution. */
export interface RouterInput {
  readonly groveExists: boolean;
  readonly sessions: readonly SessionRecord[];
}

/** Preset shape consumed by default-preset resolution. */
export interface PresetLite {
  readonly name: string;
  readonly description: string;
}

/**
 * Pick the starting welcome route.
 *
 *  - No grove → first-run wizard (mode picker).
 *  - Grove exists (any session count) → fast-path. Empty list rendered inside.
 *
 * `autoConnectNexus` is handled upstream in `TuiApp` and does not reach here.
 */
export function resolveInitialRoute(input: RouterInput): WelcomeRoute {
  if (!input.groveExists) {
    return { kind: "first-run", step: "mode" };
  }
  return { kind: "fast-path" };
}

/**
 * Resolve the default preset name for a first-run mode.
 *
 *  - Local: first preset in list (smallest / most generic).
 *  - Connected: first preset whose name starts with `team-`; falls back to
 *    first preset overall if none match.
 */
export function resolveDefaultPreset(
  mode: WelcomeMode,
  presets: readonly PresetLite[],
): string | undefined {
  if (presets.length === 0) return undefined;
  if (mode === "local") return presets[0]?.name;
  const team = presets.find((p) => p.name.startsWith("team-"));
  return team?.name ?? presets[0]?.name;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/views/welcome/router.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/router.ts src/tui/views/welcome/router.test.ts
git commit -m "feat(tui): pure welcome router module (#190)"
```

---

## Task 2: Relative-time Formatter

**Files:**
- Create: `src/tui/views/welcome/relative-time.ts`
- Test: `src/tui/views/welcome/relative-time.test.ts`

Deterministic relative-time formatter; takes `now` explicitly so tests can pin a reference time.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/relative-time.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatRelativeTime } from "./relative-time.js";

const NOW = new Date("2026-04-19T12:00:00Z").getTime();

function iso(msOffset: number): string {
  return new Date(NOW - msOffset).toISOString();
}

describe("formatRelativeTime", () => {
  test("< 60 s → 'just now'", () => {
    expect(formatRelativeTime(iso(0), NOW)).toBe("just now");
    expect(formatRelativeTime(iso(30_000), NOW)).toBe("just now");
  });

  test("< 60 m → 'Nm'", () => {
    expect(formatRelativeTime(iso(60_000), NOW)).toBe("1m");
    expect(formatRelativeTime(iso(59 * 60_000), NOW)).toBe("59m");
  });

  test("< 24 h → 'Nh'", () => {
    expect(formatRelativeTime(iso(60 * 60_000), NOW)).toBe("1h");
    expect(formatRelativeTime(iso(23 * 60 * 60_000), NOW)).toBe("23h");
  });

  test("exactly 24 h → 'yesterday'", () => {
    expect(formatRelativeTime(iso(24 * 60 * 60_000), NOW)).toBe("yesterday");
  });

  test("< 7 d → 'Nd ago'", () => {
    expect(formatRelativeTime(iso(2 * 24 * 60 * 60_000), NOW)).toBe("2d ago");
    expect(formatRelativeTime(iso(6 * 24 * 60 * 60_000), NOW)).toBe("6d ago");
  });

  test("≥ 7 d → absolute short date", () => {
    // 10 days ago = 2026-04-09
    expect(formatRelativeTime(iso(10 * 24 * 60 * 60_000), NOW)).toMatch(
      /Apr\s+9/,
    );
  });

  test("invalid input returns empty string", () => {
    expect(formatRelativeTime(undefined, NOW)).toBe("");
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/relative-time.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/tui/views/welcome/relative-time.ts`:

```ts
/**
 * Pure relative-time formatter for session rows.
 *
 * Takes `now` explicitly so callers can pin a reference time for testing
 * and so animation-free UI doesn't need clock access during render.
 *
 * Buckets:
 *   < 60 s        → "just now"
 *   < 60 m        → "Nm"
 *   < 24 h        → "Nh"
 *   = 24 h ± 1h   → "yesterday"
 *   < 7 d         → "Nd ago"
 *   ≥ 7 d         → "MMM D" (absolute short date, en-US)
 *
 * Returns empty string for unparseable input.
 */
export function formatRelativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";

  const diff = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  // 24h window → "yesterday"
  if (diff < day + hour) return "yesterday";
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/relative-time.test.ts`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/relative-time.ts src/tui/views/welcome/relative-time.test.ts
git commit -m "feat(tui): relative-time formatter for welcome session rows (#190)"
```

---

## Task 3: Keymap Preset Files and Loader

**Files:**
- Create: `src/tui/keymaps/vim.json`
- Create: `src/tui/keymaps/emacs.json`
- Create: `src/tui/views/welcome/keymap-presets.ts`
- Test: `src/tui/views/welcome/keymap-presets.test.ts`

Keymap presets ship as JSON resources alongside built-in themes. `applyKeymapPreset` reads the preset, merges its `keymap` block into `~/.config/grove/config.json` using the existing `mergeGroveConfig` semantics, leaving theme and unrelated keymap entries untouched.

- [ ] **Step 1: Create preset JSON files**

Create `src/tui/keymaps/vim.json`:

```json
{
  "keymap": {
    "quit": "q",
    "help": "?",
    "palette": "m",
    "search_start": "/"
  }
}
```

Create `src/tui/keymaps/emacs.json`:

```json
{
  "keymap": {
    "quit": "C-x C-c",
    "help": "C-h",
    "palette": "M-x",
    "search_start": "C-s"
  }
}
```

*(Content is intentionally conservative — four well-understood actions. Future presets may add more; schema is forward-compatible because `config-loader.ts` strips unknown keys and the keybinding loader ignores unknown actions.)*

- [ ] **Step 2: Write the failing tests**

Create `src/tui/views/welcome/keymap-presets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyKeymapPresetToFile,
  loadKeymapPreset,
  type KeymapPresetName,
} from "./keymap-presets.js";

describe("loadKeymapPreset", () => {
  test("loads vim preset", async () => {
    const p = await loadKeymapPreset("vim");
    expect(p.keymap.quit).toBe("q");
    expect(p.keymap.search_start).toBe("/");
  });

  test("loads emacs preset", async () => {
    const p = await loadKeymapPreset("emacs");
    expect(p.keymap.help).toBe("C-h");
  });
});

describe("applyKeymapPresetToFile", () => {
  test("writes a fresh config.json when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("vim" as KeymapPresetName, target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("q");
    expect(raw.theme ?? {}).toEqual({});
  });

  test("merges keymap block into existing config without touching theme", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(
      target,
      JSON.stringify({
        theme: { text: "#FFFFFF" },
        keymap: { approve: "A" },
      }),
    );
    await applyKeymapPresetToFile("emacs", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.theme.text).toBe("#FFFFFF");
    expect(raw.keymap.approve).toBe("A"); // untouched
    expect(raw.keymap.help).toBe("C-h"); // from preset
  });

  test("overwrites preset keys on re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("vim", target);
    await applyKeymapPresetToFile("emacs", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("C-x C-c");
  });

  test("corrupted existing config is treated as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(target, "{ not valid json");
    await applyKeymapPresetToFile("vim", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("q");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/keymap-presets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/tui/views/welcome/keymap-presets.ts`:

```ts
/**
 * Keymap presets — bundled as JSON imports so the merge works under both
 * `bun run` (source) and the tsup-built output (no filesystem lookup).
 *
 * Merge semantics reuse `config-loader.ts`'s `mergeGroveConfig`: keymap
 * entries are additive, the existing theme block is preserved verbatim.
 *
 * Two named presets today: `vim` and `emacs`. The `none` sentinel exists
 * only in the UI layer (no-op; not handled here).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import emacsPresetRaw from "../../keymaps/emacs.json" with { type: "json" };
import vimPresetRaw from "../../keymaps/vim.json" with { type: "json" };
import { type GroveUserConfig, mergeGroveConfig } from "../../config-loader.js";

/** Named keymap preset identifiers bundled with the TUI. */
export type KeymapPresetName = "vim" | "emacs";

interface RawPreset {
  readonly keymap: Record<string, string>;
}

const PRESETS: Readonly<Record<KeymapPresetName, RawPreset>> = {
  vim: vimPresetRaw as RawPreset,
  emacs: emacsPresetRaw as RawPreset,
};

/** Load a bundled keymap preset into a `GroveUserConfig` shape. */
export async function loadKeymapPreset(
  name: KeymapPresetName,
): Promise<GroveUserConfig> {
  const preset = PRESETS[name];
  return {
    theme: {},
    keymap: preset.keymap as GroveUserConfig["keymap"],
  };
}

/**
 * Apply a preset to a target `config.json` file, merging into any existing
 * content. Used by the first-run wizard to persist the user's chosen
 * keymap preset to `~/.config/grove/config.json`.
 *
 * Corrupted or missing targets are treated as empty. Writes atomically via
 * temp-rename.
 */
export async function applyKeymapPresetToFile(
  name: KeymapPresetName,
  targetPath: string,
): Promise<void> {
  const preset = await loadKeymapPreset(name);

  let existing: GroveUserConfig = { theme: {}, keymap: {} };
  try {
    const raw = await readFile(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { theme?: unknown; keymap?: unknown };
      existing = {
        theme: (obj.theme ?? {}) as GroveUserConfig["theme"],
        keymap: (obj.keymap ?? {}) as GroveUserConfig["keymap"],
      };
    }
  } catch {
    // ENOENT or parse error — existing stays empty.
  }

  const merged = mergeGroveConfig(existing, preset);
  const out = { theme: merged.theme, keymap: merged.keymap };

  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf-8");
  await rename(tmp, targetPath);
}
```

Ensure `tsconfig.json` permits JSON imports. Check with:
```bash
grep -E "resolveJsonModule|allowImportingTsExtensions" tsconfig.json
```
If `resolveJsonModule` is missing, add `"resolveJsonModule": true` to `compilerOptions` in that same task step (commit bundled with Task 3).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/tui/views/welcome/keymap-presets.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/tui/keymaps/vim.json src/tui/keymaps/emacs.json \
        src/tui/views/welcome/keymap-presets.ts \
        src/tui/views/welcome/keymap-presets.test.ts
git commit -m "feat(tui): keymap presets (vim/emacs) loader + merge (#190)"
```

---

## Task 4: Session-row Compute Helpers

**Files:**
- Create: `src/tui/views/welcome/session-row.tsx` (component + exported pure compute)
- Test: `src/tui/views/welcome/session-row.test.ts`

Extract `computeSessionRowFields()` as a pure function so row rendering (rich vs compact, dot glyph, concatenated metadata line) can be tested without mounting React.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/session-row.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provider.js";
import { computeSessionRowFields } from "./session-row.js";

const NOW = new Date("2026-04-19T12:00:00Z").getTime();

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    goal: "refactor welcome",
    status: "active",
    createdAt: new Date(NOW - 3 * 60_000).toISOString(), // 3m ago
    contributionCount: 42,
    topology: undefined,
    ...over,
  } as SessionRecord;
}

describe("computeSessionRowFields", () => {
  test("focused active session renders rich two-line output", () => {
    const r = computeSessionRowFields(session({ presetName: "reviewer-pair" }), {
      focused: true,
      now: NOW,
    });
    expect(r.dot).toBe("●");
    expect(r.primary).toContain("refactor welcome");
    expect(r.primary).toContain("3m");
    expect(r.primary).toContain("42c");
    expect(r.secondary).toContain("reviewer-pair");
    expect(r.rich).toBe(true);
  });

  test("unfocused completed session renders compact one-line", () => {
    const r = computeSessionRowFields(
      session({ status: "completed", contributionCount: 12 }),
      { focused: false, now: NOW },
    );
    expect(r.dot).toBe("○");
    expect(r.primary).toContain("12c");
    expect(r.secondary).toBeUndefined();
    expect(r.rich).toBe(false);
  });

  test("missing goal falls back to 'untitled'", () => {
    const r = computeSessionRowFields(session({ goal: undefined }), {
      focused: false,
      now: NOW,
    });
    expect(r.primary).toContain("untitled");
  });

  test("long goal is truncated to 50 chars", () => {
    const goal = "x".repeat(80);
    const r = computeSessionRowFields(session({ goal }), {
      focused: false,
      now: NOW,
    });
    expect(r.primary.length).toBeLessThanOrEqual(100); // includes metadata
    expect(r.primary).toContain("x".repeat(50));
    expect(r.primary).not.toContain("x".repeat(51));
  });

  test("archived session uses hollow dot like completed", () => {
    const r = computeSessionRowFields(
      session({ status: "archived" }),
      { focused: false, now: NOW },
    );
    expect(r.dot).toBe("○");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/session-row.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement compute + component**

Create `src/tui/views/welcome/session-row.tsx`:

```tsx
/**
 * Session row renderer for the welcome fast-path.
 *
 * Focused row renders rich (two lines, bold, more metadata).
 * Unfocused rows render compact (one dim line).
 *
 * `computeSessionRowFields` is a pure helper used by both this component
 * and the test suite.
 */

import React from "react";
import type { SessionRecord } from "../../provider.js";
import { theme } from "../../theme.js";
import { formatRelativeTime } from "./relative-time.js";

const GOAL_MAX = 50;

/** Props for a single session row. */
export interface SessionRowProps {
  readonly session: SessionRecord;
  readonly focused: boolean;
  readonly now?: number;
}

/** Computed fields used for rendering — exported for testability. */
export interface SessionRowFields {
  readonly dot: "●" | "○";
  readonly rich: boolean;
  readonly primary: string;
  readonly secondary: string | undefined;
}

/** Compute the flattened strings for a session row. */
export function computeSessionRowFields(
  session: SessionRecord,
  opts: { focused: boolean; now: number },
): SessionRowFields {
  const dot: "●" | "○" = session.status === "active" ? "●" : "○";
  const goal = (session.goal ?? "untitled").slice(0, GOAL_MAX);
  const when = formatRelativeTime(session.createdAt, opts.now);
  const count = `${session.contributionCount}c`;

  if (opts.focused) {
    const primary = `${dot} "${goal}"  ${count} · ${when}`;
    const topology = session.presetName ?? session.topology ?? "";
    const secondary = topology ? topology : undefined;
    return { dot, rich: true, primary, secondary };
  }

  return {
    dot,
    rich: false,
    primary: `${dot} "${goal}"  ${count} · ${when}`,
    secondary: undefined,
  };
}

/** Render a single session row. */
export const SessionRow: React.NamedExoticComponent<SessionRowProps> = React.memo(
  function SessionRow({ session, focused, now }: SessionRowProps): React.ReactNode {
    const fields = computeSessionRowFields(session, {
      focused,
      now: now ?? Date.now(),
    });
    const color = focused
      ? theme.focus
      : session.status === "active"
        ? theme.text
        : theme.secondary;
    return (
      <box
        flexDirection="column"
        backgroundColor={focused ? theme.selectedBg : undefined}
      >
        <text color={color} bold={focused}>
          {focused ? "> " : "  "}
          {fields.primary}
        </text>
        {fields.secondary ? (
          <text color={theme.secondary}>{`    ${fields.secondary}`}</text>
        ) : null}
      </box>
    );
  },
);
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/session-row.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/session-row.tsx src/tui/views/welcome/session-row.test.ts
git commit -m "feat(tui): session-row rich/compact renderer (#190)"
```

---

## Task 5: Fast-path Keyboard Router

**Files:**
- Create: `src/tui/views/welcome/fast-path-keyboard.ts`
- Test: `src/tui/views/welcome/fast-path-keyboard.test.ts`

Pure state+action key router, mirroring `screens/running-keyboard.ts`. The fast-path component wires `useKeyboard` to this.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/fast-path-keyboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type FastPathActions,
  type FastPathState,
  routeFastPathKey,
} from "./fast-path-keyboard.js";

function keyEvent(name: string, seq?: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    alt: false,
    option: false,
    sequence: seq ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

function defaultState(over: Partial<FastPathState> = {}): FastPathState {
  return {
    cursor: 0,
    visibleSessionIds: ["s1", "s2", "s3"],
    filterMode: false,
    filterText: "",
    archiveVisible: false,
    ...over,
  };
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: FastPathActions = {
    setCursor: (n) => calls.push({ name: "setCursor", args: [n] }),
    enterFilter: () => calls.push({ name: "enterFilter", args: [] }),
    exitFilter: () => calls.push({ name: "exitFilter", args: [] }),
    setFilterText: (s) => calls.push({ name: "setFilterText", args: [s] }),
    toggleArchive: () => calls.push({ name: "toggleArchive", args: [] }),
    onResume: (id) => calls.push({ name: "onResume", args: [id] }),
    onNewSession: () => calls.push({ name: "onNewSession", args: [] }),
    onConnect: () => calls.push({ name: "onConnect", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
  };
  return { calls, actions };
}

describe("routeFastPathKey (navigation)", () => {
  test("j moves cursor down, clamped", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("j"), defaultState({ cursor: 0 }), actions);
    expect(calls).toEqual([{ name: "setCursor", args: [1] }]);

    routeFastPathKey(keyEvent("j"), defaultState({ cursor: 2 }), actions);
    // clamped at last index
    expect(calls[1]).toEqual({ name: "setCursor", args: [2] });
  });

  test("k moves cursor up, clamped at 0", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("k"), defaultState({ cursor: 0 }), actions);
    expect(calls[0]).toEqual({ name: "setCursor", args: [0] });
  });

  test("down/up arrow mirror j/k", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("down"), defaultState({ cursor: 0 }), actions);
    routeFastPathKey(keyEvent("up"), defaultState({ cursor: 1 }), actions);
    expect(calls.map((c) => c.name)).toEqual(["setCursor", "setCursor"]);
  });
});

describe("routeFastPathKey (actions)", () => {
  test("Enter calls onResume with focused id", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("return"),
      defaultState({ cursor: 1 }),
      actions,
    );
    expect(calls).toEqual([{ name: "onResume", args: ["s2"] }]);
  });

  test("Enter on empty list is a no-op", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("return"),
      defaultState({ visibleSessionIds: [] }),
      actions,
    );
    expect(calls).toEqual([]);
  });

  test("n triggers onNewSession (outside filter)", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("n"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onNewSession", args: [] }]);
  });

  test("c triggers onConnect", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("c"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onConnect", args: [] }]);
  });

  test("q triggers onQuit", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("q"), defaultState(), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });

  test("a toggles archive visibility", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("a"), defaultState(), actions);
    expect(calls).toEqual([{ name: "toggleArchive", args: [] }]);
  });
});

describe("routeFastPathKey (filter mode)", () => {
  test("'/' enters filter mode", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(keyEvent("slash", "/"), defaultState(), actions);
    expect(calls).toEqual([{ name: "enterFilter", args: [] }]);
  });

  test("printable input in filter mode appends to filter text", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("a"),
      defaultState({ filterMode: true, filterText: "fo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "setFilterText", args: ["foa"] }]);
  });

  test("backspace in filter mode pops one char", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("backspace"),
      defaultState({ filterMode: true, filterText: "foo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "setFilterText", args: ["fo"] }]);
  });

  test("Esc in filter mode exits without clearing text semantics", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("escape"),
      defaultState({ filterMode: true, filterText: "foo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "exitFilter", args: [] }]);
  });

  test("n in filter mode is treated as filter text, not new-session", () => {
    const { calls, actions } = tracker();
    routeFastPathKey(
      keyEvent("n"),
      defaultState({ filterMode: true, filterText: "" }),
      actions,
    );
    expect(calls).toEqual([{ name: "setFilterText", args: ["n"] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/fast-path-keyboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/tui/views/welcome/fast-path-keyboard.ts`:

```ts
/**
 * Pure keyboard routing for the welcome fast-path.
 *
 * State shape is minimal: cursor, visible session ids (filtered + archive
 * toggle applied by the caller), and filter-mode flags. Actions are pure
 * callbacks invoked by the caller.
 *
 * Mirrors the pattern in `screens/running-keyboard.ts`.
 */

import type { KeyEvent } from "@opentui/core";

/** Mutable state as seen by the fast-path keyboard handler. */
export interface FastPathState {
  readonly cursor: number;
  readonly visibleSessionIds: readonly string[];
  readonly filterMode: boolean;
  readonly filterText: string;
  readonly archiveVisible: boolean;
}

/** Side-effecting hooks wired by the fast-path component. */
export interface FastPathActions {
  readonly setCursor: (next: number) => void;
  readonly enterFilter: () => void;
  readonly exitFilter: () => void;
  readonly setFilterText: (next: string) => void;
  readonly toggleArchive: () => void;
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: () => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

/** Route a single key event. Returns true if the event was consumed. */
export function routeFastPathKey(
  key: KeyEvent,
  state: FastPathState,
  actions: FastPathActions,
): boolean {
  const name = key.name;

  if (state.filterMode) {
    if (name === "escape") {
      actions.exitFilter();
      return true;
    }
    if (name === "return") {
      actions.exitFilter();
      return true;
    }
    if (name === "backspace") {
      actions.setFilterText(state.filterText.slice(0, -1));
      return true;
    }
    if (name === "space") {
      actions.setFilterText(`${state.filterText} `);
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.setFilterText(state.filterText + name);
      return true;
    }
    return false;
  }

  // Normal mode
  if (name === "j" || name === "down") {
    const max = Math.max(0, state.visibleSessionIds.length - 1);
    actions.setCursor(Math.min(state.cursor + 1, max));
    return true;
  }
  if (name === "k" || name === "up") {
    actions.setCursor(Math.max(state.cursor - 1, 0));
    return true;
  }
  if (name === "return") {
    const id = state.visibleSessionIds[state.cursor];
    if (id) actions.onResume(id);
    return true;
  }
  if (name === "n") {
    actions.onNewSession();
    return true;
  }
  if (name === "c") {
    actions.onConnect();
    return true;
  }
  if (name === "a") {
    actions.toggleArchive();
    return true;
  }
  if (key.sequence === "/") {
    actions.enterFilter();
    return true;
  }
  if (name === "q") {
    actions.onQuit();
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/fast-path-keyboard.test.ts`
Expected: PASS — 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/fast-path-keyboard.ts \
        src/tui/views/welcome/fast-path-keyboard.test.ts
git commit -m "feat(tui): fast-path keyboard router (#190)"
```

---

## Task 6: Fast-path Component

**Files:**
- Create: `src/tui/views/welcome/fast-path.tsx`

Renders the session list, footer hints, empty-state, filter bar. Uses `SessionRow`, `routeFastPathKey`, and applies filter/archive to produce `visibleSessionIds`.

- [ ] **Step 1: Implement**

Create `src/tui/views/welcome/fast-path.tsx`:

```tsx
/**
 * Fast-path welcome screen — returning operator experience.
 *
 * Shows a session list with rich top-row rendering, filter, archive toggle,
 * and footer action hints. Enter resumes the focused session.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useMemo, useState } from "react";
import type { SessionRecord } from "../../provider.js";
import { theme } from "../../theme.js";
import { routeFastPathKey } from "./fast-path-keyboard.js";
import { SessionRow } from "./session-row.js";

export interface FastPathProps {
  readonly groveName: string;
  readonly sessions: readonly SessionRecord[];
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: () => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

const VISIBLE_WINDOW = 20;

export const FastPath: React.NamedExoticComponent<FastPathProps> = React.memo(
  function FastPath({
    groveName,
    sessions,
    onResume,
    onNewSession,
    onConnect,
    onQuit,
  }: FastPathProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [filterMode, setFilterMode] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [archiveVisible, setArchiveVisible] = useState(false);
    void useRenderer();

    // Apply archive toggle and filter — in that order.
    const visibleSessions = useMemo(() => {
      const archived = sessions.filter((s) => s.status === "archived");
      const base = archiveVisible ? sessions : sessions.filter((s) => s.status !== "archived");
      if (!filterText) return base;
      const needle = filterText.toLowerCase();
      return base.filter((s) => (s.goal ?? "").toLowerCase().includes(needle));
    }, [sessions, filterText, archiveVisible]);

    const archivedCount = sessions.filter((s) => s.status === "archived").length;
    const activeCount = sessions.filter((s) => s.status === "active").length;

    const visibleIds = useMemo(
      () => visibleSessions.map((s) => s.id),
      [visibleSessions],
    );

    useKeyboard(
      useCallback(
        (key) => {
          routeFastPathKey(
            key,
            { cursor, visibleSessionIds: visibleIds, filterMode, filterText, archiveVisible },
            {
              setCursor: (n) => setCursor(Math.min(n, Math.max(0, visibleIds.length - 1))),
              enterFilter: () => {
                setFilterMode(true);
                setFilterText("");
              },
              exitFilter: () => {
                setFilterMode(false);
                setFilterText("");
                setCursor(0);
              },
              setFilterText,
              toggleArchive: () => setArchiveVisible((v) => !v),
              onResume,
              onNewSession,
              onConnect,
              onQuit,
            },
          );
        },
        [cursor, visibleIds, filterMode, filterText, archiveVisible, onResume, onNewSession, onConnect, onQuit],
      ),
    );

    // Windowing for long lists
    const windowStart = Math.max(0, cursor - Math.floor(VISIBLE_WINDOW / 2));
    const windowEnd = Math.min(visibleSessions.length, windowStart + VISIBLE_WINDOW);
    const windowed = visibleSessions.slice(windowStart, windowEnd);

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            {`Grove · ${groveName}`}
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>
            {`Continue session  (${activeCount} active${archivedCount > 0 ? `, ${archivedCount} archived` : ""})`}
          </text>
          {filterMode ? (
            <box flexDirection="row">
              <text color={theme.focus}>{"/ "}</text>
              <text>{filterText}</text>
              <text color={theme.focus}>▌</text>
            </box>
          ) : null}
        </box>

        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          {visibleSessions.length === 0 ? (
            sessions.length === 0 ? (
              <box flexDirection="column">
                <text color={theme.text}>{`Grove "${groveName}" ready.`}</text>
                <text color={theme.secondary}>No sessions yet. Press [n] to start one.</text>
              </box>
            ) : (
              <text color={theme.secondary}>
                {filterText ? "No sessions match filter" : "No visible sessions"}
              </text>
            )
          ) : null}
          {windowed.map((s, i) => {
            const globalIdx = windowStart + i;
            return (
              <SessionRow
                key={s.id}
                session={s}
                focused={globalIdx === cursor}
              />
            );
          })}
        </box>

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [Enter] resume  [n] new  [c] connect  [a] archive  [/] filter  [q] quit
          </text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 2: Manual smoke — type check**

Run: `bun run typecheck`
Expected: PASS — no errors introduced by the new file. (The file is not yet imported anywhere — this is a coverage check.)

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/welcome/fast-path.tsx
git commit -m "feat(tui): fast-path component with session list + filter (#190)"
```

---

## Task 7: Mode-picker Keyboard Router

**Files:**
- Create: `src/tui/views/welcome/mode-picker-keyboard.ts`
- Test: `src/tui/views/welcome/mode-picker-keyboard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/mode-picker-keyboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { WelcomeMode } from "./router.js";
import {
  type ModePickerActions,
  type ModePickerState,
  routeModePickerKey,
} from "./mode-picker-keyboard.js";

function keyEvent(name: string, seq?: string, shift = false): KeyEvent {
  return {
    name,
    ctrl: false,
    shift,
    meta: false,
    alt: false,
    option: false,
    sequence: seq ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: ModePickerActions = {
    setMode: (m) => calls.push({ name: "setMode", args: [m] }),
    startWithDefaults: () => calls.push({ name: "startWithDefaults", args: [] }),
    goToCustomize: () => calls.push({ name: "goToCustomize", args: [] }),
    openConnect: () => calls.push({ name: "openConnect", args: [] }),
    toggleGlossary: () => calls.push({ name: "toggleGlossary", args: [] }),
    onQuit: () => calls.push({ name: "onQuit", args: [] }),
  };
  return { calls, actions };
}

function state(over: Partial<ModePickerState> = {}): ModePickerState {
  return { mode: "local" as WelcomeMode, glossaryOpen: false, ...over };
}

describe("routeModePickerKey", () => {
  test("l / right selects connected", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("l"), state({ mode: "local" }), actions);
    routeModePickerKey(keyEvent("right"), state({ mode: "local" }), actions);
    expect(calls).toEqual([
      { name: "setMode", args: ["connected"] },
      { name: "setMode", args: ["connected"] },
    ]);
  });

  test("h / left selects local", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("h"), state({ mode: "connected" }), actions);
    routeModePickerKey(keyEvent("left"), state({ mode: "connected" }), actions);
    expect(calls).toEqual([
      { name: "setMode", args: ["local"] },
      { name: "setMode", args: ["local"] },
    ]);
  });

  test("Enter starts with defaults", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("return"), state(), actions);
    expect(calls).toEqual([{ name: "startWithDefaults", args: [] }]);
  });

  test("Tab routes to customize", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("tab"), state(), actions);
    expect(calls).toEqual([{ name: "goToCustomize", args: [] }]);
  });

  test("c opens connect", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("c"), state(), actions);
    expect(calls).toEqual([{ name: "openConnect", args: [] }]);
  });

  test("? toggles glossary", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("?", "?", true), state(), actions);
    expect(calls).toEqual([{ name: "toggleGlossary", args: [] }]);
  });

  test("Esc when glossary open closes it", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("escape"), state({ glossaryOpen: true }), actions);
    expect(calls).toEqual([{ name: "toggleGlossary", args: [] }]);
  });

  test("q quits", () => {
    const { calls, actions } = tracker();
    routeModePickerKey(keyEvent("q"), state(), actions);
    expect(calls).toEqual([{ name: "onQuit", args: [] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/mode-picker-keyboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/tui/views/welcome/mode-picker-keyboard.ts`:

```ts
/**
 * Pure keyboard routing for the first-run mode picker.
 */

import type { KeyEvent } from "@opentui/core";
import type { WelcomeMode } from "./router.js";

export interface ModePickerState {
  readonly mode: WelcomeMode;
  readonly glossaryOpen: boolean;
}

export interface ModePickerActions {
  readonly setMode: (m: WelcomeMode) => void;
  readonly startWithDefaults: () => void;
  readonly goToCustomize: () => void;
  readonly openConnect: () => void;
  readonly toggleGlossary: () => void;
  readonly onQuit: () => void;
}

export function routeModePickerKey(
  key: KeyEvent,
  state: ModePickerState,
  actions: ModePickerActions,
): boolean {
  const name = key.name;

  if (name === "l" || name === "right") {
    if (state.mode !== "connected") actions.setMode("connected");
    return true;
  }
  if (name === "h" || name === "left") {
    if (state.mode !== "local") actions.setMode("local");
    return true;
  }
  if (name === "return") {
    actions.startWithDefaults();
    return true;
  }
  if (name === "tab") {
    actions.goToCustomize();
    return true;
  }
  if (name === "c") {
    actions.openConnect();
    return true;
  }
  if (key.sequence === "?" || (key.shift && name === "?")) {
    actions.toggleGlossary();
    return true;
  }
  if (name === "escape") {
    if (state.glossaryOpen) {
      actions.toggleGlossary();
      return true;
    }
    return false;
  }
  if (name === "q" && !state.glossaryOpen) {
    actions.onQuit();
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/mode-picker-keyboard.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/mode-picker-keyboard.ts \
        src/tui/views/welcome/mode-picker-keyboard.test.ts
git commit -m "feat(tui): mode-picker keyboard router (#190)"
```

---

## Task 8: Mode-picker Component + Glossary

**Files:**
- Create: `src/tui/views/welcome/mode-picker.tsx`
- Create: `src/tui/views/welcome/glossary.ts`

Glossary is moved out of the old `welcome.tsx` to its own tiny module so the overlay is shared between views.

- [ ] **Step 1: Implement glossary module**

Create `src/tui/views/welcome/glossary.ts`:

```ts
/**
 * Concept glossary shown via `?` overlay on first-run.
 *
 * Moved out of the old `views/welcome.tsx` so the overlay can be summoned
 * from any first-run sub-view without duplicating copy.
 */

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: "Contribution", definition: "Immutable snapshot of work (code, review, discussion)" },
  { term: "DAG", definition: "Dependency graph of all contributions" },
  { term: "Frontier", definition: "Ranked leaderboard of best contributions per metric" },
  { term: "Claim", definition: "Lease-based lock preventing duplicate agent work" },
  { term: "Topology", definition: "Who talks to whom (coder\u2192reviewer, explorer\u2192critic)" },
  { term: "Nexus", definition: "Shared backend for multi-agent coordination" },
];
```

- [ ] **Step 2: Implement mode-picker component**

Create `src/tui/views/welcome/mode-picker.tsx`:

```tsx
/**
 * First-run mode picker — two backend cards (Local vs Connected).
 *
 * Uses `routeModePickerKey` for all key handling. Glossary overlay is
 * toggleable via `?` and shares its copy with other first-run sub-views.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { theme } from "../../theme.js";
import { GLOSSARY } from "./glossary.js";
import { routeModePickerKey } from "./mode-picker-keyboard.js";
import type { WelcomeMode } from "./router.js";

export interface ModePickerProps {
  readonly defaultPresetByMode: Readonly<Record<WelcomeMode, string | undefined>>;
  readonly onStartWithDefaults: (mode: WelcomeMode) => void;
  readonly onCustomize: (mode: WelcomeMode) => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

export const ModePicker: React.NamedExoticComponent<ModePickerProps> = React.memo(
  function ModePicker({
    defaultPresetByMode,
    onStartWithDefaults,
    onCustomize,
    onConnect,
    onQuit,
  }: ModePickerProps): React.ReactNode {
    const [mode, setMode] = useState<WelcomeMode>("local");
    const [glossaryOpen, setGlossaryOpen] = useState(false);
    void useRenderer();

    useKeyboard(
      useCallback(
        (key) => {
          routeModePickerKey(
            key,
            { mode, glossaryOpen },
            {
              setMode,
              startWithDefaults: () => onStartWithDefaults(mode),
              goToCustomize: () => onCustomize(mode),
              openConnect: onConnect,
              toggleGlossary: () => setGlossaryOpen((v) => !v),
              onQuit,
            },
          );
        },
        [mode, glossaryOpen, onStartWithDefaults, onCustomize, onConnect, onQuit],
      ),
    );

    const localPreset = defaultPresetByMode.local ?? "—";
    const connectedPreset = defaultPresetByMode.connected ?? "—";

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Welcome to Grove
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>Multi-agent collaboration workspace.</text>
          <text color={theme.secondary}>{""}</text>
        </box>

        <box flexDirection="row" marginX={2} marginTop={1}>
          <ModeCard
            title="Local"
            line1="Single host"
            line2="Fast iteration"
            preset={localPreset}
            focused={mode === "local"}
          />
          <text color={theme.secondary}>{"  "}</text>
          <ModeCard
            title="Connected"
            line1="Join a Nexus"
            line2="Team workspace"
            preset={connectedPreset}
            focused={mode === "connected"}
          />
        </box>

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [h/l] move  [Enter] start with defaults  [Tab] customize  [c] connect to existing Nexus URL  [?] glossary  [q] quit
          </text>
        </box>

        {glossaryOpen ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              Glossary
            </text>
            {GLOSSARY.map((entry) => (
              <box key={entry.term} flexDirection="row">
                <text color={theme.info}>{entry.term.padEnd(16)}</text>
                <text color={theme.secondary}>{entry.definition}</text>
              </box>
            ))}
            <text color={theme.secondary}>Press ? or Esc to close</text>
          </box>
        ) : null}
      </box>
    );
  },
);

// Inline card — kept private, no need to export.
function ModeCard(props: {
  title: string;
  line1: string;
  line2: string;
  preset: string;
  focused: boolean;
}): React.ReactNode {
  const { title, line1, line2, preset, focused } = props;
  return (
    <box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.focus : theme.border}
      paddingX={1}
    >
      <text color={focused ? theme.focus : theme.text} bold={focused}>
        {title}
      </text>
      <text color={theme.text}>{line1}</text>
      <text color={theme.text}>{line2}</text>
      <text color={theme.secondary}>{`Preset: ${preset}`}</text>
    </box>
  );
}
```

- [ ] **Step 3: Type check**

Run: `bun run typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/welcome/mode-picker.tsx \
        src/tui/views/welcome/glossary.ts
git commit -m "feat(tui): mode-picker component + glossary overlay (#190)"
```

---

## Task 9: Customize Keyboard Router

**Files:**
- Create: `src/tui/views/welcome/customize-keyboard.ts`
- Test: `src/tui/views/welcome/customize-keyboard.test.ts`

Three fields (preset, name, keymap). Tab cycles focus, field-specific keys edit within.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/customize-keyboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type CustomizeActions,
  type CustomizeState,
  type KeymapChoice,
  routeCustomizeKey,
} from "./customize-keyboard.js";

function keyEvent(name: string, seq?: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    alt: false,
    option: false,
    sequence: seq ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: CustomizeActions = {
    setField: (f) => calls.push({ name: "setField", args: [f] }),
    setPresetCursor: (n) => calls.push({ name: "setPresetCursor", args: [n] }),
    setName: (s) => calls.push({ name: "setName", args: [s] }),
    setKeymap: (c) => calls.push({ name: "setKeymap", args: [c] }),
    togglePresetDetail: () => calls.push({ name: "togglePresetDetail", args: [] }),
    goBack: () => calls.push({ name: "goBack", args: [] }),
    launch: () => calls.push({ name: "launch", args: [] }),
  };
  return { calls, actions };
}

function state(over: Partial<CustomizeState> = {}): CustomizeState {
  return {
    field: "preset",
    presetCursor: 0,
    presetCount: 3,
    name: "my-grove",
    keymap: "vim" as KeymapChoice,
    presetDetailOpen: false,
    ...over,
  };
}

describe("routeCustomizeKey (focus cycle)", () => {
  test("Tab cycles preset → name → keymap → preset", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("tab"), state({ field: "preset" }), actions);
    routeCustomizeKey(keyEvent("tab"), state({ field: "name" }), actions);
    routeCustomizeKey(keyEvent("tab"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["name", "keymap", "preset"]);
  });

  test("Esc goes back from any field", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("escape"), state({ field: "preset" }), actions);
    routeCustomizeKey(keyEvent("escape"), state({ field: "name" }), actions);
    routeCustomizeKey(keyEvent("escape"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.name)).toEqual(["goBack", "goBack", "goBack"]);
  });
});

describe("routeCustomizeKey (preset field)", () => {
  test("j / k move preset cursor with clamp", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("j"), state({ presetCursor: 0 }), actions);
    routeCustomizeKey(keyEvent("j"), state({ presetCursor: 2 }), actions); // clamp
    routeCustomizeKey(keyEvent("k"), state({ presetCursor: 0 }), actions); // clamp
    expect(calls.map((c) => c.args[0])).toEqual([1, 2, 0]);
  });

  test("? toggles detail overlay", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("?", "?"), state(), actions);
    expect(calls).toEqual([{ name: "togglePresetDetail", args: [] }]);
  });

  test("Enter launches", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state(), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });
});

describe("routeCustomizeKey (name field)", () => {
  test("printable appends to name", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("a"),
      state({ field: "name", name: "foo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "setName", args: ["fooa"] }]);
  });

  test("backspace pops one char", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("backspace"),
      state({ field: "name", name: "foo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "setName", args: ["fo"] }]);
  });

  test("Enter launches when name non-empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "name", name: "foo" }),
      actions,
    );
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });

  test("Enter is ignored when name empty", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("return"),
      state({ field: "name", name: "" }),
      actions,
    );
    expect(calls).toEqual([]);
  });
});

describe("routeCustomizeKey (keymap field)", () => {
  test("h/l cycles choice", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(
      keyEvent("l"),
      state({ field: "keymap", keymap: "vim" }),
      actions,
    );
    routeCustomizeKey(
      keyEvent("l"),
      state({ field: "keymap", keymap: "emacs" }),
      actions,
    );
    routeCustomizeKey(
      keyEvent("h"),
      state({ field: "keymap", keymap: "none" }),
      actions,
    );
    expect(calls.map((c) => c.args[0])).toEqual(["emacs", "none", "emacs"]);
  });

  test("1/2/3 set choice directly", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("1"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("2"), state({ field: "keymap" }), actions);
    routeCustomizeKey(keyEvent("3"), state({ field: "keymap" }), actions);
    expect(calls.map((c) => c.args[0])).toEqual(["vim", "emacs", "none"]);
  });

  test("Enter launches", () => {
    const { calls, actions } = tracker();
    routeCustomizeKey(keyEvent("return"), state({ field: "keymap" }), actions);
    expect(calls).toEqual([{ name: "launch", args: [] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/customize-keyboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/tui/views/welcome/customize-keyboard.ts`:

```ts
/** Pure keyboard routing for the first-run customize screen. */

import type { KeyEvent } from "@opentui/core";

export type KeymapChoice = "vim" | "emacs" | "none";
export type CustomizeField = "preset" | "name" | "keymap";

export interface CustomizeState {
  readonly field: CustomizeField;
  readonly presetCursor: number;
  readonly presetCount: number;
  readonly name: string;
  readonly keymap: KeymapChoice;
  readonly presetDetailOpen: boolean;
}

export interface CustomizeActions {
  readonly setField: (f: CustomizeField) => void;
  readonly setPresetCursor: (n: number) => void;
  readonly setName: (s: string) => void;
  readonly setKeymap: (c: KeymapChoice) => void;
  readonly togglePresetDetail: () => void;
  readonly goBack: () => void;
  readonly launch: () => void;
}

const FIELD_ORDER: readonly CustomizeField[] = ["preset", "name", "keymap"];
const KEYMAP_ORDER: readonly KeymapChoice[] = ["vim", "emacs", "none"];

export function routeCustomizeKey(
  key: KeyEvent,
  state: CustomizeState,
  actions: CustomizeActions,
): boolean {
  const name = key.name;

  if (name === "escape") {
    actions.goBack();
    return true;
  }
  if (name === "tab") {
    const i = FIELD_ORDER.indexOf(state.field);
    const next = FIELD_ORDER[(i + 1) % FIELD_ORDER.length];
    if (next) actions.setField(next);
    return true;
  }

  if (state.field === "preset") {
    if (name === "j" || name === "down") {
      actions.setPresetCursor(Math.min(state.presetCursor + 1, Math.max(0, state.presetCount - 1)));
      return true;
    }
    if (name === "k" || name === "up") {
      actions.setPresetCursor(Math.max(state.presetCursor - 1, 0));
      return true;
    }
    if (key.sequence === "?") {
      actions.togglePresetDetail();
      return true;
    }
    if (name === "return") {
      if (state.name.length > 0) actions.launch();
      return true;
    }
    return false;
  }

  if (state.field === "name") {
    if (name === "backspace") {
      actions.setName(state.name.slice(0, -1));
      return true;
    }
    if (name === "space") {
      actions.setName(`${state.name} `);
      return true;
    }
    if (name === "return") {
      if (state.name.length > 0) actions.launch();
      return true;
    }
    if (typeof name === "string" && name.length === 1 && !key.ctrl) {
      actions.setName(state.name + name);
      return true;
    }
    return false;
  }

  // keymap field
  if (name === "l" || name === "right") {
    const i = KEYMAP_ORDER.indexOf(state.keymap);
    const next = KEYMAP_ORDER[(i + 1) % KEYMAP_ORDER.length];
    if (next) actions.setKeymap(next);
    return true;
  }
  if (name === "h" || name === "left") {
    const i = KEYMAP_ORDER.indexOf(state.keymap);
    const next = KEYMAP_ORDER[(i - 1 + KEYMAP_ORDER.length) % KEYMAP_ORDER.length];
    if (next) actions.setKeymap(next);
    return true;
  }
  if (name === "1") {
    actions.setKeymap("vim");
    return true;
  }
  if (name === "2") {
    actions.setKeymap("emacs");
    return true;
  }
  if (name === "3") {
    actions.setKeymap("none");
    return true;
  }
  if (name === "return") {
    if (state.name.length > 0) actions.launch();
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/customize-keyboard.test.ts`
Expected: PASS — 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/welcome/customize-keyboard.ts \
        src/tui/views/welcome/customize-keyboard.test.ts
git commit -m "feat(tui): customize keyboard router (#190)"
```

---

## Task 10: Customize Component

**Files:**
- Create: `src/tui/views/welcome/customize.tsx`

- [ ] **Step 1: Implement**

Create `src/tui/views/welcome/customize.tsx`:

```tsx
/**
 * First-run customize screen — preset list, name input, keymap radio.
 *
 * Uses `routeCustomizeKey` for key routing and `applyKeymapPresetToFile`
 * on launch to persist the chosen keymap preset to the user's global
 * config.json (reusing the issue #195 config loader).
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import { homedir } from "node:os";
import { join } from "node:path";
import React, { useCallback, useState } from "react";
import { theme } from "../../theme.js";
import {
  type CustomizeField,
  type KeymapChoice,
  routeCustomizeKey,
} from "./customize-keyboard.js";
import { applyKeymapPresetToFile } from "./keymap-presets.js";
import type { WelcomeMode } from "./router.js";

export interface CustomizePresetEntry {
  readonly name: string;
  readonly description: string;
  readonly details?: string | undefined;
}

export interface CustomizeProps {
  readonly mode: WelcomeMode;
  readonly presets: readonly CustomizePresetEntry[];
  readonly defaultPresetName: string;
  readonly defaultName: string;
  readonly onLaunch: (args: { preset: string; name: string; keymap: KeymapChoice }) => void;
  readonly onBack: () => void;
}

function globalConfigPath(): string {
  return join(homedir(), ".config", "grove", "config.json");
}

export const Customize: React.NamedExoticComponent<CustomizeProps> = React.memo(
  function Customize({
    mode,
    presets,
    defaultPresetName,
    defaultName,
    onLaunch,
    onBack,
  }: CustomizeProps): React.ReactNode {
    const [field, setField] = useState<CustomizeField>("preset");
    const initialCursor = Math.max(0, presets.findIndex((p) => p.name === defaultPresetName));
    const [presetCursor, setPresetCursor] = useState(initialCursor);
    const [name, setName] = useState(defaultName);
    const [keymap, setKeymap] = useState<KeymapChoice>("vim");
    const [presetDetailOpen, setPresetDetailOpen] = useState(false);
    void useRenderer();

    const launch = useCallback(() => {
      const preset = presets[presetCursor]?.name ?? defaultPresetName;
      void (async () => {
        if (keymap !== "none") {
          try {
            await applyKeymapPresetToFile(keymap, globalConfigPath());
          } catch (err) {
            process.stderr.write(
              `[grove] failed to apply keymap preset "${keymap}": ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        onLaunch({ preset, name, keymap });
      })();
    }, [presets, presetCursor, defaultPresetName, keymap, name, onLaunch]);

    useKeyboard(
      useCallback(
        (key) => {
          routeCustomizeKey(
            key,
            {
              field,
              presetCursor,
              presetCount: presets.length,
              name,
              keymap,
              presetDetailOpen,
            },
            {
              setField,
              setPresetCursor,
              setName,
              setKeymap,
              togglePresetDetail: () => setPresetDetailOpen((v) => !v),
              goBack: onBack,
              launch,
            },
          );
        },
        [field, presetCursor, presets.length, name, keymap, presetDetailOpen, onBack, launch],
      ),
    );

    const focusedPreset = presets[presetCursor];

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Customize
          </text>
          <text color={theme.secondary}>{`Mode: ${mode === "local" ? "Local" : "Connected"}`}</text>
          <text color={theme.secondary}>{""}</text>
        </box>

        {/* Preset field */}
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="round"
          borderColor={field === "preset" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Preset
          </text>
          {presets.map((p, i) => {
            const selected = i === presetCursor;
            const prefix = selected ? "> " : "  ";
            return (
              <box
                key={p.name}
                flexDirection="row"
                backgroundColor={selected && field === "preset" ? theme.selectedBg : undefined}
              >
                <text color={selected ? theme.focus : theme.text} bold={selected}>
                  {`${prefix}${p.name.padEnd(20)}`}
                </text>
                <text color={theme.secondary}>{p.description}</text>
              </box>
            );
          })}
        </box>

        {/* Name field */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={field === "name" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Name
          </text>
          <box flexDirection="row">
            <text color={theme.focus} bold>
              {name}
            </text>
            {field === "name" ? <text color={theme.focus}>_</text> : null}
          </box>
        </box>

        {/* Keymap field */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={field === "keymap" ? theme.focus : theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Keymap
          </text>
          <box flexDirection="row">
            {(["vim", "emacs", "none"] as const).map((c) => (
              <text
                key={c}
                color={c === keymap ? theme.focus : theme.text}
                bold={c === keymap}
              >
                {`${c === keymap ? "(•) " : "( ) "}${c}   `}
              </text>
            ))}
          </box>
        </box>

        {/* Preset detail overlay */}
        {presetDetailOpen && focusedPreset ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              {focusedPreset.name}
            </text>
            <text color={theme.text}>{focusedPreset.description}</text>
            {focusedPreset.details
              ? focusedPreset.details.split("\n").map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                  <text key={i} color={theme.secondary}>
                    {line}
                  </text>
                ))
              : null}
            <text color={theme.secondary}>Press ? to close</text>
          </box>
        ) : null}

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [j/k] preset  [Tab] field  [Enter] launch  [?] details  [Esc] back
          </text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/welcome/customize.tsx
git commit -m "feat(tui): customize component with preset/name/keymap fields (#190)"
```

---

## Task 11: First-run Container

**Files:**
- Create: `src/tui/views/welcome/first-run.tsx`

Routes between mode-picker and customize based on internal step state. Computes mode-default presets.

- [ ] **Step 1: Implement**

Create `src/tui/views/welcome/first-run.tsx`:

```tsx
/**
 * First-run container — routes between `ModePicker` and `Customize` based
 * on the user's Tab / Enter / back choices.
 */

import React, { useMemo, useState } from "react";
import type { TuiPresetEntry } from "../../tui-app.js";
import { basename } from "node:path";
import { Customize, type CustomizePresetEntry } from "./customize.js";
import type { KeymapChoice } from "./customize-keyboard.js";
import { ModePicker } from "./mode-picker.js";
import { resolveDefaultPreset, type WelcomeMode } from "./router.js";

export interface FirstRunProps {
  readonly presets: readonly TuiPresetEntry[];
  readonly cwd?: string;
  readonly onSelect: (args: {
    preset: string;
    name: string;
    mode: WelcomeMode;
    keymap: KeymapChoice;
  }) => void;
  readonly onConnect: () => void;
  readonly onQuit: () => void;
}

type Step =
  | { readonly kind: "mode" }
  | { readonly kind: "customize"; readonly mode: WelcomeMode };

export const FirstRun: React.NamedExoticComponent<FirstRunProps> = React.memo(
  function FirstRun({ presets, cwd, onSelect, onConnect, onQuit }: FirstRunProps): React.ReactNode {
    const [step, setStep] = useState<Step>({ kind: "mode" });

    const defaultPresetByMode = useMemo(
      () => ({
        local: resolveDefaultPreset("local", presets),
        connected: resolveDefaultPreset("connected", presets),
      }),
      [presets],
    );

    const defaultName = useMemo(() => {
      const cwdStr = cwd ?? process.cwd();
      return basename(cwdStr) || "my-grove";
    }, [cwd]);

    if (step.kind === "mode") {
      return (
        <ModePicker
          defaultPresetByMode={defaultPresetByMode}
          onStartWithDefaults={(mode) => {
            const preset = defaultPresetByMode[mode];
            if (!preset) return;
            onSelect({ preset, name: defaultName, mode, keymap: "none" });
          }}
          onCustomize={(mode) => setStep({ kind: "customize", mode })}
          onConnect={onConnect}
          onQuit={onQuit}
        />
      );
    }

    const customizePresets: readonly CustomizePresetEntry[] = presets.map((p) => ({
      name: p.name,
      description: p.description,
      details: p.details,
    }));

    const defaultPreset = defaultPresetByMode[step.mode] ?? presets[0]?.name ?? "";

    return (
      <Customize
        mode={step.mode}
        presets={customizePresets}
        defaultPresetName={defaultPreset}
        defaultName={defaultName}
        onLaunch={({ preset, name, keymap }) => onSelect({ preset, name, mode: step.mode, keymap })}
        onBack={() => setStep({ kind: "mode" })}
      />
    );
  },
);
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/welcome/first-run.tsx
git commit -m "feat(tui): first-run container routing mode → customize (#190)"
```

---

## Task 12: New-session Keyboard + Component

**Files:**
- Create: `src/tui/views/welcome/new-session-keyboard.ts`
- Test: `src/tui/views/welcome/new-session-keyboard.test.ts`
- Create: `src/tui/views/welcome/new-session.tsx`

Preset picker reached via `n` on fast-path.

- [ ] **Step 1: Write the failing tests**

Create `src/tui/views/welcome/new-session-keyboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  type NewSessionActions,
  type NewSessionState,
  routeNewSessionKey,
} from "./new-session-keyboard.js";

function keyEvent(name: string, seq?: string): KeyEvent {
  return {
    name,
    ctrl: false,
    shift: false,
    meta: false,
    alt: false,
    option: false,
    sequence: seq ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

function tracker() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const actions: NewSessionActions = {
    setCursor: (n) => calls.push({ name: "setCursor", args: [n] }),
    toggleDetail: () => calls.push({ name: "toggleDetail", args: [] }),
    onPick: (i) => calls.push({ name: "onPick", args: [i] }),
    onBack: () => calls.push({ name: "onBack", args: [] }),
  };
  return { calls, actions };
}

const state = (over: Partial<NewSessionState> = {}): NewSessionState => ({
  cursor: 0,
  presetCount: 3,
  detailOpen: false,
  ...over,
});

describe("routeNewSessionKey", () => {
  test("j/k move cursor with clamp", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("j"), state({ cursor: 0 }), actions);
    routeNewSessionKey(keyEvent("j"), state({ cursor: 2 }), actions);
    routeNewSessionKey(keyEvent("k"), state({ cursor: 0 }), actions);
    expect(calls.map((c) => c.args[0])).toEqual([1, 2, 0]);
  });

  test("Enter picks focused preset index", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("return"), state({ cursor: 2 }), actions);
    expect(calls).toEqual([{ name: "onPick", args: [2] }]);
  });

  test("? toggles detail", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("?", "?"), state(), actions);
    expect(calls).toEqual([{ name: "toggleDetail", args: [] }]);
  });

  test("Esc goes back", () => {
    const { calls, actions } = tracker();
    routeNewSessionKey(keyEvent("escape"), state(), actions);
    expect(calls).toEqual([{ name: "onBack", args: [] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/views/welcome/new-session-keyboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement keyboard router**

Create `src/tui/views/welcome/new-session-keyboard.ts`:

```ts
/** Pure keyboard routing for the new-session preset picker. */

import type { KeyEvent } from "@opentui/core";

export interface NewSessionState {
  readonly cursor: number;
  readonly presetCount: number;
  readonly detailOpen: boolean;
}

export interface NewSessionActions {
  readonly setCursor: (n: number) => void;
  readonly toggleDetail: () => void;
  readonly onPick: (index: number) => void;
  readonly onBack: () => void;
}

export function routeNewSessionKey(
  key: KeyEvent,
  state: NewSessionState,
  actions: NewSessionActions,
): boolean {
  const name = key.name;
  if (name === "escape") {
    if (state.detailOpen) {
      actions.toggleDetail();
      return true;
    }
    actions.onBack();
    return true;
  }
  if (name === "j" || name === "down") {
    actions.setCursor(Math.min(state.cursor + 1, Math.max(0, state.presetCount - 1)));
    return true;
  }
  if (name === "k" || name === "up") {
    actions.setCursor(Math.max(state.cursor - 1, 0));
    return true;
  }
  if (name === "return") {
    actions.onPick(state.cursor);
    return true;
  }
  if (key.sequence === "?") {
    actions.toggleDetail();
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test**

Run: `bun test src/tui/views/welcome/new-session-keyboard.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Implement component**

Create `src/tui/views/welcome/new-session.tsx`:

```tsx
/**
 * New-session preset picker — invoked via `n` from the fast-path. Grove
 * backend is already resolved; we only ask for the preset. The goal prompt
 * is handled by the subsequent ScreenManager goal-input screen.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
import type { TuiPresetEntry } from "../../tui-app.js";
import { theme } from "../../theme.js";
import { routeNewSessionKey } from "./new-session-keyboard.js";

export interface NewSessionProps {
  readonly groveName: string;
  readonly presets: readonly TuiPresetEntry[];
  readonly onPick: (presetName: string) => void;
  readonly onBack: () => void;
}

export const NewSession: React.NamedExoticComponent<NewSessionProps> = React.memo(
  function NewSession({ groveName, presets, onPick, onBack }: NewSessionProps): React.ReactNode {
    const [cursor, setCursor] = useState(0);
    const [detailOpen, setDetailOpen] = useState(false);
    void useRenderer();

    useKeyboard(
      useCallback(
        (key) => {
          routeNewSessionKey(
            key,
            { cursor, presetCount: presets.length, detailOpen },
            {
              setCursor,
              toggleDetail: () => setDetailOpen((v) => !v),
              onPick: (i) => {
                const name = presets[i]?.name;
                if (name) onPick(name);
              },
              onBack,
            },
          );
        },
        [cursor, presets, detailOpen, onPick, onBack],
      ),
    );

    const focused = presets[cursor];

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            {`New session in ${groveName}`}
          </text>
          <text color={theme.secondary}>{""}</text>
          <text color={theme.text}>Pick a preset for this session:</text>
        </box>

        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          {presets.map((p, i) => {
            const selected = i === cursor;
            const prefix = selected ? "> " : "  ";
            return (
              <box
                key={p.name}
                flexDirection="row"
                backgroundColor={selected ? theme.selectedBg : undefined}
              >
                <text color={selected ? theme.focus : theme.text} bold={selected}>
                  {`${prefix}${p.name.padEnd(20)}`}
                </text>
                <text color={theme.secondary}>{p.description}</text>
              </box>
            );
          })}
        </box>

        {detailOpen && focused ? (
          <box
            flexDirection="column"
            marginX={2}
            marginTop={1}
            borderStyle="round"
            borderColor={theme.info}
            paddingX={1}
          >
            <text color={theme.info} bold>
              {focused.name}
            </text>
            <text color={theme.text}>{focused.description}</text>
            {focused.details
              ? focused.details.split("\n").map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: detail lines have no stable identity
                  <text key={i} color={theme.secondary}>
                    {line}
                  </text>
                ))
              : null}
            <text color={theme.secondary}>Press ? or Esc to close</text>
          </box>
        ) : null}

        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            [j/k] navigate  [Enter] pick  [?] details  [Esc] back
          </text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 6: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/views/welcome/new-session-keyboard.ts \
        src/tui/views/welcome/new-session-keyboard.test.ts \
        src/tui/views/welcome/new-session.tsx
git commit -m "feat(tui): new-session preset picker (#190)"
```

---

## Task 13: Connect Component

**Files:**
- Create: `src/tui/views/welcome/connect.tsx`

Port of the existing connect screen from `welcome.tsx` with inline error rendering and `returnTo` semantics for Esc.

- [ ] **Step 1: Implement**

Create `src/tui/views/welcome/connect.tsx`:

```tsx
/**
 * Connect-to-Nexus URL input, shared by first-run and fast-path.
 *
 * Esc routes to the caller-provided `onBack`. Enter calls `onConnect`; a
 * caller-managed `error` string renders inline so the user can retry
 * without losing the typed URL.
 */

import { useKeyboard, useRenderer } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { theme } from "../../theme.js";

export interface ConnectProps {
  readonly defaultUrl?: string;
  readonly error?: string | undefined;
  readonly onConnect: (url: string) => void;
  readonly onBack: () => void;
}

export const Connect: React.NamedExoticComponent<ConnectProps> = React.memo(
  function Connect({
    defaultUrl,
    error,
    onConnect,
    onBack,
  }: ConnectProps): React.ReactNode {
    const [url, setUrl] = useState(defaultUrl ?? "http://localhost:2026");
    void useRenderer();

    useKeyboard(
      useCallback(
        (key) => {
          const name = key.name;
          if (name === "escape") {
            onBack();
            return;
          }
          if (name === "return") {
            const trimmed = url.trim();
            if (trimmed.length > 0) onConnect(trimmed);
            return;
          }
          if (name === "backspace") {
            setUrl((u) => u.slice(0, -1));
            return;
          }
          if (name === "space") {
            setUrl((u) => `${u} `);
            return;
          }
          if (typeof name === "string" && name.length === 1 && !key.ctrl) {
            setUrl((u) => u + name);
            return;
          }
        },
        [url, onConnect, onBack],
      ),
    );

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.focus} bold>
            Connect to remote Nexus
          </text>
          <text color={theme.secondary}>{""}</text>
          <box flexDirection="row">
            <text color={theme.text}>Nexus URL: </text>
            <text color={theme.focus} bold>
              {url}
            </text>
            <text color={theme.focus}>_</text>
          </box>
          {error ? (
            <box flexDirection="column" marginTop={1}>
              <text color={theme.error}>{`Error: ${error}`}</text>
            </box>
          ) : null}
          <text color={theme.secondary}>{""}</text>
          <text color={theme.secondary}>[Enter] connect  [Esc] back  [Backspace] delete</text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/welcome/connect.tsx
git commit -m "feat(tui): connect-to-Nexus URL input with inline error (#190)"
```

---

## Task 14: Top-level Welcome Router

**Files:**
- Create: `src/tui/views/welcome/index.tsx`

Composes all sub-views via the `resolveInitialRoute` decision; owns the top-level route state. Exports `WelcomeScreen` as a drop-in replacement matching the old export.

- [ ] **Step 1: Implement**

Create `src/tui/views/welcome/index.tsx`:

```tsx
/**
 * Welcome screen entry point.
 *
 * Picks between fast-path (returning operator) and first-run (new user)
 * via `resolveInitialRoute`, and routes sub-views (connect, new-session)
 * on demand. Exports `WelcomeScreen` as a drop-in replacement for the old
 * `views/welcome.tsx` export.
 */

import React, { useState } from "react";
import type { SessionRecord } from "../../provider.js";
import type { TuiPresetEntry } from "../../tui-app.js";
import { Connect } from "./connect.js";
import { FastPath } from "./fast-path.js";
import { FirstRun } from "./first-run.js";
import { NewSession } from "./new-session.js";
import {
  resolveInitialRoute,
  type WelcomeMode,
  type WelcomeRoute,
} from "./router.js";
import type { KeymapChoice } from "./customize-keyboard.js";

/** Re-export for TuiApp's TuiPresetEntry convenience. */
export type { PresetLite as WelcomePresetLite } from "./router.js";

export interface WelcomeProps {
  readonly presets: readonly TuiPresetEntry[];
  readonly groveExists: boolean;
  readonly groveInfo?: { name: string; preset: string } | undefined;
  readonly sessions?: readonly SessionRecord[] | undefined;
  readonly connectError?: string | undefined;
  readonly onSelect: (args: {
    preset: string;
    name: string;
    mode: WelcomeMode;
    keymap: KeymapChoice;
  }) => void;
  readonly onResume: (sessionId: string) => void;
  readonly onNewSession: (presetName: string) => void;
  readonly onConnect: (nexusUrl: string) => void;
  readonly onQuit: () => void;
}

export const WelcomeScreen: React.NamedExoticComponent<WelcomeProps> = React.memo(
  function WelcomeScreen({
    presets,
    groveExists,
    groveInfo,
    sessions,
    connectError,
    onSelect,
    onResume,
    onNewSession,
    onConnect,
    onQuit,
  }: WelcomeProps): React.ReactNode {
    const [route, setRoute] = useState<WelcomeRoute>(() =>
      resolveInitialRoute({ groveExists, sessions: sessions ?? [] }),
    );

    const groveName = groveInfo?.name ?? "grove";

    if (route.kind === "connect") {
      return (
        <Connect
          error={connectError}
          onConnect={(url) => onConnect(url)}
          onBack={() =>
            setRoute(
              route.returnTo === "fast-path"
                ? { kind: "fast-path" }
                : { kind: "first-run", step: "mode" },
            )
          }
        />
      );
    }

    if (route.kind === "new-session") {
      return (
        <NewSession
          groveName={groveName}
          presets={presets}
          onPick={(name) => onNewSession(name)}
          onBack={() => setRoute({ kind: "fast-path" })}
        />
      );
    }

    if (route.kind === "first-run") {
      return (
        <FirstRun
          presets={presets}
          onSelect={(args) => onSelect(args)}
          onConnect={() => setRoute({ kind: "connect", returnTo: "first-run" })}
          onQuit={onQuit}
        />
      );
    }

    // fast-path
    return (
      <FastPath
        groveName={groveName}
        sessions={sessions ?? []}
        onResume={onResume}
        onNewSession={() => setRoute({ kind: "new-session" })}
        onConnect={() => setRoute({ kind: "connect", returnTo: "fast-path" })}
        onQuit={onQuit}
      />
    );
  },
);
```

- [ ] **Step 2: Type check**

Run: `bun run typecheck`
Expected: PASS — the new `views/welcome/index.tsx` and legacy `views/welcome.tsx` coexist temporarily.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/welcome/index.tsx
git commit -m "feat(tui): welcome router composing fast-path + first-run (#190)"
```

---

## Task 15: Wire TuiApp Callbacks + Swap Import

**Files:**
- Modify: `src/tui/tui-app.tsx`

Replace import from `./views/welcome.js` with `./views/welcome/index.js`, broaden `onResume` to accept a session id, add `onNewSession` handler that transitions to boardroom with `initialState` pointing at goal-input.

- [ ] **Step 1: Update imports and types**

Edit `src/tui/tui-app.tsx`:

Replace the import line:
```ts
import { WelcomeScreen } from "./views/welcome.js";
```
with:
```ts
import { WelcomeScreen } from "./views/welcome/index.js";
```

Replace `TuiAppProps` to include `onNewSession` and broaden `onStart` callers downstream. Locate the interface and update:

```ts
export interface TuiAppProps {
  readonly groveExists: boolean;
  readonly groveInfo?: { name: string; preset: string } | undefined;
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  readonly sessions?: readonly import("./provider.js").SessionRecord[] | undefined;
  readonly onInit?:
    | ((
        presetName: string,
        groveName: string,
        onProgress?: (step: string) => void,
      ) => Promise<AppProps>)
    | undefined;
  /** Called when resuming an existing grove. `sessionId` is provided when the user picked a specific session from the fast-path list. */
  readonly onStart?:
    | ((
        onProgress?: (step: string) => void,
        sessionId?: string,
      ) => Promise<AppProps>)
    | undefined;
  readonly onConnect?: ((nexusUrl: string) => Promise<AppProps>) | undefined;
  /** Start a new session in an existing grove. Resolves with `AppProps` reused with `initialState` routed to goal-input. */
  readonly onNewSession?:
    | ((presetName: string) => Promise<AppProps>)
    | undefined;
  readonly autoConnectNexus?: string | undefined;
}
```

- [ ] **Step 2: Thread sessionId through handleResume**

Change the `handleResume` signature and call:

```tsx
  const handleResume = useCallback(
    (sessionId?: string) => {
      if (!onStart) return;

      setMode("starting");
      setInitError(undefined);
      setStartingDone(false);
      setStartingSteps(["Starting services..."]);
      isResumedRef.current = true;

      void (async () => {
        try {
          const result = await onStart(
            (step) => setStartingSteps((prev) => [...prev, step]),
            sessionId,
          );

          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 300));

          setAppProps(result);
          setMode("boardroom");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      })();
    },
    [onStart],
  );
```

- [ ] **Step 3: Add handleNewSession**

Insert after `handleResume`:

```tsx
  /** Handle `n` on fast-path — new session in existing grove. */
  const handleNewSession = useCallback(
    (presetName: string) => {
      if (!onNewSession) return;

      setMode("starting");
      setInitError(undefined);
      setStartingDone(false);
      setStartingSteps(["Starting session..."]);
      isResumedRef.current = false;

      void (async () => {
        try {
          const result = await onNewSession(presetName);
          setStartingDone(true);
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          setAppProps(result);
          setMode("boardroom");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setInitError(message);
        }
      })();
    },
    [onNewSession],
  );
```

Extract `onNewSession` from props at the top of `TuiApp`:

```tsx
  const { groveExists, groveInfo, presets, onInit, onStart, onConnect, onNewSession, autoConnectNexus } = props;
```

- [ ] **Step 4: Swap handleSelect to accept WelcomeScreen's richer args**

Change `handleSelect` signature:

```tsx
  const handleSelect = useCallback(
    (args: { preset: string; name: string; mode: import("./views/welcome/router.js").WelcomeMode; keymap: import("./views/welcome/customize-keyboard.js").KeymapChoice }) => {
      if (!onInit) return;
      const { preset: presetName, name: groveName } = args;
      // mode + keymap are honored upstream by main.ts via onInit; if connected
      // mode needs a URL and none resolves, main.ts surfaces it.
      setMode("initializing");
      setInitPreset(presetName);
      setInitError(undefined);
      setInitSteps(INIT_STEPS.map((label) => ({ label, done: false })));

      void (async () => {
        try {
          const markStep = (index: number) => {
            setInitSteps((prev) => prev.map((s, i) => (i <= index ? { ...s, done: true } : s)));
          };
          markStep(0);

          const result = await onInit(presetName, groveName, (step) => {
            setInitSteps((prev) => {
              const updated = prev.map((s) => ({ ...s, done: true }));
              if (updated.some((s) => s.label === step)) return updated;
              return [...updated, { label: step, done: false }];
            });
          });

          setInitSteps((prev) => prev.map((s) => ({ ...s, done: true })));
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          setAppProps(result);
          setMode("boardroom");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[grove init failed] ${message}\n`);
          setInitError(message);
        }
      })();
    },
    [onInit],
  );
```

- [ ] **Step 5: Update the WelcomeScreen render call**

Locate the render block that uses `WelcomeScreen` and update it:

```tsx
  if (presets && presets.length > 0) {
    return React.createElement(WelcomeScreen, {
      presets,
      groveExists,
      groveInfo,
      sessions: props.sessions,
      connectError: initError,
      onSelect: handleSelect,
      onResume: handleResume,
      onNewSession: handleNewSession,
      onConnect: handleConnect,
      onQuit: handleQuit,
    });
  }
```

- [ ] **Step 6: Type check**

Run: `bun run typecheck`
Expected: PASS — any remaining errors are in `main.ts` which we update next.

- [ ] **Step 7: Commit**

```bash
git add src/tui/tui-app.tsx
git commit -m "feat(tui): TuiApp wiring for onNewSession + onResume(sessionId) (#190)"
```

---

## Task 16: Wire main.ts Callbacks

**Files:**
- Modify: `src/tui/main.ts`

Provide `onNewSession` to `TuiApp` and thread the session id into the existing resume path.

- [ ] **Step 1: Locate TuiApp instantiation in main.ts**

Run: `grep -n "TuiApp\|onStart\|onInit\|onConnect" src/tui/main.ts | head -40`

Expected: lines listing where `TuiApp` is rendered with `onInit`, `onStart`, `onConnect`. Note these line numbers; the next step edits them.

- [ ] **Step 2: Extend AppProps to carry session routing hints**

`main.ts` already declares `onInit`, `onStart`, `onConnect` at lines 631, 699, 727. `onStart` currently has signature `(onProgress?) => Promise<AppProps>`. We extend it to accept `sessionId` and add a new `onNewSession` that delegates to `onInit` (which already handles the `groveExists=true` "new session" branch at line 652).

The hint flows back to `TuiApp` via `AppProps` augmentation.

In `src/tui/app.ts`, locate `export interface AppProps` and add:

```ts
  /** When set, ScreenManager should scope the resumed session feed to this id. */
  readonly resumeSessionId?: string | undefined;
  /** When set, ScreenManager should open goal-input with this preset pre-selected (new session in existing grove). */
  readonly newSessionPreset?: string | undefined;
```

- [ ] **Step 3: Update onStart signature and add onNewSession in main.ts**

In `src/tui/main.ts`, change the `onStart` declaration at ~line 699 from:

```ts
const onStart = async (
  onProgress?: (step: string) => void,
): Promise<import("./app.js").AppProps> => {
```

to:

```ts
const onStart = async (
  onProgress?: (step: string) => void,
  sessionId?: string,
): Promise<import("./app.js").AppProps> => {
```

At the end of the existing `onStart` body, change:

```ts
  return result.appProps;
```

to:

```ts
  return { ...result.appProps, resumeSessionId: sessionId };
```

Immediately after `onStart`, add `onNewSession`:

```ts
// onNewSession: handles `n` on fast-path — reuse existing grove, start a new
// session with the user-picked preset. Delegates to `onInit` which already
// handles the `groveExists=true` branch (just startServices + buildAppProps).
const onNewSession = async (presetName: string): Promise<import("./app.js").AppProps> => {
  if (!groveInfo?.name) {
    throw new Error("onNewSession called without existing grove");
  }
  const baseProps = await onInit(presetName, groveInfo.name);
  return { ...baseProps, newSessionPreset: presetName };
};
```

- [ ] **Step 4: Pass onNewSession to TuiApp**

Change the `React.createElement(TuiApp, { ... })` block (around line 740) to include:

```tsx
React.createElement(TuiApp, {
  groveExists,
  groveInfo,
  presets,
  sessions,
  onInit,
  onStart,
  onConnect,
  onNewSession,
  autoConnectNexus: opts.nexus,
}),
```

- [ ] **Step 5: Forward hints into ScreenManager from TuiApp**

In `src/tui/tui-app.tsx`, update the `mode === "boardroom"` render block to pass the hints through:

```tsx
  if (mode === "boardroom" && appProps && spawnManager) {
    const initialState = appProps.newSessionPreset
      ? { screen: "goal-input" as const, selectedPreset: appProps.newSessionPreset }
      : undefined;
    return (
      <SpawnManagerContext value={spawnManager}>
        {React.createElement(ScreenManager, {
          appProps,
          presets,
          sessions: props.sessions,
          startOnRunning: isResumedRef.current && !appProps.newSessionPreset,
          initialState,
          resumeSessionId: appProps.resumeSessionId,
        })}
      </SpawnManagerContext>
    );
  }
```

- [ ] **Step 6: Extend ScreenManagerProps and consume resumeSessionId**

In `src/tui/screens/screen-manager.tsx`, locate `ScreenManagerProps` (around line 75) and add:

```ts
  /** Scope the resumed session's feed/history to this session id. */
  readonly resumeSessionId?: string | undefined;
```

Also destructure it from the component signature alongside `initialState` and `startOnRunning`:

```tsx
  function ScreenManager({
    appProps,
    presets,
    sessions,
    startOnRunning,
    initialState,
    resumeSessionId,
  }: ScreenManagerProps): React.ReactNode {
```

Wire it into the existing `useState` initializer where `resumeScopeIdRef` is populated. Find the block (around line 117) that currently reads:

```ts
      if (startOnRunning && sessions && sessions.length > 0) {
        const active = sessions.find((s) => s.status === "active");
        if (active) {
          resumeSessionStartedAt = active.createdAt;
```

Replace with:

```ts
      if (startOnRunning && sessions && sessions.length > 0) {
        const match = resumeSessionId
          ? sessions.find((s) => s.id === resumeSessionId)
          : sessions.find((s) => s.status === "active");
        if (match) {
          resumeSessionStartedAt = match.createdAt;
          resumeSessionId = match.id; // ← NOTE: `resumeSessionId` here is the local pre-existing var in the initializer; ensure you pick the outer parameter, not this one.
```

Since the existing initializer already has a local `resumeSessionId` binding, rename the incoming prop destructure as `resumeSessionIdFromProps` to avoid shadow:

```tsx
  function ScreenManager({
    appProps,
    presets,
    sessions,
    startOnRunning,
    initialState,
    resumeSessionId: resumeSessionIdFromProps,
  }: ScreenManagerProps): React.ReactNode {
```

Then reference `resumeSessionIdFromProps` in the initializer branch:

```ts
      if (startOnRunning && sessions && sessions.length > 0) {
        const match = resumeSessionIdFromProps
          ? sessions.find((s) => s.id === resumeSessionIdFromProps)
          : sessions.find((s) => s.status === "active");
        if (match) {
          resumeSessionStartedAt = match.createdAt;
          resumeSessionId = match.id;
          // ... keep the rest of the existing block verbatim
        }
      }
```

- [ ] **Step 7: Confirm onInit args compatibility**

`WelcomeScreen.onSelect` now passes `{ preset, name, mode, keymap }`. `TuiApp.handleSelect` only forwards `preset` and `name` to `onInit` (see Task 15 step 4). That matches `onInit`'s signature in `main.ts` at line 631, which remains unchanged.

`mode` and `keymap` are already consumed client-side: `mode` is advisory (backend is still resolved by `resolveBackend` via flags/env/grove.json/docker), and `keymap` is applied by `Customize` *before* invoking `onLaunch`. No changes to `onInit` needed.

- [ ] **Step 8: Type check**

Run: `bun run typecheck`
Expected: PASS — all callers updated.

- [ ] **Step 9: Run full test suite**

Run: `bun test`
Expected: all existing + new tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/tui/main.ts src/tui/app.ts src/tui/tui-app.tsx src/tui/screens/screen-manager.tsx
git commit -m "feat(tui): thread sessionId and newSession preset through boardroom (#190)"
```

---

## Task 17: Delete Old welcome.tsx + Final Verification

**Files:**
- Delete: `src/tui/views/welcome.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn "from \"./views/welcome\\.js\"\\|from \"../views/welcome\\.js\"" src/ 2>/dev/null || true`
Expected: empty. If any match, update that file to import from `./views/welcome/index.js` (or the relative equivalent) first.

- [ ] **Step 2: Delete the file**

Run: `rm src/tui/views/welcome.tsx`

- [ ] **Step 3: Type check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Full test suite**

Run: `bun test`
Expected: PASS — all green.

- [ ] **Step 5: Lint / format**

Run: `bun run lint` (or the project's lint command — check `package.json`)
Expected: clean. Fix any biome warnings before proceeding.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(tui): remove legacy welcome.tsx, superseded by views/welcome/ (#190)"
```

---

## Task 18: Manual Smoke Test

No code — this task verifies the UI behaves as designed.

- [ ] **Step 1: First-run happy path (Local)**

```bash
mkdir -p /tmp/grove-fresh && cd /tmp/grove-fresh
bun run grove   # or the CLI entry point
```

Expected:
- Mode-picker screen appears with Local focused by default.
- Press `Enter` → init progress screen → boardroom.
- `.grove/` exists in `/tmp/grove-fresh`.
- `~/.config/grove/config.json` unchanged (default keymap is `none` on happy path).

- [ ] **Step 2: First-run with customize (Connected)**

```bash
rm -rf /tmp/grove-fresh/.grove
cd /tmp/grove-fresh
bun run grove
```

Expected:
- Press `l` → Connected card focused.
- Press `Tab` → customize screen appears.
- Tab through fields; select a preset via `j/k`, set name, set keymap to `vim`.
- Press `Enter`.
- `~/.config/grove/config.json` now contains keymap block from `vim.json`.
- Boardroom screen appears once init + connect complete.

- [ ] **Step 3: Fast-path resume with multiple sessions**

In an existing grove with ≥2 sessions:
```bash
cd /path/to/existing/grove
bun run grove
```

Expected:
- Session list appears, cursor on most-recent active session (rich top row).
- `j/k` moves cursor; top row becomes compact, new focused row becomes rich.
- Enter resumes the focused session; ScreenManager lands on RunningView with the session's id scoped into the feed.

- [ ] **Step 4: Fast-path new session**

From the same grove:
- Press `n` → new-session preset picker.
- Pick a preset → `Enter`.
- Goal-input screen appears, preset pre-selected.
- Complete goal → session spawns.

- [ ] **Step 5: Fast-path filter + archive toggle**

- Press `/` → type a substring of one session's goal; list narrows.
- `Esc` → filter cleared, full list returns.
- Press `a` → archived sessions (if any) appear; footer reflects new count.

- [ ] **Step 6: Connect flow from first-run**

- Fresh grove; mode-picker shows.
- Press `c` → connect screen with default URL.
- Type an unreachable URL, press Enter → inline "Error: ..." renders; URL preserved.
- Press `Esc` → returns to mode-picker with mode selection intact.

- [ ] **Step 7: Quit**

- From any welcome screen, press `q` → terminal returns to prompt cleanly.

- [ ] **Step 8: Commit nothing (manual-only). Record findings**

If all scenarios pass, post a summary comment on issue #190. If any scenario fails, file a follow-up under the same issue and pin to this commit range.

---

## Self-Review Checklist

- [x] Spec coverage: router, fast-path, session row, first-run (mode + customize), new-session, connect, TuiApp/main.ts wiring, keymap preset persistence — all have tasks.
- [x] No placeholders in any task step.
- [x] Type consistency: `WelcomeMode`, `KeymapChoice`, `WelcomeRoute`, `FastPathState/Actions`, `ModePickerState/Actions`, `CustomizeState/Actions`, `NewSessionState/Actions` all defined once and referenced consistently.
- [x] No "similar to Task N" references — each task is self-contained.
- [x] All code blocks contain full content.
- [x] Commands are exact, expected outputs specified.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-welcome-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task; review between tasks; fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans; batch execution with checkpoints.

Which approach?
