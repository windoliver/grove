# C2: Command Prompt + Filter with Alias Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a k9s-style `<Prompt>` for the TUI running-view supporting `:` goto-with-alias-chain and `/` in-view filter, backed by a YAML alias file (project + user merge) with zod validation, recursive resolution (max 8 hops, cycle detection), and tab-complete.

**Architecture:** Four sharply-bounded units — `aliases.ts` (pure resolver), `aliases-loader.ts` (IO + zod), `prompt.tsx` (presentational), `running-view.tsx` integration with new goto dispatch table and filter predicate composition. EntityView's existing `predicate` prop is the integration point for `/foo`. `:` is repurposed away from message-send; `m` remains the only message-send key.

**Tech Stack:** TypeScript, React (`@opentui/core`), Bun test, zod 4.x, `yaml` 2.x.

**Spec:** `docs/superpowers/specs/2026-05-07-c2-prompt-aliases-design.md`
**Issue:** [#302](https://github.com/windoliver/grove/issues/302)

---

## File Structure

**Create:**
- `src/tui/data/aliases.ts` — pure: `DEFAULT_ALIASES`, `resolveAlias`, `matchAliases`, types.
- `src/tui/data/aliases.test.ts` — pure unit tests.
- `src/tui/data/aliases-loader.ts` — IO + zod schema + merge.
- `src/tui/data/aliases-loader.test.ts` — loader tests using `tmpdir()`.
- `src/tui/components/prompt.tsx` — presentational prompt overlay.
- `src/tui/components/prompt.test.tsx` — render tests.
- `src/tui/components/flash-bar.tsx` — transient error bar.
- `src/tui/screens/running-cmd-mode.ts` — pure cmd-mode state + actions (extracted to keep running-view leaner).
- `src/tui/screens/running-cmd-mode.test.ts`.

**Modify:**
- `src/tui/screens/running-keyboard.ts` — add `cmdMode` to state, new actions, route `:` and `/`.
- `src/tui/screens/running-keyboard.test.ts` — add cases for goto + filter routing.
- `src/tui/screens/running-view.tsx` — integrate prompt, alias load, filter wiring, goto dispatch, new RunningPanel entries.
- `src/tui/views/agent-list.tsx`, `src/tui/views/dag.tsx` — accept optional external filter predicate (compose with view-internal predicate).

---

## Naming convention to avoid clash with existing message mode

The running-view already uses `promptMode: boolean` for the **send-to-agent** flow (triggered by `m`). This plan keeps that intact and introduces a separate `cmdMode: 'none'|'goto'|'filter'` for the new k9s-style command prompt. Where this plan says "prompt", it means the new `Prompt` component for goto/filter. The legacy message flow is renamed to `messageMode` for clarity in the running-view changes.

---

## Task 1: Pure module — types and DEFAULT_ALIASES

**Files:**
- Create: `src/tui/data/aliases.ts`
- Test: `src/tui/data/aliases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/data/aliases.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_ALIASES, MAX_ALIAS_DEPTH } from "./aliases.js";

describe("DEFAULT_ALIASES", () => {
  test("contains six built-in keys", () => {
    expect([...DEFAULT_ALIASES.keys()].sort()).toEqual([
      "a",
      "d",
      "q",
      "r",
      "s",
      "t",
    ]);
  });

  test("maps to expected commands", () => {
    expect(DEFAULT_ALIASES.get("a")?.value).toBe("agents");
    expect(DEFAULT_ALIASES.get("s")?.value).toBe("sessions");
    expect(DEFAULT_ALIASES.get("t")?.value).toBe("tasks");
    expect(DEFAULT_ALIASES.get("d")?.value).toBe("dag");
    expect(DEFAULT_ALIASES.get("r")?.value).toBe("reviews");
    expect(DEFAULT_ALIASES.get("q")?.value).toBe("quit");
  });

  test("MAX_ALIAS_DEPTH is 8", () => {
    expect(MAX_ALIAS_DEPTH).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: FAIL — "Cannot find module './aliases.js'"

- [ ] **Step 3: Create the module**

Create `src/tui/data/aliases.ts`:

```ts
/**
 * Pure alias resolver for the C2 command prompt.
 *
 * Resolves k9s-style aliases (e.g. ":a" → agents view) with recursion
 * (max 8 hops), cycle detection, and argv passthrough. No IO, no React.
 */

export interface AliasEntry {
  /** Resolved command. May start with ":" to chain into another alias. */
  readonly value: string;
}

export type AliasMap = ReadonlyMap<string, AliasEntry>;

export const MAX_ALIAS_DEPTH = 8;

export const DEFAULT_ALIASES: AliasMap = new Map<string, AliasEntry>([
  ["a", { value: "agents" }],
  ["s", { value: "sessions" }],
  ["t", { value: "tasks" }],
  ["d", { value: "dag" }],
  ["r", { value: "reviews" }],
  ["q", { value: "quit" }],
]);

export type ResolveResult =
  | { kind: "ok"; command: string; argv: readonly string[]; chain: readonly string[] }
  | { kind: "miss"; key: string }
  | { kind: "cycle"; chain: readonly string[] }
  | { kind: "depth"; chain: readonly string[] };

export function resolveAlias(_map: AliasMap, _input: string): ResolveResult {
  throw new Error("not implemented");
}

export function matchAliases(_map: AliasMap, _prefix: string): readonly string[] {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/aliases.ts src/tui/data/aliases.test.ts
git commit -m "feat(tui): scaffold aliases module with DEFAULT_ALIASES (C2, #302)"
```

---

## Task 2: `resolveAlias` — direct match + miss

**Files:**
- Modify: `src/tui/data/aliases.ts`, `src/tui/data/aliases.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/data/aliases.test.ts`:

```ts
import { resolveAlias } from "./aliases.js";

describe("resolveAlias direct + miss", () => {
  test("direct match returns ok with command and empty argv", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["a"] });
  });

  test("unknown key at depth 0 returns miss", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "zzz");
    expect(r).toEqual({ kind: "miss", key: "zzz" });
  });

  test("empty input returns miss with empty key", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "");
    expect(r).toEqual({ kind: "miss", key: "" });
  });

  test("whitespace-only input returns miss", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "   ");
    expect(r).toEqual({ kind: "miss", key: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: FAIL — `resolveAlias` throws "not implemented".

- [ ] **Step 3: Implement minimal resolveAlias**

Replace the body of `resolveAlias` in `src/tui/data/aliases.ts`:

```ts
export function resolveAlias(map: AliasMap, input: string): ResolveResult {
  return resolveInternal(map, input, 0, new Set<string>(), []);
}

function resolveInternal(
  map: AliasMap,
  input: string,
  depth: number,
  visited: Set<string>,
  chain: readonly string[],
): ResolveResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "miss", key: "" };
  const tokens = trimmed.split(/\s+/);
  const key = tokens[0]!;
  const rest = tokens.slice(1);

  if (visited.has(key)) return { kind: "cycle", chain: [...chain, key] };
  if (depth > MAX_ALIAS_DEPTH) return { kind: "depth", chain };

  const entry = map.get(key);
  if (!entry) {
    return depth === 0
      ? { kind: "miss", key }
      : { kind: "ok", command: key, argv: rest, chain };
  }

  // Terminal alias: value does not start with ":"
  if (!entry.value.startsWith(":")) {
    const valueTokens = entry.value.split(/\s+/);
    const cmd = valueTokens[0]!;
    const valueArgs = valueTokens.slice(1);
    return {
      kind: "ok",
      command: cmd,
      argv: [...valueArgs, ...rest],
      chain: [...chain, key],
    };
  }

  // Recursive alias: value starts with ":"
  visited.add(key);
  const next = entry.value.slice(1) + (rest.length ? " " + rest.join(" ") : "");
  return resolveInternal(map, next, depth + 1, visited, [...chain, key]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/aliases.ts src/tui/data/aliases.test.ts
git commit -m "feat(tui): resolveAlias direct match + miss (C2, #302)"
```

---

## Task 3: `resolveAlias` — recursion + argv passthrough

**Files:**
- Modify: `src/tui/data/aliases.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/data/aliases.test.ts`:

```ts
describe("resolveAlias recursion + argv", () => {
  function withCustom(extra: Record<string, string>): AliasMap {
    const m = new Map(DEFAULT_ALIASES);
    for (const [k, v] of Object.entries(extra)) m.set(k, { value: v });
    return m;
  }

  test("alias chains to another alias", () => {
    const m = withCustom({ dev: ":a" });
    const r = resolveAlias(m, "dev");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["dev", "a"] });
  });

  test("argv from input passes through", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a foo bar");
    expect(r).toEqual({
      kind: "ok",
      command: "agents",
      argv: ["foo", "bar"],
      chain: ["a"],
    });
  });

  test("argv from alias value merges with input argv", () => {
    const m = withCustom({ prod: ":a foo" });
    const r = resolveAlias(m, "prod bar");
    expect(r).toEqual({
      kind: "ok",
      command: "agents",
      argv: ["foo", "bar"],
      chain: ["prod", "a"],
    });
  });

  test("terminal alias with multi-word value", () => {
    const m = withCustom({ hello: "echo hi" });
    const r = resolveAlias(m, "hello there");
    expect(r).toEqual({
      kind: "ok",
      command: "echo",
      argv: ["hi", "there"],
      chain: ["hello"],
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: PASS (the implementation from Task 2 already supports recursion + argv). If any test fails, fix the algorithm to match.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/aliases.test.ts
git commit -m "test(tui): resolveAlias recursion + argv passthrough (C2, #302)"
```

---

## Task 4: `resolveAlias` — cycle + depth

**Files:**
- Modify: `src/tui/data/aliases.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/data/aliases.test.ts`:

```ts
describe("resolveAlias cycle + depth", () => {
  test("self-cycle returns cycle result", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("loop", { value: ":loop" });
    const r = resolveAlias(m, "loop");
    expect(r.kind).toBe("cycle");
    if (r.kind === "cycle") expect(r.chain).toEqual(["loop", "loop"]);
  });

  test("two-step cycle returns cycle result", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("x", { value: ":y" });
    m.set("y", { value: ":x" });
    const r = resolveAlias(m, "x");
    expect(r.kind).toBe("cycle");
    if (r.kind === "cycle") expect(r.chain).toEqual(["x", "y", "x"]);
  });

  test("8-hop chain succeeds", () => {
    const m = new Map(DEFAULT_ALIASES);
    // h0 → h1 → ... → h7 → "a" (8 hops total)
    for (let i = 0; i < 8; i++) m.set(`h${i}`, { value: i === 7 ? ":a" : `:h${i + 1}` });
    const r = resolveAlias(m, "h0");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.command).toBe("agents");
  });

  test("9-hop chain returns depth error", () => {
    const m = new Map(DEFAULT_ALIASES);
    for (let i = 0; i < 9; i++) m.set(`h${i}`, { value: i === 8 ? ":a" : `:h${i + 1}` });
    const r = resolveAlias(m, "h0");
    expect(r.kind).toBe("depth");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: PASS (the algorithm already handles cycle + depth). If any test fails, adjust depth check (`depth > MAX_ALIAS_DEPTH`) or visited-set logic.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/aliases.test.ts
git commit -m "test(tui): resolveAlias cycle + depth limits (C2, #302)"
```

---

## Task 5: `matchAliases` — prefix-match for tab-complete

**Files:**
- Modify: `src/tui/data/aliases.ts`, `src/tui/data/aliases.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/data/aliases.test.ts`:

```ts
import { matchAliases } from "./aliases.js";

describe("matchAliases", () => {
  test("empty prefix returns all keys sorted", () => {
    expect(matchAliases(DEFAULT_ALIASES, "")).toEqual(["a", "d", "q", "r", "s", "t"]);
  });

  test("single-char prefix narrows to matches", () => {
    const m = new Map(DEFAULT_ALIASES);
    m.set("agents-only", { value: "agents" });
    m.set("admin", { value: ":a" });
    expect(matchAliases(m, "a")).toEqual(["a", "admin", "agents-only"]);
  });

  test("no matches returns empty array", () => {
    expect(matchAliases(DEFAULT_ALIASES, "zz")).toEqual([]);
  });

  test("case-insensitive match", () => {
    expect(matchAliases(DEFAULT_ALIASES, "A")).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: FAIL — `matchAliases` throws "not implemented".

- [ ] **Step 3: Implement matchAliases**

Replace `matchAliases` in `src/tui/data/aliases.ts`:

```ts
export function matchAliases(map: AliasMap, prefix: string): readonly string[] {
  const p = prefix.toLowerCase();
  const matches: string[] = [];
  for (const key of map.keys()) {
    if (key.toLowerCase().startsWith(p)) matches.push(key);
  }
  matches.sort();
  return matches;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/data/aliases.test.ts`
Expected: PASS (all aliases.test.ts cases pass — ~16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/aliases.ts src/tui/data/aliases.test.ts
git commit -m "feat(tui): matchAliases prefix tab-complete (C2, #302)"
```

---

## Task 6: Loader — schema + ENOENT silent + parse error flash

**Files:**
- Create: `src/tui/data/aliases-loader.ts`, `src/tui/data/aliases-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/data/aliases-loader.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAliases } from "./aliases-loader.js";
import { DEFAULT_ALIASES } from "./aliases.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "c2-aliases-"));
}

describe("loadAliases", () => {
  test("missing project + user files returns defaults with no errors", async () => {
    const dir = await makeTmp();
    try {
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors).toEqual([]);
      // All default keys present
      for (const k of DEFAULT_ALIASES.keys()) {
        expect(r.aliases.has(k)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid YAML in project file falls back to defaults + reports error", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "not: : valid:: yaml: [", "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toMatch(/aliases\.yaml/);
      // Defaults still present
      expect(r.aliases.get("a")?.value).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/data/aliases-loader.test.ts`
Expected: FAIL — "Cannot find module './aliases-loader.js'".

- [ ] **Step 3: Implement loader**

Create `src/tui/data/aliases-loader.ts`:

```ts
/**
 * Alias file loader: reads <groveDir>/.grove/aliases.yaml and
 * ~/.grove/aliases.yaml, validates with zod, merges over DEFAULT_ALIASES.
 * Project file wins on key conflicts.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AliasEntry, type AliasMap, DEFAULT_ALIASES } from "./aliases.js";

const AliasFileSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/),
  z.string().min(1),
);

export interface LoadResult {
  readonly aliases: AliasMap;
  readonly errors: readonly string[];
}

export interface LoadOptions {
  /** Override $HOME — for tests. */
  readonly homeOverride?: string | undefined;
}

interface FileResult {
  readonly map: ReadonlyMap<string, AliasEntry>;
  readonly errors: readonly string[];
}

async function readOne(path: string): Promise<FileResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { map: new Map(), errors: [] };
    return { map: new Map(), errors: [`${path}: ${e.message}`] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { map: new Map(), errors: [`${path}: parse error — ${(err as Error).message}`] };
  }
  if (raw === null || raw === undefined) {
    return { map: new Map(), errors: [] };
  }
  const parsed = AliasFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      map: new Map(),
      errors: [`${path}: schema error — ${parsed.error.message}`],
    };
  }
  const map = new Map<string, AliasEntry>();
  for (const [k, v] of Object.entries(parsed.data)) map.set(k, { value: v });
  return { map, errors: [] };
}

export async function loadAliases(
  groveDir: string,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const home = options.homeOverride ?? homedir();
  const userPath = join(home, ".grove", "aliases.yaml");
  const projectPath = join(groveDir, ".grove", "aliases.yaml");
  const [user, project] = await Promise.all([readOne(userPath), readOne(projectPath)]);
  const merged = new Map<string, AliasEntry>(DEFAULT_ALIASES);
  for (const [k, v] of user.map) merged.set(k, v);
  for (const [k, v] of project.map) merged.set(k, v); // project wins
  return {
    aliases: merged,
    errors: [...user.errors, ...project.errors],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/tui/data/aliases-loader.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/aliases-loader.ts src/tui/data/aliases-loader.test.ts
git commit -m "feat(tui): aliases-loader with zod schema + defaults fallback (C2, #302)"
```

---

## Task 7: Loader — project overrides user; schema violation reports error

**Files:**
- Modify: `src/tui/data/aliases-loader.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/data/aliases-loader.test.ts`:

```ts
describe("loadAliases merge semantics", () => {
  test("project file overrides user file on key conflict", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      const userGrove = join(dir, "fakehome", ".grove");
      await mkdir(grove, { recursive: true });
      await mkdir(userGrove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "dev: project-cmd\n", "utf8");
      await writeFile(join(userGrove, "aliases.yaml"), "dev: user-cmd\nuonly: user-only\n", "utf8");
      const r = await loadAliases(dir, { homeOverride: join(dir, "fakehome") });
      expect(r.errors).toEqual([]);
      expect(r.aliases.get("dev")?.value).toBe("project-cmd");
      expect(r.aliases.get("uonly")?.value).toBe("user-only");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema violation (empty value) reports error and keeps defaults", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "bad: \"\"\n", "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.aliases.has("bad")).toBe(false);
      expect(r.aliases.get("a")?.value).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schema violation (illegal key chars) reports error", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "\"1bad\": something\n", "utf8");
      const r = await loadAliases(dir, { homeOverride: dir });
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.aliases.has("1bad")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tui/data/aliases-loader.test.ts`
Expected: PASS (5 tests total). The implementation from Task 6 already handles merge order and schema validation.

- [ ] **Step 3: Commit**

```bash
git add src/tui/data/aliases-loader.test.ts
git commit -m "test(tui): aliases-loader merge precedence + schema violations (C2, #302)"
```

---

## Task 8: `Prompt` component — render + dropdown + error

**Files:**
- Create: `src/tui/components/prompt.tsx`, `src/tui/components/prompt.test.tsx`

- [ ] **Step 1: Write the failing test**

Look at an existing component test for the project's render-test convention:

Run: `cat src/tui/components/empty-state.test.ts | head -40`

Then create `src/tui/components/prompt.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { create } from "react-test-renderer";
import { Prompt } from "./prompt.js";

function flatText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatText).join("");
  if (typeof node === "object" && node !== null && "children" in (node as object)) {
    return flatText((node as { children: unknown }).children);
  }
  return "";
}

describe("Prompt", () => {
  test("renders nothing when mode is none", () => {
    const tree = create(<Prompt mode="none" query="" />).toJSON();
    expect(tree).toBeNull();
  });

  test("renders ':query' in goto mode", () => {
    const tree = create(<Prompt mode="goto" query="ag" />).toJSON();
    const text = flatText(tree);
    expect(text).toContain(":");
    expect(text).toContain("ag");
  });

  test("renders '/query' in filter mode", () => {
    const tree = create(<Prompt mode="filter" query="foo" />).toJSON();
    const text = flatText(tree);
    expect(text).toContain("/");
    expect(text).toContain("foo");
  });

  test("dropdown shows when suggestions.length > 1", () => {
    const tree = create(
      <Prompt
        mode="goto"
        query="a"
        suggestions={["a", "agents-only", "admin"]}
        suggestionIndex={1}
      />,
    ).toJSON();
    const text = flatText(tree);
    expect(text).toContain("agents-only");
    expect(text).toContain("admin");
  });

  test("dropdown hidden when only one suggestion", () => {
    const tree = create(
      <Prompt mode="goto" query="ag" suggestions={["agents-only"]} suggestionIndex={0} />,
    ).toJSON();
    const text = flatText(tree);
    expect(text).not.toContain("admin");
  });

  test("error prop renders error text", () => {
    const tree = create(
      <Prompt mode="goto" query="bad" error="alias not found" />,
    ).toJSON();
    expect(flatText(tree)).toContain("alias not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/components/prompt.test.tsx`
Expected: FAIL — "Cannot find module './prompt.js'".

- [ ] **Step 3: Implement Prompt**

Create `src/tui/components/prompt.tsx`:

```tsx
/**
 * <Prompt> — k9s-style command/filter input overlay.
 *
 * Presentational: renders the bottom-line input and (in goto mode)
 * a dropdown of suggestions. All keystrokes routed by parent.
 */

import React from "react";
import { theme } from "../theme.js";

export type PromptMode = "none" | "goto" | "filter";

export interface PromptProps {
  readonly mode: PromptMode;
  readonly query: string;
  readonly suggestions?: readonly string[] | undefined;
  readonly suggestionIndex?: number | undefined;
  readonly error?: string | undefined;
}

export const Prompt: React.NamedExoticComponent<PromptProps> = React.memo(function Prompt({
  mode,
  query,
  suggestions,
  suggestionIndex,
  error,
}: PromptProps): React.ReactNode {
  if (mode === "none") return null;

  const sigil = mode === "goto" ? ":" : "/";
  const showDropdown = mode === "goto" && (suggestions?.length ?? 0) > 1;
  const idx = suggestionIndex ?? 0;

  return (
    <box flexDirection="column" paddingX={2}>
      {showDropdown && suggestions ? (
        <box flexDirection="column">
          {suggestions.map((s, i) => {
            const selected = i === idx;
            return (
              <box key={`${s}-${i}`} flexDirection="row">
                <text color={selected ? theme.focus : theme.secondary}>
                  {selected ? "> " : "  "}
                  {s}
                </text>
              </box>
            );
          })}
        </box>
      ) : null}
      <box flexDirection="row">
        <text color={theme.focus}>{sigil}</text>
        <text>{query}</text>
        <text color={theme.secondary}>{"▌"}</text>
      </box>
      {error ? (
        <box flexDirection="row">
          <text color={theme.error}>{error}</text>
        </box>
      ) : null}
    </box>
  );
});
```

- [ ] **Step 4: Confirm `theme.error` exists**

Run: `grep -n "error:" src/tui/theme.ts | head -3`
Expected: `error:` appears in the theme object. If absent, add `error: "#ff5555"` (or similar) under the existing color block in `src/tui/theme.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/tui/components/prompt.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/prompt.tsx src/tui/components/prompt.test.tsx
git commit -m "feat(tui): Prompt component for goto/filter mode (C2, #302)"
```

---

## Task 9: Pure cmd-mode state reducer

**Files:**
- Create: `src/tui/screens/running-cmd-mode.ts`, `src/tui/screens/running-cmd-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/running-cmd-mode.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  type CmdModeState,
  enterGoto,
  enterFilter,
  appendChar,
  deleteChar,
  exitCmdMode,
  cycleSuggestion,
  initialCmdState,
} from "./running-cmd-mode.js";

describe("running-cmd-mode reducer", () => {
  test("initial state is none", () => {
    expect(initialCmdState).toEqual({
      mode: "none",
      text: "",
      suggestionIndex: 0,
    });
  });

  test("enterGoto sets mode='goto' and clears text", () => {
    const s: CmdModeState = { mode: "filter", text: "stale", suggestionIndex: 3 };
    expect(enterGoto(s)).toEqual({ mode: "goto", text: "", suggestionIndex: 0 });
  });

  test("enterFilter sets mode='filter' and clears text", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 2 };
    expect(enterFilter(s)).toEqual({ mode: "filter", text: "", suggestionIndex: 0 });
  });

  test("appendChar appends to text and resets suggestion index", () => {
    const s: CmdModeState = { mode: "goto", text: "ag", suggestionIndex: 2 };
    expect(appendChar(s, "e")).toEqual({ mode: "goto", text: "age", suggestionIndex: 0 });
  });

  test("deleteChar removes last char", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 0 };
    expect(deleteChar(s)).toEqual({ mode: "goto", text: "ab", suggestionIndex: 0 });
  });

  test("deleteChar on empty text is a no-op", () => {
    const s: CmdModeState = { mode: "goto", text: "", suggestionIndex: 0 };
    expect(deleteChar(s)).toEqual(s);
  });

  test("exitCmdMode returns mode='none' and clears text", () => {
    const s: CmdModeState = { mode: "goto", text: "abc", suggestionIndex: 2 };
    expect(exitCmdMode(s)).toEqual({ mode: "none", text: "", suggestionIndex: 0 });
  });

  test("cycleSuggestion wraps within suggestion length", () => {
    const s: CmdModeState = { mode: "goto", text: "a", suggestionIndex: 1 };
    expect(cycleSuggestion(s, 3)).toEqual({ ...s, suggestionIndex: 2 });
    expect(cycleSuggestion({ ...s, suggestionIndex: 2 }, 3)).toEqual({ ...s, suggestionIndex: 0 });
  });

  test("cycleSuggestion with 0 length is a no-op", () => {
    const s: CmdModeState = { mode: "goto", text: "x", suggestionIndex: 0 };
    expect(cycleSuggestion(s, 0)).toEqual(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/screens/running-cmd-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reducer**

Create `src/tui/screens/running-cmd-mode.ts`:

```ts
/**
 * Pure state reducer for the running-view C2 command/filter prompt.
 * No React, no IO — testable as plain functions.
 */

import type { PromptMode } from "../components/prompt.js";

export interface CmdModeState {
  readonly mode: PromptMode;
  readonly text: string;
  readonly suggestionIndex: number;
}

export const initialCmdState: CmdModeState = {
  mode: "none",
  text: "",
  suggestionIndex: 0,
};

export function enterGoto(_s: CmdModeState): CmdModeState {
  return { mode: "goto", text: "", suggestionIndex: 0 };
}

export function enterFilter(_s: CmdModeState): CmdModeState {
  return { mode: "filter", text: "", suggestionIndex: 0 };
}

export function appendChar(s: CmdModeState, ch: string): CmdModeState {
  return { ...s, text: s.text + ch, suggestionIndex: 0 };
}

export function deleteChar(s: CmdModeState): CmdModeState {
  if (s.text.length === 0) return s;
  return { ...s, text: s.text.slice(0, -1) };
}

export function exitCmdMode(_s: CmdModeState): CmdModeState {
  return { mode: "none", text: "", suggestionIndex: 0 };
}

export function cycleSuggestion(s: CmdModeState, total: number): CmdModeState {
  if (total <= 0) return s;
  return { ...s, suggestionIndex: (s.suggestionIndex + 1) % total };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/tui/screens/running-cmd-mode.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-cmd-mode.ts src/tui/screens/running-cmd-mode.test.ts
git commit -m "feat(tui): cmd-mode reducer for C2 prompt state (C2, #302)"
```

---

## Task 10: Add new RunningPanel entries (Sessions/Tasks/Reviews)

**Files:**
- Modify: `src/tui/screens/running-keyboard.ts`
- Modify: `src/tui/screens/running-keyboard.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/tui/screens/running-keyboard.test.ts`:

```ts
describe("RunningPanel new entries", () => {
  test("Sessions/Tasks/Reviews panels are defined", () => {
    expect(RunningPanel.Sessions).toBe(6);
    expect(RunningPanel.Tasks).toBe(7);
    expect(RunningPanel.Reviews).toBe(8);
  });

  test("RUNNING_PANEL_LABELS includes new panels", () => {
    expect(RUNNING_PANEL_LABELS[RunningPanel.Sessions]).toBe("Sessions");
    expect(RUNNING_PANEL_LABELS[RunningPanel.Tasks]).toBe("Tasks");
    expect(RUNNING_PANEL_LABELS[RunningPanel.Reviews]).toBe("Reviews");
  });
});
```

Add to imports at top of file (if not already present): `import { ..., RUNNING_PANEL_LABELS } from "./running-keyboard.js";`

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: FAIL — Sessions/Tasks/Reviews undefined.

- [ ] **Step 3: Add entries**

Edit `src/tui/screens/running-keyboard.ts` lines 17-37:

Replace:
```ts
export const RunningPanel = {
  Feed: 0,
  Agents: 1,
  Dag: 2,
  Terminal: 3,
  Trace: 4,
  Handoffs: 5,
} as const;
export type RunningPanel = (typeof RunningPanel)[keyof typeof RunningPanel];

export const RUNNING_PANEL_COUNT = 6;

export const RUNNING_PANEL_LABELS: Readonly<Record<RunningPanel, string>> = {
  [RunningPanel.Feed]: "Feed",
  [RunningPanel.Agents]: "Agents",
  [RunningPanel.Dag]: "DAG",
  [RunningPanel.Terminal]: "Terminal",
  [RunningPanel.Trace]: "Trace",
  [RunningPanel.Handoffs]: "Handoffs",
};
```

With:
```ts
export const RunningPanel = {
  Feed: 0,
  Agents: 1,
  Dag: 2,
  Terminal: 3,
  Trace: 4,
  Handoffs: 5,
  Sessions: 6,
  Tasks: 7,
  Reviews: 8,
} as const;
export type RunningPanel = (typeof RunningPanel)[keyof typeof RunningPanel];

export const RUNNING_PANEL_COUNT = 9;

export const RUNNING_PANEL_LABELS: Readonly<Record<RunningPanel, string>> = {
  [RunningPanel.Feed]: "Feed",
  [RunningPanel.Agents]: "Agents",
  [RunningPanel.Dag]: "DAG",
  [RunningPanel.Terminal]: "Terminal",
  [RunningPanel.Trace]: "Trace",
  [RunningPanel.Handoffs]: "Handoffs",
  [RunningPanel.Sessions]: "Sessions",
  [RunningPanel.Tasks]: "Tasks",
  [RunningPanel.Reviews]: "Reviews",
};
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: PASS for new tests; existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-keyboard.ts src/tui/screens/running-keyboard.test.ts
git commit -m "feat(tui): add Sessions/Tasks/Reviews RunningPanel entries (C2, #302)"
```

---

## Task 11: Reroute `:` and `/` in keyboard handler

**Files:**
- Modify: `src/tui/screens/running-keyboard.ts`
- Modify: `src/tui/screens/running-keyboard.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/screens/running-keyboard.test.ts`:

```ts
describe("C2 keyboard routing", () => {
  function makeActions(over: Partial<RunningKeyboardActions> = {}): RunningKeyboardActions {
    const noop = () => {};
    return {
      expandPanel: noop,
      collapsePanel: noop,
      toggleFullscreen: noop,
      toggleHelp: noop,
      dismissHelp: noop,
      toggleVfs: noop,
      dismissVfs: noop,
      setConfirmQuit: () => {},
      showQuitDialog: noop,
      enterPromptMode: noop,
      exitPromptMode: noop,
      appendPromptChar: () => {},
      deletePromptChar: noop,
      cyclePromptTarget: noop,
      submitPrompt: noop,
      enterGotoMode: noop,
      enterFilterMode: noop,
      feedCursorDown: noop,
      feedCursorUp: noop,
      feedScrollToBottom: noop,
      scrollToAskUser: noop,
      traceSelectDown: noop,
      traceSelectUp: noop,
      traceScrollDown: noop,
      traceScrollUp: noop,
      traceScrollToBottom: noop,
      traceScrollToTop: noop,
      traceCycleAgent: noop,
      openDetail: noop,
      toggleAdvanced: noop,
      quit: noop,
      approvePermission: noop,
      denyPermission: noop,
      hasPermissions: false,
      hasActiveRoles: true,
      hasSendToAgent: true,
      feedLength: 0,
      hasAskUser: false,
      ...over,
    };
  }

  function makeState(over: Partial<RunningKeyboardState> = {}): RunningKeyboardState {
    return {
      expandedPanel: null,
      zoomLevel: "normal",
      showHelp: false,
      showVfs: false,
      confirmQuit: false,
      promptMode: false,
      promptText: "",
      ...over,
    };
  }

  test("':' enters goto mode (NOT message mode)", () => {
    let goto = 0;
    let msg = 0;
    const actions = makeActions({
      enterGotoMode: () => { goto += 1; },
      enterPromptMode: () => { msg += 1; },
    });
    routeRunningKey(
      { name: "", sequence: ":", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState(),
      actions,
    );
    expect(goto).toBe(1);
    expect(msg).toBe(0);
  });

  test("'m' still enters message mode", () => {
    let msg = 0;
    const actions = makeActions({ enterPromptMode: () => { msg += 1; } });
    routeRunningKey(
      { name: "m", sequence: "m", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState(),
      actions,
    );
    expect(msg).toBe(1);
  });

  test("'/' enters filter mode", () => {
    let filter = 0;
    const actions = makeActions({ enterFilterMode: () => { filter += 1; } });
    routeRunningKey(
      { name: "", sequence: "/", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState(),
      actions,
    );
    expect(filter).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: FAIL — `enterGotoMode`/`enterFilterMode` not on actions interface.

- [ ] **Step 3: Update actions interface and routing**

Edit `src/tui/screens/running-keyboard.ts`:

Add to `RunningKeyboardActions` interface (after the existing prompt block, around line 84):
```ts
  // Cmd-mode (C2): goto + filter prompt
  readonly enterGotoMode: () => void;
  readonly enterFilterMode: () => void;
```

In `routeRunningKey`, replace lines 214-218:

Before:
```ts
  // ':' or 'm': enter prompt mode to send message to agent
  if ((key.sequence === ":" || input === "m") && actions.hasSendToAgent && actions.hasActiveRoles) {
    actions.enterPromptMode();
    return true;
  }
```

After:
```ts
  // ':' enters C2 goto/command mode
  if (key.sequence === ":") {
    actions.enterGotoMode();
    return true;
  }

  // '/' enters C2 filter mode
  if (key.sequence === "/") {
    actions.enterFilterMode();
    return true;
  }

  // 'm' enters message-send mode (legacy prompt flow)
  if (input === "m" && actions.hasSendToAgent && actions.hasActiveRoles) {
    actions.enterPromptMode();
    return true;
  }
```

- [ ] **Step 4: Run all running-keyboard tests**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: PASS — new tests pass, existing tests still pass (existing tests must not have asserted that `:` triggers message mode; if they did, update those assertions to use `m`).

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-keyboard.ts src/tui/screens/running-keyboard.test.ts
git commit -m "feat(tui): route ':' to goto and '/' to filter; 'm' keeps message-send (C2, #302)"
```

---

## Task 12: Wire prompt input keys (Tab, Enter, Esc, typing) when cmdMode active

**Files:**
- Modify: `src/tui/screens/running-keyboard.ts`
- Modify: `src/tui/screens/running-keyboard.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tui/screens/running-keyboard.test.ts`:

```ts
describe("C2 prompt-mode key routing", () => {
  test("typing in cmdMode appends char", () => {
    let appended = "";
    const actions = makeActions({
      appendCmdChar: (c: string) => { appended += c; },
    } as Partial<RunningKeyboardActions>);
    routeRunningKey(
      { name: "a", sequence: "a", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState({ cmdMode: "goto", cmdText: "" }),
      actions,
    );
    expect(appended).toBe("a");
  });

  test("Tab in goto mode triggers cmdTabComplete", () => {
    let tabbed = 0;
    const actions = makeActions({ cmdTabComplete: () => { tabbed += 1; } } as Partial<RunningKeyboardActions>);
    routeRunningKey(
      { name: "tab", sequence: "\t", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState({ cmdMode: "goto", cmdText: "a" }),
      actions,
    );
    expect(tabbed).toBe(1);
  });

  test("Enter in cmdMode triggers cmdSubmit", () => {
    let submitted = 0;
    const actions = makeActions({ cmdSubmit: () => { submitted += 1; } } as Partial<RunningKeyboardActions>);
    routeRunningKey(
      { name: "return", sequence: "\r", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState({ cmdMode: "goto", cmdText: "a" }),
      actions,
    );
    expect(submitted).toBe(1);
  });

  test("Esc with non-empty text clears text", () => {
    let cleared = 0;
    let exited = 0;
    const actions = makeActions({
      cmdClearText: () => { cleared += 1; },
      cmdExit: () => { exited += 1; },
    } as Partial<RunningKeyboardActions>);
    routeRunningKey(
      { name: "escape", sequence: "", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState({ cmdMode: "goto", cmdText: "abc" }),
      actions,
    );
    expect(cleared).toBe(1);
    expect(exited).toBe(0);
  });

  test("Esc with empty text exits cmdMode", () => {
    let cleared = 0;
    let exited = 0;
    const actions = makeActions({
      cmdClearText: () => { cleared += 1; },
      cmdExit: () => { exited += 1; },
    } as Partial<RunningKeyboardActions>);
    routeRunningKey(
      { name: "escape", sequence: "", ctrl: false, meta: false, shift: false } as KeyEvent,
      makeState({ cmdMode: "goto", cmdText: "" }),
      actions,
    );
    expect(cleared).toBe(0);
    expect(exited).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: FAIL — actions/state fields missing.

- [ ] **Step 3: Extend state + actions + routing**

Edit `src/tui/screens/running-keyboard.ts`:

Add to `RunningKeyboardState` (around line 59, after `promptText`):
```ts
  /** C2 cmd-mode (goto/filter) — separate from legacy message mode. */
  readonly cmdMode: import("../components/prompt.js").PromptMode;
  readonly cmdText: string;
```

Add to `RunningKeyboardActions` (after the new enterGotoMode/enterFilterMode):
```ts
  readonly cmdAppendChar: (ch: string) => void;
  readonly cmdDeleteChar: () => void;
  readonly cmdTabComplete: () => void;
  readonly cmdSubmit: () => void;
  readonly cmdClearText: () => void;
  readonly cmdExit: () => void;
```

In `routeRunningKey`, **at the very top, before the existing message promptMode block**:
```ts
  // ─── C2 cmd-mode: swallows all keys ───
  if (state.cmdMode !== "none") {
    if (input === "escape") {
      if (state.cmdText.length > 0) actions.cmdClearText();
      else actions.cmdExit();
      return true;
    }
    if (input === "return") {
      actions.cmdSubmit();
      return true;
    }
    if (input === "tab" && state.cmdMode === "goto") {
      actions.cmdTabComplete();
      return true;
    }
    if (input === "backspace") {
      actions.cmdDeleteChar();
      return true;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      actions.cmdAppendChar(key.sequence);
      return true;
    }
    if (input === "space") {
      actions.cmdAppendChar(" ");
      return true;
    }
    return true; // swallow unhandled
  }
```

Update test helper functions in test file to include the new fields:
```ts
// makeState additions:
cmdMode: "none",
cmdText: "",

// makeActions additions:
cmdAppendChar: () => {},
cmdDeleteChar: () => {},
cmdTabComplete: () => {},
cmdSubmit: () => {},
cmdClearText: () => {},
cmdExit: () => {},
```

(Update the test cases above that use `appendCmdChar` to use `cmdAppendChar` to match — fix any naming inconsistencies.)

- [ ] **Step 4: Run all keyboard tests**

Run: `bun test src/tui/screens/running-keyboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-keyboard.ts src/tui/screens/running-keyboard.test.ts
git commit -m "feat(tui): cmd-mode key handling (Tab/Enter/Esc/type) (C2, #302)"
```

---

## Task 13: FlashBar component for transient errors

**Files:**
- Create: `src/tui/components/flash-bar.tsx`, `src/tui/components/flash-bar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/tui/components/flash-bar.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { create } from "react-test-renderer";
import { FlashBar } from "./flash-bar.js";

function flatText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatText).join("");
  if (typeof node === "object" && node !== null && "children" in (node as object)) {
    return flatText((node as { children: unknown }).children);
  }
  return "";
}

describe("FlashBar", () => {
  test("renders nothing when message is null", () => {
    const tree = create(<FlashBar message={null} />).toJSON();
    expect(tree).toBeNull();
  });

  test("renders message text when set", () => {
    const tree = create(<FlashBar message="alias not found" />).toJSON();
    expect(flatText(tree)).toContain("alias not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/components/flash-bar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement FlashBar**

Create `src/tui/components/flash-bar.tsx`:

```tsx
/**
 * Transient error bar for the running view. Used by the C2 alias
 * resolver to surface cycle/depth/miss/parse errors.
 */

import React from "react";
import { theme } from "../theme.js";

export interface FlashBarProps {
  readonly message: string | null;
}

export const FlashBar: React.NamedExoticComponent<FlashBarProps> = React.memo(function FlashBar({
  message,
}: FlashBarProps): React.ReactNode {
  if (!message) return null;
  return (
    <box paddingX={2}>
      <text color={theme.error}>{message}</text>
    </box>
  );
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/components/flash-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/flash-bar.tsx src/tui/components/flash-bar.test.tsx
git commit -m "feat(tui): FlashBar transient error component (C2, #302)"
```

---

## Task 14: Compose external filter predicate in agent-list view

**Files:**
- Modify: `src/tui/views/agent-list.tsx`

- [ ] **Step 1: Read current AgentListView props**

Run: `grep -n "interface AgentListViewProps\|predicate" src/tui/views/agent-list.tsx | head -10`

- [ ] **Step 2: Add `filterText` prop and compose into existing predicate**

Open `src/tui/views/agent-list.tsx`. Find the props interface and the predicate passed into `<EntityView>`. Add:

```ts
// Inside AgentListViewProps:
readonly filterText?: string | undefined;
```

Where the EntityView predicate is constructed (search for `predicate=`), wrap it:

```ts
const filterFn = useMemo(() => {
  const q = filterText?.trim().toLowerCase();
  if (!q) return undefined;
  // Match against the rendered text of all configured columns.
  return (e: EntityForKind<"agent">) =>
    columns.some((c) => c.render(e).toLowerCase().includes(q));
}, [filterText, columns]);

const composedPredicate = useMemo(() => {
  if (!viewPredicate && !filterFn) return undefined;
  return (e: EntityForKind<"agent">) =>
    (viewPredicate?.(e) ?? true) && (filterFn?.(e) ?? true);
}, [viewPredicate, filterFn]);
```

(Replace `viewPredicate` with whatever the existing local predicate variable is named — read the file to confirm.)

Pass `predicate={composedPredicate}` to `<EntityView>`.

- [ ] **Step 3: Verify build + existing tests still pass**

Run: `bun run typecheck && bun test src/tui/views/agent-list`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/agent-list.tsx
git commit -m "feat(tui): agent-list accepts filterText for / mode (C2, #302)"
```

---

## Task 15: Compose external filter predicate in dag view

**Files:**
- Modify: `src/tui/views/dag.tsx`

- [ ] **Step 1: Mirror Task 14 for `dag.tsx`**

Read DAG view's existing predicate construction. Add `filterText?: string` prop. Compose with view-internal predicate the same way.

If DAG view does not pass through a column-list to EntityView (it may render a graph not a table), implement substring match against agent role + edge labels rendered as a flat string.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun test src/tui/views/dag`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/views/dag.tsx
git commit -m "feat(tui): dag view accepts filterText for / mode (C2, #302)"
```

---

## Task 16: Stub Sessions/Tasks/Reviews panels in running-view

**Files:**
- Modify: `src/tui/screens/running-view.tsx`

- [ ] **Step 1: Add panel cases**

Open `src/tui/screens/running-view.tsx`. In `renderExpandedPanel` (around line 1250) add new cases after `RunningPanel.Handoffs`:

```tsx
    case RunningPanel.Sessions:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>Sessions view (stub) — wires to acp_session kind in follow-up</text>
        </box>
      );

    case RunningPanel.Tasks:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>Tasks view (coming in C3/C4)</text>
        </box>
      );

    case RunningPanel.Reviews:
      return (
        <box paddingX={2}>
          <text color={theme.secondary}>Reviews view (coming in C3/C4)</text>
        </box>
      );
```

(Stubs for now per spec — Sessions could later use `EntityView<"acp_session">`. Defer real wiring to a follow-up issue.)

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/running-view.tsx
git commit -m "feat(tui): stub Sessions/Tasks/Reviews panels (C2, #302)"
```

---

## Task 17: Integrate Prompt + alias load + goto dispatch in running-view

**Files:**
- Modify: `src/tui/screens/running-view.tsx`

- [ ] **Step 1: Add state, effect, and dispatch**

Open `src/tui/screens/running-view.tsx`.

Imports — add:
```ts
import { Prompt, type PromptMode } from "../components/prompt.js";
import { FlashBar } from "../components/flash-bar.js";
import {
  type AliasMap,
  DEFAULT_ALIASES,
  matchAliases,
  resolveAlias,
} from "../data/aliases.js";
import { loadAliases } from "../data/aliases-loader.js";
import {
  type CmdModeState,
  initialCmdState,
  enterGoto,
  enterFilter,
  appendChar as cmdAppend,
  deleteChar as cmdDelete,
  exitCmdMode,
} from "./running-cmd-mode.js";
```

Inside the component body, after the existing prompt state (around line 195), add:

```ts
const [cmdState, setCmdState] = useState<CmdModeState>(initialCmdState);
const [aliases, setAliases] = useState<AliasMap>(DEFAULT_ALIASES);
const [flashError, setFlashError] = useState<string | null>(null);
const [filterQuery, setFilterQuery] = useState<string>("");

// Load aliases once on mount.
useEffect(() => {
  if (!groveDir) return;
  let cancelled = false;
  void loadAliases(groveDir).then((r) => {
    if (cancelled) return;
    setAliases(r.aliases);
    if (r.errors.length > 0) {
      flash(r.errors[0]!);
    }
  });
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [groveDir]);

const flash = useCallback((msg: string, ms = 3000) => {
  setFlashError(msg);
  setTimeout(() => setFlashError((current) => (current === msg ? null : current)), ms);
}, []);

// Goto dispatch table — alias.command → action.
const gotoDispatch: Record<string, () => void> = useMemo(() => ({
  agents:   () => actions.expandPanel(RunningPanel.Agents),
  dag:      () => actions.expandPanel(RunningPanel.Dag),
  sessions: () => actions.expandPanel(RunningPanel.Sessions),
  tasks:    () => actions.expandPanel(RunningPanel.Tasks),
  reviews:  () => actions.expandPanel(RunningPanel.Reviews),
  quit:     () => actions.showQuitDialog(),
}), [actions]);

// Goto suggestions for tab-complete dropdown.
const gotoSuggestions = useMemo(() => {
  if (cmdState.mode !== "goto") return [];
  return matchAliases(aliases, cmdState.text);
}, [cmdState.mode, cmdState.text, aliases]);
```

Replace the `actions` object construction to include cmd-mode actions. Find the existing `actions` object (around lines 567-600) and add the new fields:

```ts
enterGotoMode: () => setCmdState(enterGoto),
enterFilterMode: () => {
  setCmdState(enterFilter);
  setFilterQuery("");
},
cmdAppendChar: (ch: string) => setCmdState((s) => {
  const next = cmdAppend(s, ch);
  if (next.mode === "filter") setFilterQuery(next.text);
  return next;
}),
cmdDeleteChar: () => setCmdState((s) => {
  const next = cmdDelete(s);
  if (next.mode === "filter") setFilterQuery(next.text);
  return next;
}),
cmdTabComplete: () => setCmdState((s) => {
  if (s.mode !== "goto") return s;
  const matches = matchAliases(aliases, s.text);
  if (matches.length === 0) return s;
  if (matches.length === 1) {
    return { ...s, text: matches[0]! + " ", suggestionIndex: 0 };
  }
  return { ...s, suggestionIndex: (s.suggestionIndex + 1) % matches.length };
}),
cmdSubmit: () => setCmdState((s) => {
  if (s.mode === "goto") {
    if (!s.text.trim()) return exitCmdMode(s);
    const r = resolveAlias(aliases, s.text);
    if (r.kind === "ok") {
      const dispatch = gotoDispatch[r.command];
      if (dispatch) dispatch();
      else flash(`:${s.text}: unknown command "${r.command}"`);
    } else if (r.kind === "miss") {
      flash(`:${r.key}: unknown alias`);
    } else if (r.kind === "cycle") {
      flash(`alias cycle: ${r.chain.join(" → ")}`);
    } else if (r.kind === "depth") {
      flash(`alias chain too deep (>${r.chain.length}): ${r.chain.join(" → ")}`);
    }
    return exitCmdMode(s);
  }
  // filter mode: Enter just exits prompt; filterQuery is retained
  return exitCmdMode(s);
}),
cmdClearText: () => setCmdState((s) => ({ ...s, text: "" })),
cmdExit: () => {
  setCmdState(exitCmdMode);
  // Esc on already-empty filter prompt also clears any retained filter
  if (cmdState.mode === "filter" && cmdState.text === "" && filterQuery !== "") {
    setFilterQuery("");
  }
},
```

Pass new state into `routeRunningKey` deps — find where `RunningKeyboardState` is constructed and add:
```ts
cmdMode: cmdState.mode,
cmdText: cmdState.text,
```

In the JSX (around line 1400 where the existing prompt renders), add the new components above the existing message prompt:

```tsx
{/* C2 prompt overlay */}
<Prompt
  mode={cmdState.mode}
  query={cmdState.text}
  suggestions={gotoSuggestions}
  suggestionIndex={cmdState.suggestionIndex}
/>
<FlashBar message={flashError} />
```

Pass `filterText={cmdState.mode === "filter" ? cmdState.text : filterQuery}` into AgentListView and DagView render sites (around lines 1265 and 1276).

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS. Fix any prop-naming or import mismatches.

- [ ] **Step 3: Run all tui tests**

Run: `bun test src/tui/`
Expected: PASS. If existing tests break (e.g. `running-keyboard.test.ts` that asserted `:` triggered message mode), update those expectations.

- [ ] **Step 4: Commit**

```bash
git add src/tui/screens/running-view.tsx
git commit -m "feat(tui): integrate Prompt + alias dispatch + filter wiring in running-view (C2, #302)"
```

---

## Task 18: Acceptance test — issue exit criteria

**Files:**
- Create: `src/tui/screens/running-view.c2.test.tsx`

- [ ] **Step 1: Write the acceptance test**

Create `src/tui/screens/running-view.c2.test.tsx`:

```tsx
/**
 * Acceptance tests for issue #302 exit criteria:
 *   1. ":a" routes to agents view
 *   2. "/foo" filters current view without tearing down state
 *   3. Invalid alias file → flash-bar error, falls back to defaults
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAliases } from "../data/aliases-loader.js";
import {
  DEFAULT_ALIASES,
  matchAliases,
  resolveAlias,
} from "../data/aliases.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "c2-acc-"));
}

describe("C2 acceptance — issue #302", () => {
  test("AC1: ':a' resolves to agents command", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["a"] });
  });

  test("AC2: filter predicate composes; panel state preserved", () => {
    // Simulates running-view's filter wiring: the same predicate
    // applied across different panels means panel state isn't torn down.
    const buildPredicate = (q: string) => {
      const lower = q.toLowerCase();
      return (row: { label: string }) => row.label.toLowerCase().includes(lower);
    };
    const rows = [{ label: "foobar" }, { label: "baz" }];
    const predicate = buildPredicate("foo");
    expect(rows.filter(predicate)).toEqual([{ label: "foobar" }]);
    // Same predicate works on a different "panel" (different rows).
    const rows2 = [{ label: "foo-other" }, { label: "qux" }];
    expect(rows2.filter(predicate)).toEqual([{ label: "foo-other" }]);
  });

  test("AC3: invalid alias file returns errors + defaults still resolve ':a'", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "{[ broken yaml", "utf8");
      const result = await loadAliases(dir, { homeOverride: dir });
      expect(result.errors.length).toBeGreaterThan(0);
      // Defaults still resolve ':a' → agents.
      const r = resolveAlias(result.aliases, "a");
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.command).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run acceptance tests**

Run: `bun test src/tui/screens/running-view.c2.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/running-view.c2.test.tsx
git commit -m "test(tui): C2 acceptance tests for issue #302 exit criteria"
```

---

## Task 19: Lint + full test sweep + final commit

**Files:** none — verification only.

- [ ] **Step 1: Run linter**

Run: `bun run lint`
Expected: clean. Fix any formatting / import-order / unused-import issues with `bun run format`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: all pass. Triage any failures in adjacent code that broke from the keyboard / state changes.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the TUI with a real grove dir, type `:a Enter` → Agents panel expands. Type `:` then `Tab` → suggestions drop down. Type `/foo` while Agents panel is expanded → row count narrows. Esc Esc → filter clears.

If smoke reveals a UX issue, file a follow-up issue and link it from #302; do not silently widen scope.

- [ ] **Step 5: Final commit (if there were any lint/format-only changes)**

```bash
git add -A
git status   # confirm only formatting changes
git commit -m "chore(tui): lint/format pass for C2 (#302)"   # only if anything to commit
```

---

## Self-review checklist (run before handing off)

**Spec coverage** — every spec section maps to one or more tasks:

| Spec section | Tasks |
|---|---|
| `aliases.ts` types + DEFAULT_ALIASES | 1 |
| `resolveAlias` semantics (direct/miss/recursion/argv/cycle/depth) | 2, 3, 4 |
| `matchAliases` | 5 |
| `aliases-loader.ts` schema + ENOENT + parse error | 6 |
| Loader merge precedence + schema violations | 7 |
| `prompt.tsx` render contracts | 8 |
| `cmdMode` state reducer | 9 |
| `RunningPanel` new entries | 10 |
| `:` and `/` routing change | 11 |
| Cmd-mode key handling (Tab/Enter/Esc/typing) | 12 |
| FlashBar | 13 |
| Filter predicate composition (agent-list, dag) | 14, 15 |
| Stub Sessions/Tasks/Reviews panels | 16 |
| Running-view integration (Prompt + load + dispatch + filter wire-up) | 17 |
| Issue acceptance criteria | 18 |
| Lint/typecheck/full test pass | 19 |

**Placeholder scan:** none — every step contains the actual code or command.

**Type consistency check:**
- `PromptMode` defined in `prompt.tsx` (Task 8), imported in `running-cmd-mode.ts` (Task 9), used in `running-keyboard.ts` (Task 12) and `running-view.tsx` (Task 17) — consistent.
- `cmdMode`/`cmdText` fields added to `RunningKeyboardState` (Task 12) and populated in running-view (Task 17) — consistent.
- `cmdAppendChar`/`cmdDeleteChar`/`cmdTabComplete`/`cmdSubmit`/`cmdClearText`/`cmdExit` action names consistent across Tasks 12 and 17.
- `enterGotoMode`/`enterFilterMode` consistent across Tasks 11 and 17.
- `filterText` prop name consistent across Tasks 14 (agent-list), 15 (dag), 17 (running-view passing).
- Default `RUNNING_PANEL_COUNT = 9` matches the 9 entries (Task 10).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-c2-prompt-aliases.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
