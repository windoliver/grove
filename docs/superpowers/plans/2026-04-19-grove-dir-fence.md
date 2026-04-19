# Grove Dir Fence — Unify findGroveDir Implementations (#315)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans for inline execution.

**Goal:** Eliminate three divergent `findGroveDir` impls by promoting one shared implementation that fences walk-up at the first `.grove/` directory (not grove.json). Fix the TUI's silent-walk-past-worktree bug.

**Architecture:** Single `findGroveDir(startDir): string | undefined` in `src/cli/utils/grove-dir.ts`. Walk-up returns the first ancestor containing `.grove/`. Callers that need `grove.json` check it AFTER and treat "found .grove/ but no grove.json" as "not initialized at this level" — they do NOT silently walk past to find a parent grove.json.

**Tech Stack:** TypeScript, Bun test runner. No new dependencies.

**Issue:** [#315](https://github.com/windoliver/grove/issues/315)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/cli/utils/grove-dir.ts` | modify | Export new shared `findGroveDir(startDir)`; refactor `resolveGroveDir` to use it. |
| `src/cli/utils/grove-dir.test.ts` | modify | Add tests for shared findGroveDir + the "found .grove/ but incomplete, do not walk past" semantics. |
| `src/cli/context.ts` | modify | Delete local `findGroveDir`; import from utils. |
| `src/tui/main.ts` | modify | Delete local `findGroveDir`; build a thin wrapper around the shared one that adds the grove.json existence check WITHOUT walking past. |

---

## Task 1: Promote `findGroveDir` to shared util

- [ ] Edit `src/cli/utils/grove-dir.ts`:
  - Add new export `findGroveDir(startDir: string): string | undefined`
  - Refactor `resolveGroveDir` to use it
  - Behavior: walk up from `resolve(startDir)` returning the first ancestor containing `.grove/` (subdirectory existence). Return undefined if reach FS root with no match.

- [ ] Add tests to `src/cli/utils/grove-dir.test.ts`:
  - `findGroveDir`: returns undefined for tmpdir with no .grove
  - `findGroveDir`: finds .grove in startDir directly
  - `findGroveDir`: walks up to ancestor .grove
  - `findGroveDir`: when both ancestor and child have .grove → returns child (fence semantics)

- [ ] Run: `bun test src/cli/utils/grove-dir.test.ts` — all green

- [ ] Commit:
```
git add src/cli/utils/grove-dir.ts src/cli/utils/grove-dir.test.ts
git commit -m "feat(cli): promote findGroveDir to shared util with fence semantics (#315)"
```

---

## Task 2: Replace cli/context.ts duplicate with import

- [ ] Edit `src/cli/context.ts`:
  - Remove the local `function findGroveDir(startDir)` (lines ~36-60)
  - Remove the unused `existsSync`, `dirname`, `join` imports if they become unused
  - Import the shared one: `import { findGroveDir } from "./utils/grove-dir.js";`
  - Verify `initCliDeps` callsite still compiles unchanged

- [ ] Run: `bun run tsc --noEmit` — clean
- [ ] Run: `bun test src/cli/` — green

- [ ] Commit:
```
git add src/cli/context.ts
git commit -m "refactor(cli): use shared findGroveDir (#315)"
```

---

## Task 3: Fix TUI to fence + require grove.json without walking past

- [ ] Edit `src/tui/main.ts`:
  - Replace local `findGroveDir(groveOverride)` with a thin wrapper
  - New behavior:
    1. If `groveOverride` provided: check `<override>/grove.json` exists → return override or undefined
    2. If `process.env.GROVE_DIR`: same check
    3. Otherwise: call shared `findGroveDir(process.cwd())`. If result undefined → return undefined. Else: check `<result>/grove.json` exists. If yes → return result. **If no → return undefined (do NOT walk past).**
  - Import: `import { findGroveDir as findGroveRoot } from "../cli/utils/grove-dir.js";`
  - Keep the function `findGroveDir` name in main.ts to avoid touching all call sites (267, 451)

- [ ] Run: `bun run tsc --noEmit` — clean
- [ ] Run: `bun test src/tui/` — green (any failures: investigate; may need test fixture updates)
- [ ] Run: `bun test` (full repo) — green

- [ ] Commit:
```
git add src/tui/main.ts
git commit -m "fix(tui): fence findGroveDir at .grove/ dir, do not walk past incomplete grove (#315)"
```

---

## Task 4: Add regression test for the bug

- [ ] Add a test fixture in `src/tui/main.test.ts` (or new file `src/tui/find-grove-dir.test.ts` if main.ts is hard to test):
  - Create temp parent dir with `.grove/grove.json`
  - Create child dir with `.grove/` (no grove.json)
  - chdir to child
  - Call the TUI's findGroveDir
  - Expect: `undefined` (not parent's path)

- [ ] If `findGroveDir` is not exported from main.ts, export it (private-by-convention but exported for testing)

- [ ] Run: `bun test` — all green

- [ ] Commit:
```
git add src/tui/main.ts <test file>
git commit -m "test(tui): regression test for worktree fence (#315)"
```

---

## Self-Review

- [ ] All 3 callsites of `findGroveDir` (TUI + 2 CLI) point at one source of truth (or use the shared one + a thin wrapper)
- [ ] No callsite walks past a `.grove/` directory silently
- [ ] Error messages tell user exactly what to do
- [ ] tsc clean
- [ ] Full repo test suite green
