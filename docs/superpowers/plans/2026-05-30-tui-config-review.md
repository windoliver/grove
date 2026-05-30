# TUI Session Config-Review Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ConfigReview` screen between preset-select and goal-input that lets an operator edit a session's resolved config (mode, stop-condition thresholds, concurrency limits) before launch, persisting the edits into the session record.

**Architecture:** A new screen `config-review` is inserted into the `ScreenManager` state machine. All editing logic lives in a pure module (`config-edit.ts`) so it can be unit-tested without a TUI renderer (mirrors the existing `agent-detect` helper pattern). The `ConfigReview` component is a thin view + keyboard dispatch over those helpers. The edited `GroveContract` is held in `ScreenState.editedConfig` and threaded into the existing `createSession({config})` call — persistence already works via #198, so no store changes are needed.

**Tech Stack:** TypeScript, React 19, OpenTUI (`@opentui/react`), Zod (contract schemas), Bun test + `react-test-renderer`, Biome.

**Spec:** `docs/superpowers/specs/2026-05-30-tui-config-review-design.md`

---

## Background the implementer needs

- **Editable scope (do not exceed):** `mode` (evaluation⇄exploration), stop-condition numeric thresholds (`maxRoundsWithoutImprovement`, `budget.maxContributions`, `budget.maxWallClockSeconds`, `targetMetric.value` only when a target metric exists), concurrency (`maxActiveClaims`, `maxClaimsPerAgent`). Everything else (topology, metrics, gates, execution, rate-limits, …) is **read-only** and must never be mutated.
- **Where config-review appears:** It is reached from the preset-picker via `handlePresetSelect`. The TUI only shows `preset-select` when no topology is known at boot (the bare-init / GROVE.md-optional path from #200) — that is exactly the target scenario. Boots that already know a topology start at `goal-input` and intentionally bypass both `preset-select` and `config-review` (pre-existing shortcut; out of scope to change).
- **Type shapes** (from `src/core/contract.ts`): `GroveContract.mode?: "evaluation"|"exploration"`, `GroveContract.stopConditions?: StopConditions`, `StopConditions.budget?: Budget` (`Budget` = `{ maxContributions?, maxWallClockSeconds? }`, Zod refine requires ≥1 of the two), `StopConditions.targetMetric?: { metric, value }`, `GroveContract.concurrency?: ConcurrencyConfig` (`{ maxActiveClaims?, maxClaimsPerAgent?, maxClaimsPerTarget? }`).
- **Zod bounds to mirror:** `maxRoundsWithoutImprovement` int 1–1000; `budget.maxContributions` int ≥1; `budget.maxWallClockSeconds` int ≥1; `maxActiveClaims` int 1–1000; `maxClaimsPerAgent` int 0–100; `targetMetric.value` any number.
- **Adding `"config-review"` to `PageKind` forces three TOTAL `Record<PageKind|Screen, …>` maps to gain an entry or TS fails:** `PagesRouterComponentMap` (the component map in `screen-manager.tsx`), and `PAGE_LABELS` + `SCREEN_LABELS` in `breadcrumb-bar.tsx`. The hint map (`STATIC` in `hint-map.ts`) is `Record<string,…>` and is NOT forced, but we add an entry for correct hints.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/tui/screens/config-edit.ts` | **New.** Pure helpers: field list, mode toggle, validated numeric edits, immutable contract updates. No React. |
| `src/tui/screens/config-edit.test.ts` | **New.** Bun unit tests for `config-edit.ts`. |
| `src/tui/screens/config-review.tsx` | **New.** Thin OpenTUI screen: renders fields + read-only summaries, dispatches keys to `config-edit`. |
| `src/tui/views/config-review-hints.ts` | **New.** Hint set for the HintBar. |
| `src/tui/data/pages-store.ts` | Add `"config-review"` to `PageKind`. |
| `src/tui/data/hint-map.ts` | Register `CONFIG_REVIEW_HINTS`. |
| `src/tui/components/breadcrumb-bar.tsx` | Add `config-review` to `PAGE_LABELS` + `SCREEN_LABELS`. |
| `src/tui/screens/screen-manager.tsx` | `Screen` union, `ScreenState.editedConfig`, baseline-contract resolution, `handlePresetSelect` rewrite, confirm/back handlers, `handleGoalBack` refactor, `spawnAgents` config source, component-map entry. |
| `src/tui/screens/screen-manager.test.ts` | Mock `config-review.js`, extend captured-screens, update the broken preset test, add transition + persistence tests. |

---

## Task 1: Pure config-edit module

**Files:**
- Create: `src/tui/screens/config-edit.ts`
- Test: `src/tui/screens/config-edit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/config-edit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { GroveContract } from "../../core/contract.js";
import { getEditableFields, setNumericField, toggleMode } from "./config-edit.js";

const FULL: GroveContract = {
  contractVersion: 2,
  name: "test",
  mode: "evaluation",
  metrics: { latency: { direction: "minimize", gate: 100 } },
  gates: [{ type: "min_score", metric: "latency", threshold: 0.8 }],
  stopConditions: {
    maxRoundsWithoutImprovement: 5,
    targetMetric: { metric: "latency", value: 50 },
    budget: { maxContributions: 200, maxWallClockSeconds: 3600 },
  },
  concurrency: { maxActiveClaims: 4, maxClaimsPerAgent: 2 },
};

describe("getEditableFields", () => {
  test("lists mode + stop + concurrency fields with targetMetric when present", () => {
    const ids = getEditableFields(FULL).map((f) => f.id);
    expect(ids).toEqual([
      "mode",
      "stop.maxRoundsWithoutImprovement",
      "stop.targetMetric.value",
      "stop.budget.maxContributions",
      "stop.budget.maxWallClockSeconds",
      "concurrency.maxActiveClaims",
      "concurrency.maxClaimsPerAgent",
    ]);
  });

  test("omits targetMetric.value when no target metric is defined", () => {
    const noTarget: GroveContract = { ...FULL, stopConditions: { maxRoundsWithoutImprovement: 5 } };
    const ids = getEditableFields(noTarget).map((f) => f.id);
    expect(ids).not.toContain("stop.targetMetric.value");
  });

  test("shows (unset) for absent optional numerics", () => {
    const bare: GroveContract = { contractVersion: 2, name: "bare" };
    const fields = getEditableFields(bare);
    const rounds = fields.find((f) => f.id === "stop.maxRoundsWithoutImprovement");
    expect(rounds?.display).toBe("(unset)");
  });
});

describe("toggleMode", () => {
  test("evaluation -> exploration", () => {
    expect(toggleMode(FULL).mode).toBe("exploration");
  });
  test("exploration -> evaluation", () => {
    expect(toggleMode({ ...FULL, mode: "exploration" }).mode).toBe("evaluation");
  });
  test("undefined -> evaluation", () => {
    expect(toggleMode({ contractVersion: 2, name: "x" }).mode).toBe("evaluation");
  });
});

describe("setNumericField", () => {
  test("sets a valid concurrency value", () => {
    const { config, error } = setNumericField(FULL, "concurrency.maxActiveClaims", "7");
    expect(error).toBeUndefined();
    expect(config.concurrency?.maxActiveClaims).toBe(7);
  });

  test("rejects out-of-range maxClaimsPerAgent", () => {
    const { config, error } = setNumericField(FULL, "concurrency.maxClaimsPerAgent", "200");
    expect(error).toContain("≤ 100");
    expect(config).toBe(FULL); // unchanged reference on error
  });

  test("rejects non-integer for an integer field", () => {
    const { error } = setNumericField(FULL, "stop.maxRoundsWithoutImprovement", "1.5");
    expect(error).toContain("whole number");
  });

  test("empty unsets an optional field and prunes its empty parent", () => {
    const { config } = setNumericField(
      { contractVersion: 2, name: "x", concurrency: { maxActiveClaims: 4 } },
      "concurrency.maxActiveClaims",
      "",
    );
    expect(config.concurrency).toBeUndefined();
  });

  test("clearing one budget field keeps the other", () => {
    const { config } = setNumericField(FULL, "stop.budget.maxContributions", "");
    expect(config.stopConditions?.budget).toEqual({ maxWallClockSeconds: 3600 });
  });

  test("clearing the last budget field drops the budget object", () => {
    const oneBudget: GroveContract = {
      ...FULL,
      stopConditions: { budget: { maxContributions: 200 } },
    };
    const { config } = setNumericField(oneBudget, "stop.budget.maxContributions", "");
    expect(config.stopConditions?.budget).toBeUndefined();
  });

  test("targetMetric.value is required — empty is an error", () => {
    const { error } = setNumericField(FULL, "stop.targetMetric.value", "");
    expect(error).toContain("required");
  });

  test("targetMetric.value accepts a float and preserves the metric name", () => {
    const { config } = setNumericField(FULL, "stop.targetMetric.value", "12.5");
    expect(config.stopConditions?.targetMetric).toEqual({ metric: "latency", value: 12.5 });
  });

  test("does not mutate the input contract", () => {
    const snapshot = JSON.parse(JSON.stringify(FULL));
    setNumericField(FULL, "concurrency.maxActiveClaims", "9");
    expect(FULL).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/screens/config-edit.test.ts --timeout 60000`
Expected: FAIL — `Cannot find module "./config-edit.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/tui/screens/config-edit.ts`:

```ts
/**
 * Pure config-editing helpers for the ConfigReview screen (#201).
 *
 * The ConfigReview component is a thin view + keyboard dispatch over these
 * pure functions, which hold all validation/immutability logic so they can be
 * unit-tested without a TUI renderer (mirrors the agent-detect helper pattern).
 *
 * Editable surface (Tasks-faithful scope, issue #201):
 *   - mode: evaluation <-> exploration
 *   - stopConditions: maxRoundsWithoutImprovement, budget.maxContributions,
 *     budget.maxWallClockSeconds, targetMetric.value (when a target metric exists)
 *   - concurrency: maxActiveClaims, maxClaimsPerAgent
 *
 * Every other contract section is read-only and is never mutated here.
 */

import type {
  Budget,
  ConcurrencyConfig,
  GroveContract,
  StopConditions,
} from "../../core/contract.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Identifiers for the editable fields, in display order. */
export type EditableFieldId =
  | "mode"
  | "stop.maxRoundsWithoutImprovement"
  | "stop.targetMetric.value"
  | "stop.budget.maxContributions"
  | "stop.budget.maxWallClockSeconds"
  | "concurrency.maxActiveClaims"
  | "concurrency.maxClaimsPerAgent";

type NumericFieldId = Exclude<EditableFieldId, "mode">;

/** Numeric validation bounds. Keep in sync with src/core/contract.ts Zod schemas. */
interface NumericBounds {
  readonly min?: number;
  readonly max?: number;
  readonly integer: boolean;
  /** When true, empty input is rejected instead of unsetting the field. */
  readonly required: boolean;
}

/** A single editable field, resolved against the current draft. */
export interface EditableField {
  readonly id: EditableFieldId;
  readonly label: string;
  readonly kind: "enum" | "number";
  /** Display string for the current value (e.g. "evaluation", "200", "(unset)"). */
  readonly display: string;
  readonly bounds?: NumericBounds | undefined;
}

const NUMERIC_BOUNDS: Readonly<Record<NumericFieldId, NumericBounds>> = {
  "stop.maxRoundsWithoutImprovement": { min: 1, max: 1000, integer: true, required: false },
  "stop.targetMetric.value": { integer: false, required: true },
  "stop.budget.maxContributions": { min: 1, integer: true, required: false },
  "stop.budget.maxWallClockSeconds": { min: 1, integer: true, required: false },
  "concurrency.maxActiveClaims": { min: 1, max: 1000, integer: true, required: false },
  "concurrency.maxClaimsPerAgent": { min: 0, max: 100, integer: true, required: false },
};

function fmt(value: number | undefined): string {
  return value === undefined ? "(unset)" : String(value);
}

/**
 * Resolve the ordered list of editable fields against a draft contract.
 * `stop.targetMetric.value` only appears when a target metric is defined — a
 * value without a metric is meaningless and invalid per the schema.
 */
export function getEditableFields(config: GroveContract): readonly EditableField[] {
  const stop = config.stopConditions;
  const conc = config.concurrency;
  const fields: EditableField[] = [
    { id: "mode", label: "Mode", kind: "enum", display: config.mode ?? "(unset)" },
    {
      id: "stop.maxRoundsWithoutImprovement",
      label: "Stop: max rounds without improvement",
      kind: "number",
      display: fmt(stop?.maxRoundsWithoutImprovement),
      bounds: NUMERIC_BOUNDS["stop.maxRoundsWithoutImprovement"],
    },
  ];
  if (stop?.targetMetric?.metric !== undefined) {
    fields.push({
      id: "stop.targetMetric.value",
      label: `Stop: target ${stop.targetMetric.metric}`,
      kind: "number",
      display: fmt(stop.targetMetric.value),
      bounds: NUMERIC_BOUNDS["stop.targetMetric.value"],
    });
  }
  fields.push(
    {
      id: "stop.budget.maxContributions",
      label: "Stop: budget max contributions",
      kind: "number",
      display: fmt(stop?.budget?.maxContributions),
      bounds: NUMERIC_BOUNDS["stop.budget.maxContributions"],
    },
    {
      id: "stop.budget.maxWallClockSeconds",
      label: "Stop: budget max wall-clock (s)",
      kind: "number",
      display: fmt(stop?.budget?.maxWallClockSeconds),
      bounds: NUMERIC_BOUNDS["stop.budget.maxWallClockSeconds"],
    },
    {
      id: "concurrency.maxActiveClaims",
      label: "Concurrency: max active claims",
      kind: "number",
      display: fmt(conc?.maxActiveClaims),
      bounds: NUMERIC_BOUNDS["concurrency.maxActiveClaims"],
    },
    {
      id: "concurrency.maxClaimsPerAgent",
      label: "Concurrency: max claims per agent",
      kind: "number",
      display: fmt(conc?.maxClaimsPerAgent),
      bounds: NUMERIC_BOUNDS["concurrency.maxClaimsPerAgent"],
    },
  );
  return fields;
}

/** Toggle mode evaluation <-> exploration (undefined becomes "evaluation"). */
export function toggleMode(config: GroveContract): GroveContract {
  return { ...config, mode: config.mode === "evaluation" ? "exploration" : "evaluation" };
}

/** Result of a numeric edit: the (possibly unchanged) config plus an optional error. */
export interface FieldEditResult {
  readonly config: GroveContract;
  readonly error?: string | undefined;
}

/** Parse a strict base-10 integer; undefined if the string isn't a clean integer. */
function parseInteger(s: string): number | undefined {
  if (!/^-?\d+$/.test(s)) return undefined;
  return Number.parseInt(s, 10);
}

function hasAnyKey(obj: object): boolean {
  return Object.keys(obj).length > 0;
}

function assign<T, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

/**
 * Apply a raw string edit to a numeric field. Returns the updated config, or
 * the original config plus an `error` message when validation fails.
 *
 * Empty input unsets an optional field; `required` fields (targetMetric.value)
 * reject empty. Clearing both budget sub-fields drops the budget object so the
 * contract never carries an empty budget (its Zod refine rejects that).
 */
export function setNumericField(
  config: GroveContract,
  id: EditableFieldId,
  raw: string,
): FieldEditResult {
  if (id === "mode") return { config };
  const bounds = NUMERIC_BOUNDS[id];
  const trimmed = raw.trim();

  let value: number | undefined;
  if (trimmed === "") {
    if (bounds.required) return { config, error: "value is required" };
    value = undefined;
  } else {
    const parsed = bounds.integer ? parseInteger(trimmed) : Number(trimmed);
    if (parsed === undefined || Number.isNaN(parsed)) {
      return { config, error: bounds.integer ? "must be a whole number" : "must be a number" };
    }
    if (bounds.min !== undefined && parsed < bounds.min) {
      return { config, error: `must be ≥ ${bounds.min}` };
    }
    if (bounds.max !== undefined && parsed > bounds.max) {
      return { config, error: `must be ≤ ${bounds.max}` };
    }
    value = parsed;
  }

  const stop = structuredClone(config.stopConditions ?? {}) as Mutable<StopConditions>;
  const conc = structuredClone(config.concurrency ?? {}) as Mutable<ConcurrencyConfig>;

  switch (id) {
    case "stop.maxRoundsWithoutImprovement":
      assign(stop, "maxRoundsWithoutImprovement", value);
      break;
    case "stop.targetMetric.value": {
      const metric = stop.targetMetric?.metric;
      if (metric === undefined) return { config };
      stop.targetMetric = { metric, value: value as number };
      break;
    }
    case "stop.budget.maxContributions": {
      const budget = { ...(stop.budget ?? {}) } as Mutable<Budget>;
      assign(budget, "maxContributions", value);
      assign(stop, "budget", hasAnyKey(budget) ? budget : undefined);
      break;
    }
    case "stop.budget.maxWallClockSeconds": {
      const budget = { ...(stop.budget ?? {}) } as Mutable<Budget>;
      assign(budget, "maxWallClockSeconds", value);
      assign(stop, "budget", hasAnyKey(budget) ? budget : undefined);
      break;
    }
    case "concurrency.maxActiveClaims":
      assign(conc, "maxActiveClaims", value);
      break;
    case "concurrency.maxClaimsPerAgent":
      assign(conc, "maxClaimsPerAgent", value);
      break;
  }

  const next = { ...config } as Mutable<GroveContract>;
  assign(next, "stopConditions", hasAnyKey(stop) ? stop : undefined);
  assign(next, "concurrency", hasAnyKey(conc) ? conc : undefined);
  return { config: next };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/screens/config-edit.test.ts --timeout 60000`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Typecheck + lint the new files**

Run: `tsc --noEmit && bunx biome check src/tui/screens/config-edit.ts src/tui/screens/config-edit.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tui/screens/config-edit.ts src/tui/screens/config-edit.test.ts
git commit --no-verify -m "feat(#201): pure config-edit helpers for ConfigReview"
```

---

## Task 2: ConfigReview component + hints

**Files:**
- Create: `src/tui/screens/config-review.tsx`
- Create: `src/tui/views/config-review-hints.ts`

> No standalone render test: the component is a thin view + key dispatch over the Task-1 helpers (already tested) and is exercised end-to-end by the flow test in Task 4. This mirrors `agent-detect.tsx`, whose logic is tested via extracted helpers rather than a component render.

- [ ] **Step 1: Create the hints file**

Create `src/tui/views/config-review-hints.ts`:

```ts
/** Hints for the config-review screen (#201). */
import { defineHints, type KeyAction } from "../data/hint-map.js";

export const CONFIG_REVIEW_HINTS: readonly KeyAction[] = defineHints([
  { key: "j/k", label: "Navigate" },
  { key: "e", label: "Edit" },
  { key: "space", label: "Toggle mode" },
  { key: "d", label: "Reset" },
  { key: "Enter", label: "Continue" },
  { key: "Esc", label: "Back" },
]);
```

- [ ] **Step 2: Create the component**

Create `src/tui/screens/config-review.tsx`:

```tsx
/**
 * Config Review screen (#201).
 *
 * Sits between preset-select and goal-input. Shows the session config resolved
 * from the chosen preset and lets the operator edit a focused set of
 * scalar/enum fields (mode, stop-condition thresholds, concurrency limits).
 * Topology, metrics, and gates are shown read-only. All editing logic lives in
 * the pure ./config-edit module.
 *
 * Keys: j/k navigate · e edit scalar · space toggle mode · d reset to preset
 * defaults · Enter confirm & continue · Esc back to preset-select.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useMemo, useState } from "react";
import type { Gate, GroveContract } from "../../core/contract.js";
import type { AgentTopology } from "../../core/topology.js";
import { theme } from "../theme.js";
import { getEditableFields, setNumericField, toggleMode } from "./config-edit.js";
import { matchesKey } from "./key-match.js";

/** Props for the ConfigReview screen. */
export interface ConfigReviewProps {
  readonly config: GroveContract;
  readonly topology?: AgentTopology | undefined;
  readonly onConfirm: (updated: GroveContract) => void;
  readonly onBack: () => void;
}

function countEdges(topology: AgentTopology): number {
  let n = 0;
  for (const role of topology.roles) n += role.edges?.length ?? 0;
  return n;
}

function gateTarget(g: Gate): string {
  return g.metric ?? g.name ?? g.relationType ?? "";
}

/** Screen 1.5: review and edit the resolved session config before goal input. */
export const ConfigReview: React.NamedExoticComponent<ConfigReviewProps> = React.memo(
  function ConfigReview({ config, topology, onConfirm, onBack }: ConfigReviewProps): React.ReactNode {
    const [draft, setDraft] = useState<GroveContract>(config);
    const [cursor, setCursor] = useState(0);
    const [editing, setEditing] = useState(false);
    const [buffer, setBuffer] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);

    const fields = useMemo(() => getEditableFields(draft), [draft]);
    const current = fields[Math.min(cursor, fields.length - 1)];

    useKeyboard(
      useCallback(
        (key) => {
          if (editing) {
            if (key.name === "return" || key.name === "enter") {
              if (!current) {
                setEditing(false);
                return;
              }
              const result = setNumericField(draft, current.id, buffer);
              if (result.error) {
                setError(result.error);
                return;
              }
              setDraft(result.config);
              setEditing(false);
              setError(undefined);
              return;
            }
            if (key.name === "escape") {
              setEditing(false);
              setError(undefined);
              return;
            }
            if (key.name === "backspace") {
              setBuffer((b) => b.slice(0, -1));
              return;
            }
            const seq = key.sequence ?? "";
            if (/^[0-9.-]$/.test(seq)) setBuffer((b) => b + seq);
            return;
          }

          // Normal mode
          if (matchesKey(key, "j") || key.name === "down") {
            setCursor((c) => Math.min(c + 1, fields.length - 1));
            return;
          }
          if (matchesKey(key, "k") || key.name === "up") {
            setCursor((c) => Math.max(c - 1, 0));
            return;
          }
          if (key.name === "space" && current?.kind === "enum") {
            setDraft((d) => toggleMode(d));
            return;
          }
          if (matchesKey(key, "e") && current?.kind === "number") {
            setBuffer(current.display === "(unset)" ? "" : current.display);
            setError(undefined);
            setEditing(true);
            return;
          }
          if (matchesKey(key, "d")) {
            setDraft(config);
            setError(undefined);
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            onConfirm(draft);
            return;
          }
          if (key.name === "escape") {
            onBack();
            return;
          }
        },
        [editing, current, draft, buffer, fields.length, config, onConfirm, onBack],
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
            Review session config
          </text>
          <text color={theme.secondary}>{config.name}</text>
        </box>

        {/* Editable settings */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Settings (e:edit  space:toggle mode  d:reset)
          </text>
          {fields.map((field, i) => {
            const selected = i === cursor;
            const isEditingThis = editing && selected;
            return (
              <box
                key={field.id}
                flexDirection="row"
                backgroundColor={selected ? theme.selectedBg : undefined}
                paddingX={1}
              >
                <text color={selected ? theme.focus : theme.text}>{selected ? "> " : "  "}</text>
                <text color={theme.text}>{field.label.padEnd(38)}</text>
                <text color={isEditingThis ? theme.focus : theme.secondary}>
                  {isEditingThis ? `${buffer}_` : field.display}
                </text>
              </box>
            );
          })}
          {error ? <text color={theme.error}>{error}</text> : null}
        </box>

        {/* Read-only: topology */}
        {topology && topology.roles.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Topology (read-only)
            </text>
            <text color={theme.secondary}>
              {topology.roles.map((r) => r.name).join(", ")} {"·"} {countEdges(topology)} edges
            </text>
          </box>
        ) : null}

        {/* Read-only: metrics */}
        {draft.metrics && Object.keys(draft.metrics).length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Metrics (read-only)
            </text>
            {Object.entries(draft.metrics).map(([name, def]) => (
              <text key={name} color={theme.secondary}>
                {name} ({def.direction}
                {def.gate !== undefined ? `, gate ${def.gate}` : ""})
              </text>
            ))}
          </box>
        ) : null}

        {/* Read-only: gates */}
        {draft.gates && draft.gates.length > 0 ? (
          <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
            <text color={theme.text} bold>
              Gates (read-only)
            </text>
            {draft.gates.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: gates have no stable identity
              <text key={`${g.type}-${i}`} color={theme.secondary}>
                {g.type}
                {gateTarget(g) ? ` ${"→"} ${gateTarget(g)}` : ""}
              </text>
            ))}
          </box>
        ) : null}

        {/* Hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.secondary}>
            {editing
              ? "Type a number  Enter:save  Esc:cancel  (empty clears optional fields)"
              : "j/k:navigate  e:edit  space:toggle mode  d:reset  Enter:continue  Esc:back"}
          </text>
        </box>
      </box>
    );
  },
);
```

- [ ] **Step 3: Typecheck + lint**

Run: `tsc --noEmit && bunx biome check src/tui/screens/config-review.tsx src/tui/views/config-review-hints.ts`
Expected: no errors. (If biome flags the gate key, the `biome-ignore` line above suppresses it — verify it is on the line directly above the `<text key=…>`.)

- [ ] **Step 4: Commit**

```bash
git add src/tui/screens/config-review.tsx src/tui/views/config-review-hints.ts
git commit --no-verify -m "feat(#201): ConfigReview screen component + hints"
```

---

## Task 3: Register the page kind, labels, and hint map

**Files:**
- Modify: `src/tui/data/pages-store.ts:15-26`
- Modify: `src/tui/data/hint-map.ts` (imports + `STATIC`)
- Modify: `src/tui/components/breadcrumb-bar.tsx` (`PAGE_LABELS` ~line 29, `SCREEN_LABELS` ~line 163)

- [ ] **Step 1: Add `config-review` to `PageKind`**

In `src/tui/data/pages-store.ts`, edit the `PageKind` union to insert `"config-review"` after `"goal-input"`:

```ts
export type PageKind =
  | "preset-select"
  | "goal-input"
  | "config-review"
  | "agent-detect"
  | "launch-preview"
  | "spawning"
  | "running"
  | "complete"
  | "inspect"
  | "panel"
  | "entity-detail"
  | "pulse";
```

- [ ] **Step 2: Register the hint set**

In `src/tui/data/hint-map.ts`, add the import next to the other hint imports (near line 14-18):

```ts
import { CONFIG_REVIEW_HINTS } from "../views/config-review-hints.js";
```

Then add an entry to the `STATIC` object, right after the `"goal-input"` line:

```ts
  "goal-input": GOAL_INPUT_HINTS,
  "config-review": CONFIG_REVIEW_HINTS,
```

- [ ] **Step 3: Add breadcrumb labels**

In `src/tui/components/breadcrumb-bar.tsx`, add to `PAGE_LABELS` (the `Record<PageKind, string>` near line 29), after `"goal-input"`:

```ts
  "goal-input": "Goal",
  "config-review": "Config Review",
```

And add to `SCREEN_LABELS` (the `Record<Screen, string>` near line 163), after its `"goal-input"` line:

```ts
  "goal-input": "Goal",
  "config-review": "Config Review",
```

- [ ] **Step 4: Typecheck**

Run: `tsc --noEmit`
Expected: This will now fail ONLY inside `screen-manager.tsx` (the `PagesRouterComponentMap` total record is missing a `config-review` entry). `pages-store.ts`, `hint-map.ts`, and `breadcrumb-bar.tsx` must be clean. That remaining error is fixed in Task 4. If any error points at the three files in this task, fix it before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/pages-store.ts src/tui/data/hint-map.ts src/tui/components/breadcrumb-bar.tsx
git commit --no-verify -m "feat(#201): register config-review page kind, hints, breadcrumb labels"
```

---

## Task 4: Wire ConfigReview into the ScreenManager flow

**Files:**
- Modify: `src/tui/screens/screen-manager.tsx` (imports, `Screen` union ~line 61, `ScreenState` ~line 72, baseline resolver ~line 280, `handlePresetSelect` ~line 600, new handlers, `handleGoalBack` ~line 934, `spawnAgents` ~line 681 + deps ~line 852, component map ~line 1071 + deps)

- [ ] **Step 1: Add imports**

Add the component import next to the other screen imports (after `import { CompleteView } from "./complete-view.js";`):

```ts
import { ConfigReview } from "./config-review.js";
```

Add the preset→contract helpers near the top-level imports (with the other non-React imports):

```ts
import { getPreset, presetToSessionConfig } from "../../cli/presets/index.js";
```

- [ ] **Step 2: Add `config-review` to the `Screen` union**

Edit the `Screen` type (line 61) to insert it after `"goal-input"`:

```ts
export type Screen =
  | "preset-select"
  | "agent-detect"
  | "goal-input"
  | "config-review"
  | "launch-preview"
  | "spawning"
  | "running"
  | "complete"
  | "inspect";
```

- [ ] **Step 3: Add `editedConfig` to `ScreenState`**

In the `ScreenState` interface (line 72), add this field after `goal?: string;`:

```ts
  /** Operator-edited session config from the config-review screen (#201). */
  editedConfig?: import("../../core/contract.js").GroveContract | undefined;
```

- [ ] **Step 4: Add the baseline-contract resolver**

Immediately after the `resolveBaselineTopology` `useCallback` (ends ~line 288), add:

```ts
    // Resolve the config a preset would produce, so config-review can show and
    // edit it before the session exists. Falls back to the boot-time contract
    // (GROVE.md or grove.json preset) when the picked preset isn't resolvable.
    const resolveBaselineContract = useCallback(
      (presetName: string) => {
        const preset = getPreset(presetName);
        if (preset) return presetToSessionConfig(preset, presetName);
        return contract;
      },
      [contract],
    );
```

- [ ] **Step 5: Rewrite `handlePresetSelect`**

Replace the existing `handlePresetSelect` (lines 600-615) with:

```ts
    // Screen 1 -> 1.5: preset selected → resolve topology + baseline config and
    // go to config-review. When no config is resolvable (remote/nexus with no
    // contract), skip straight to goal-input — there is nothing to edit.
    const handlePresetSelect = useCallback(
      (presetName: string) => {
        const presetTopology = resolveBaselineTopology(presetName);
        if (presetTopology) {
          setTopology(presetTopology);
        }
        const baseline = resolveBaselineContract(presetName);
        if (baseline) {
          setState((s) => ({
            ...s,
            screen: "config-review",
            selectedPreset: presetName,
            editedConfig: baseline,
          }));
          pages.push({ kind: "config-review" });
        } else {
          setState((s) => ({ ...s, screen: "goal-input", selectedPreset: presetName }));
          pages.push({ kind: "goal-input" });
        }
      },
      [pages, resolveBaselineTopology, resolveBaselineContract],
    );

    // Screen 1.5 -> 2: config confirmed → store edits and go to goal input.
    const handleConfigReviewConfirm = useCallback(
      (updatedConfig: import("../../core/contract.js").GroveContract) => {
        setState((s) => ({ ...s, screen: "goal-input", editedConfig: updatedConfig }));
        pages.push({ kind: "goal-input" });
      },
      [pages],
    );

    // Screen 1.5 -> 1: back to preset select.
    const handleConfigReviewBack = useCallback(() => {
      setState((s) => ({ ...s, screen: "preset-select" }));
      pages.pop();
    }, [pages]);
```

- [ ] **Step 6: Refactor `handleGoalBack` to derive its target from the stack**

Replace `handleGoalBack` (lines 934-949) with a version that pops to whatever is beneath goal-input (config-review in the new flow, or preset-select otherwise):

```ts
    // Screen 2 -> back: pop to the page beneath goal-input (config-review in the
    // preset flow, else preset-select). Topology-first launches have goal-input
    // as the only page, so Esc exits instead of dead-ending.
    const handleGoalBack = useCallback(() => {
      hasSpawnedRef.current = false; // Reset so fresh launch is allowed after going back
      if (pages.depth() > 1) {
        pages.pop();
        const top = pages.top();
        setState((s) => ({ ...s, screen: (top?.kind as Screen) ?? "preset-select" }));
      } else if (presets && presets.length > 0) {
        setState((s) => ({ ...s, screen: "preset-select" }));
        pages.resetTo({ kind: "preset-select" });
      } else {
        handleQuit();
      }
    }, [presets, handleQuit, pages]);
```

- [ ] **Step 7: Thread the edited config into session creation**

In `spawnAgents`, replace the two lines at 681-682:

```ts
            const sessionTopology = resolvedTopology;
            const sessionConfig =
              contract && sessionTopology ? { ...contract, topology: sessionTopology } : contract;
```

with:

```ts
            const sessionTopology = resolvedTopology;
            const baseConfig = state.editedConfig ?? contract;
            const sessionConfig =
              baseConfig && sessionTopology
                ? { ...baseConfig, topology: sessionTopology }
                : baseConfig;
```

Then add `state.editedConfig` to the `spawnAgents` dependency array (line 852):

```ts
      [provider, topology, contract, state.editedConfig, state.selectedPreset, spawnManager, appProps.groveDir, pages],
```

- [ ] **Step 8: Add the component-map entry**

In the `components` `useMemo` (line 1071), add this page factory next to `GoalInputPage` (after the `GoalInputPage` definition):

```ts
      const ConfigReviewPage = (): React.ReactNode => {
        const cfg = state.editedConfig ?? contract;
        if (!cfg) return <box />;
        return (
          <ConfigReview
            config={cfg}
            topology={topology}
            onConfirm={handleConfigReviewConfirm}
            onBack={handleConfigReviewBack}
          />
        );
      };
```

Add the entry to the returned map object (after `"goal-input": GoalInputPage,`):

```ts
        "goal-input": GoalInputPage,
        "config-review": ConfigReviewPage,
```

Add the new dependencies to the `useMemo` dependency array (alongside `handleGoalBack`, `state.goal`, etc.):

```ts
      state.editedConfig,
      handleConfigReviewConfirm,
      handleConfigReviewBack,
```

- [ ] **Step 9: Typecheck**

Run: `tsc --noEmit`
Expected: PASS (the `PagesRouterComponentMap` total record is now satisfied, all unions consistent).

- [ ] **Step 10: Commit**

```bash
git add src/tui/screens/screen-manager.tsx
git commit --no-verify -m "feat(#201): insert config-review into ScreenManager flow"
```

---

## Task 5: Flow + persistence tests

**Files:**
- Modify: `src/tui/screens/screen-manager.test.ts` (mock, captured types, helpers, update broken test, add 2 tests)

- [ ] **Step 1: Mock the new screen and extend captured state**

Add a `ConfigReviewProps` import next to the other prop-type imports (~line 42-47):

```ts
import type { ConfigReviewProps } from "./config-review.js";
```

Extend the `CapturedScreens` interface (line 63) — add the `config-review` literal to the `screen` union and a `configReview` field:

```ts
interface CapturedScreens {
  screen?:
    | "preset-select"
    | "config-review"
    | "launch-preview"
    | "spawning"
    | "running"
    | "complete";
  presetSelect?: PresetSelectProps;
  configReview?: ConfigReviewProps;
  launchPreview?: AgentDetectProps;
  spawnProgress?: SpawnProgressProps;
  runningView?: RunningViewProps;
  completeView?: CompleteViewProps;
}
```

Add a `mock.module` for the screen, directly after the `mock.module("./preset-select.js", …)` block (~line 208):

```ts
mock.module("./config-review.js", () => ({
  ConfigReview: (props: ConfigReviewProps): React.ReactNode => {
    captured = { ...captured, screen: "config-review", configReview: props };
    return null;
  },
}));
```

Add a require-helper next to `requirePresetSelect` (~line 628):

```ts
function requireConfigReview(): ConfigReviewProps {
  const props = captured.configReview;
  if (!props) throw new Error("ConfigReview was not rendered");
  return props;
}
```

- [ ] **Step 2: Update the now-broken preset-select transition test**

Replace the test at lines 659-668 (`"preset-select -> goal-input stores the preset and resolves its topology"`) with two tests — the first asserts the new config-review hop, the second drives confirm → goal-input:

```ts
  test("preset-select -> config-review resolves the preset's baseline config", () => {
    renderScreenManager({ presets: PRESETS });

    act(() => {
      requirePresetSelect().onSelect("review-loop");
    });

    expect(captured.screen).toBe("config-review");
    expect(requireConfigReview().config).toBeDefined();
    expect(requireConfigReview().config.name).toBeDefined();
  });

  test("config-review -> goal-input resolves the selected preset topology", () => {
    const { renderer } = renderScreenManager({ presets: PRESETS });

    act(() => {
      requirePresetSelect().onSelect("review-loop");
    });
    act(() => {
      requireConfigReview().onConfirm(requireConfigReview().config);
    });

    expectGoalInput(renderer);
    expect(renderedText(renderer)).toContain("2 agents will be configured");
  });
```

- [ ] **Step 3: Add the persistence test**

Add this test inside the `describe("ScreenManager transition flow", …)` block (e.g. after the test added above):

```ts
  test("edited config from config-review is persisted into the created session", async () => {
    const providerBundle = makeProvider();
    renderScreenManager({ presets: PRESETS, provider: providerBundle.provider });

    act(() => {
      requirePresetSelect().onSelect("review-loop");
    });

    // Operator edits the resolved config, then confirms.
    const baseline = requireConfigReview().config;
    const edited = {
      ...baseline,
      mode: "exploration" as const,
      concurrency: { ...baseline.concurrency, maxActiveClaims: 9 },
    };
    act(() => {
      requireConfigReview().onConfirm(edited);
    });

    await submitGoal("Persist edited config");

    await act(async () => {
      requireLaunchPreview().onContinue(
        new Map([["claude", true]]),
        new Map([
          ["coder", "claude"],
          ["reviewer", "claude"],
        ]),
        new Map(),
        new Map(),
        new Map(),
      );
      await flushAsync();
      await flushAsync();
    });

    const created = providerBundle.calls.createSession[0];
    if (!created?.config) throw new Error("Expected createSession to receive a config");
    expect(created.config.mode).toBe("exploration");
    expect(created.config.concurrency?.maxActiveClaims).toBe(9);
    // Topology is merged into the persisted config snapshot.
    expect(created.config.topology).toBeDefined();
  });
```

> Note: this test relies on the real `review-loop` preset resolving to a topology (`coder`, `reviewer` roles) and a contract. If the preset role names differ, read `lookupPresetTopology("review-loop").roles` and update the `roleMapping` Map keys accordingly — the assertion on `created.config` is what matters.

- [ ] **Step 4: Run the screen-manager tests**

Run: `bun test src/tui/screens/screen-manager.test.ts --timeout 60000`
Expected: PASS — all transition, navigation, and the new config-review tests green.

- [ ] **Step 5: Typecheck + lint the test file**

Run: `tsc --noEmit && bunx biome check src/tui/screens/screen-manager.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tui/screens/screen-manager.test.ts
git commit --no-verify -m "test(#201): config-review flow + edited-config persistence"
```

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck the whole project**

Run: `tsc --noEmit`
Expected: PASS (0 errors). This is the `erasableSyntaxOnly` gate — the new code uses no enums/namespaces/param-properties, so it should be clean.

- [ ] **Step 2: Run the TUI test suite**

Run: `bun test src/tui --timeout 60000`
Expected: PASS. Pay attention to `hint-map.test.ts`, `pages-store.test.ts`, and `breadcrumb-bar.test.ts` — none assert PageKind exhaustiveness against a derived list, so adding `config-review` should not break them. If any fails, the new union member needs the corresponding map entry from Task 3.

- [ ] **Step 3: Targeted biome (avoid the full-repo worktree hang)**

Run: `bunx biome check src/tui/screens/config-edit.ts src/tui/screens/config-edit.test.ts src/tui/screens/config-review.tsx src/tui/views/config-review-hints.ts src/tui/data/pages-store.ts src/tui/data/hint-map.ts src/tui/components/breadcrumb-bar.tsx src/tui/screens/screen-manager.tsx src/tui/screens/screen-manager.test.ts`
Expected: no errors. (Per project notes, full-repo `biome check .` can hang in worktrees — keep it targeted.)

- [ ] **Step 4: Manual TUI smoke (tracked follow-up, not blocking)**

In a bare-init grove (no GROVE.md): `grove up`, pick a preset → the **Config Review** screen appears → press `e` on "max active claims", type a new value, `Enter`, then `Enter` to continue → enter a goal → launch. After launch, confirm the session record's stored config carries the edited value (e.g. inspect the session via the Nexus/SQLite store or the inspect overlay). Record the result in the PR.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit --no-verify -m "chore(#201): verification fixes for config-review"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** New ConfigReview screen (Task 2) ✓; editable mode/stop/concurrency (Task 1 `getEditableFields` + `setNumericField`) ✓; read-only topology/metrics/gates (Task 2 render) ✓; "use defaults" escape hatch = bypass when no contract (Task 4 `handlePresetSelect` else-branch) + `d` reset (Task 2) ✓; persist to session record (Task 4 `spawnAgents` + existing `createSession`, verified Task 5) ✓; validation/bounds + budget-drop (Task 1) ✓; flow ordering preset→config-review→goal (Task 4) ✓.

**Placeholder scan:** No TBD/TODO; every code step contains complete code; commands have expected output.

**Type consistency:** `EditableFieldId`, `EditableField`, `FieldEditResult`, `getEditableFields`, `setNumericField`, `toggleMode`, `ConfigReviewProps` names are identical across Tasks 1, 2, 4, 5. `editedConfig` field name consistent in `ScreenState`, `handlePresetSelect`, `handleConfigReviewConfirm`, `spawnAgents`, component map, and the persistence test. `config-review` literal consistent across `PageKind`, `Screen`, both label records, hint map, component map, and test captured-union.
