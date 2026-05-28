# CLI NO_COLOR and Next Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full issue #176 support for CLI `NO_COLOR` handling, a global `--no-color` flag, and successful next-command hints.

**Architecture:** Keep color state and hint formatting in one focused CLI utility under `src/cli/utils/`. Initialize that state once in `src/cli/main.ts`, then let mutation commands format their own successful hints with the shared helper. Preserve JSON output by only printing hints in human-readable paths.

**Tech Stack:** Bun 1.3.x, `bun:test`, TypeScript strict mode, Biome formatting.

---

### Task 1: CLI Color Utility

**Files:**
- Create: `src/cli/utils/color.ts`
- Create: `src/cli/utils/color.test.ts`

- [x] **Step 1: Write the failing color utility tests**

Create `src/cli/utils/color.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import {
  colorize,
  formatNextCommandHint,
  isColorEnabled,
  setColorEnabled,
  shouldEnableColor,
} from "./color.js";

describe("CLI color controls", () => {
  test("enables color by default", () => {
    expect(shouldEnableColor({}, [])).toBe(true);
  });

  test("NO_COLOR disables color when present", () => {
    expect(shouldEnableColor({ NO_COLOR: "" }, [])).toBe(false);
    expect(shouldEnableColor({ NO_COLOR: "1" }, [])).toBe(false);
  });

  test("TERM=dumb disables color", () => {
    expect(shouldEnableColor({ TERM: "dumb" }, [])).toBe(false);
  });

  test("--no-color disables color", () => {
    expect(shouldEnableColor({}, ["log", "--no-color"])).toBe(false);
  });

  test("setColorEnabled controls colorize output", () => {
    setColorEnabled(true);
    expect(isColorEnabled()).toBe(true);
    expect(colorize("text", "\x1b[2m")).toBe("\x1b[2mtext\x1b[0m");

    setColorEnabled(false);
    expect(isColorEnabled()).toBe(false);
    expect(colorize("text", "\x1b[2m")).toBe("text");
  });

  test("formatNextCommandHint uses the standard hint prefix", () => {
    setColorEnabled(false);
    expect(formatNextCommandHint("Run `grove frontier` to see updated frontier")).toBe(
      "hint: Run `grove frontier` to see updated frontier",
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/cli/utils/color.test.ts
```

Expected: FAIL because `src/cli/utils/color.ts` does not exist.

- [x] **Step 3: Add the minimal color utility**

Create `src/cli/utils/color.ts` with:

```ts
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

let colorEnabled = true;

export function shouldEnableColor(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[] = [],
): boolean {
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  if (env.TERM === "dumb") return false;
  if (args.includes("--no-color")) return false;
  return true;
}

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

export function colorize(text: string, open: string, close = RESET): string {
  return colorEnabled ? `${open}${text}${close}` : text;
}

export function formatNextCommandHint(message: string): string {
  return colorize(`hint: ${message}`, DIM);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test src/cli/utils/color.test.ts
```

Expected: PASS.

### Task 2: Global `--no-color` Dispatch

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.integration.test.ts`

- [x] **Step 1: Write failing integration coverage**

In `src/cli/main.integration.test.ts`, add this import:

```ts
import { stripAnsi } from "../shared/format.js";
```

In the `grove log` section, add:

```ts
  cliTest("NO_COLOR=1 grove log emits no ANSI escape codes", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["log"], tmpDir, { NO_COLOR: "1" });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(stripAnsi(stdout));
  });

  cliTest("--no-color is accepted as a global flag", async () => {
    await setupGrove();
    const { stdout, exitCode } = await runCli(["log", "--no-color"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(stripAnsi(stdout));
    expect(stdout).toContain("Initial schema");
  });
```

- [x] **Step 2: Run tests to verify the global flag case fails**

Run:

```bash
bun test src/cli/main.integration.test.ts --timeout 30000
```

Expected: FAIL on `--no-color is accepted as a global flag` because the command parser receives an unknown `--no-color` flag.

- [x] **Step 3: Initialize and strip the global flag in `main.ts`**

Add this import near the existing CLI imports:

```ts
import { setColorEnabled, shouldEnableColor } from "./utils/color.js";
```

At the start of `main()`, after `const rawArgs = process.argv.slice(2);`, add:

```ts
  setColorEnabled(shouldEnableColor(process.env, rawArgs));
```

In the raw argument loop, add a branch before `--grove` handling:

```ts
    if (token === "--no-color") {
      continue;
    }
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test src/cli/main.integration.test.ts --timeout 30000
```

Expected: PASS.

### Task 3: Mutation Next-Command Hints

**Files:**
- Modify: `src/cli/commands/claim.ts`
- Modify: `src/cli/commands/claim.test.ts`
- Modify: `src/cli/commands/contribute.ts`
- Modify: `src/cli/commands/contribute.test.ts`
- Modify: `src/cli/commands/init.ts`
- Modify: `src/cli/commands/init.test.ts`

- [x] **Step 1: Write failing hint tests**

In `src/cli/commands/claim.test.ts`, extend the first success test:

```ts
    expect(stdout[0]).toContain("hint: Run `grove claims` to see active claims");
```

In `src/cli/commands/contribute.test.ts`, add a small console capture helper near the helpers:

```ts
async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logged;
}
```

Then add this test under `describe("executeContribute", ...)`:

```ts
  test("prints next frontier hint in human output", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));
      const logged = await captureConsoleLog(async () => {
        await executeContribute(makeContributeOptions({ cwd: dir, summary: "Hinted work" }));
      });
      expect(logged.join("\n")).toContain("hint: Run `grove frontier` to see updated frontier");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not print next frontier hint in JSON output", async () => {
    const dir = await createTempDir();
    try {
      await executeInit(makeInitOptions(dir));
      const logged = await captureConsoleLog(async () => {
        await executeContribute(
          makeContributeOptions({ cwd: dir, summary: "JSON hinted work", json: true }),
        );
      });
      expect(logged.join("\n")).not.toContain("hint: Run `grove frontier`");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

In `src/cli/commands/init.test.ts`, add a console capture helper:

```ts
async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logged.push(msg);
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logged;
}
```

Then add this `executeInit` test:

```ts
  initTest("prints grove up next-command hint", async () => {
    const dir = await createTempDir();
    try {
      const logged = await captureConsoleLog(async () => {
        await executeInit(makeOptions({ name: "test-grove", cwd: dir }));
      });
      expect(logged.join("\n")).toContain("hint: Run `grove up` to start services");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test src/cli/commands/claim.test.ts src/cli/commands/contribute.test.ts src/cli/commands/init.test.ts --timeout 30000
```

Expected: FAIL because no new hint lines are printed.

- [x] **Step 3: Add hints to command implementations**

In `src/cli/commands/claim.ts`, import the helper:

```ts
import { formatNextCommandHint } from "../utils/color.js";
```

Replace the final successful human output with:

```ts
  const action = result.value.renewed ? "Renewed" : "Claimed";
  const hint = formatNextCommandHint("Run `grove claims` to see active claims");
  if (claim === undefined) {
    deps.stdout(
      `${action}: ${result.value.claimId}\n` +
        `  target:  ${result.value.targetRef}\n` +
        `  agent:   ${result.value.agentId}\n` +
        `  status:  ${result.value.status}\n` +
        hint,
    );
    return;
  }

  deps.stdout(`${formatClaimSummary(claim, action)}\n${hint}`);
```

In `src/cli/commands/contribute.ts`, import the helper:

```ts
import { formatNextCommandHint } from "../utils/color.js";
```

After the existing human-readable contribution lines, add:

```ts
      console.log(formatNextCommandHint("Run `grove frontier` to see updated frontier"));
```

In `src/cli/commands/init.ts`, import the helper:

```ts
import { formatNextCommandHint } from "../utils/color.js";
```

Replace the final `Next:` output with a single helper line:

```ts
    if (preset) {
      console.log(
        `\nThe '${preset.name}' topology in GROVE.md is the default. Override per-session with:`,
      );
      console.log(`  grove session start --preset <name> --goal "..."`);
    }
    console.log(`\n${formatNextCommandHint("Run `grove up` to start services")}`);
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test src/cli/commands/claim.test.ts src/cli/commands/contribute.test.ts src/cli/commands/init.test.ts --timeout 30000
```

Expected: PASS.

### Task 4: Full Verification and Commit

**Files:**
- Verify all modified files.

- [x] **Step 1: Run focused test suite**

Run:

```bash
bun test src/cli/utils/color.test.ts src/cli/main.integration.test.ts src/cli/commands/claim.test.ts src/cli/commands/contribute.test.ts src/cli/commands/init.test.ts --timeout 30000
```

Expected: PASS.

Actual: Focused assertions passed (`166 pass`, `0 fail`) but Bun exited 1 because
the repository coverage gate is enabled for partial runs. Full-suite assertions
also passed (`7757 pass`, `0 fail`) and exited 1 after the coverage report due
existing below-threshold per-file coverage rows.

- [x] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

Actual: PASS.

- [x] **Step 3: Run lint/check**

Run:

```bash
bun run check
```

Expected: PASS.

Actual: PASS with pre-existing warnings outside the changed files.

- [x] **Step 4: Inspect the diff**

Run:

```bash
git diff -- src/cli src/shared docs/superpowers/plans/2026-05-20-cli-no-color-next-commands.md
```

Expected: Diff only contains the utility, parser hook, tests, hints, and this plan.

Actual: Diff is scoped to CLI color utility, global argument handling, mutation
command hints, tests, and this plan.

- [x] **Step 5: Commit implementation**

Run:

```bash
git add src/cli docs/superpowers/plans/2026-05-20-cli-no-color-next-commands.md
git commit -m "feat: add CLI color controls and hints"
```

Expected: Commit succeeds after hooks pass.

Actual: Commit succeeded after rerunning with `/Users/tafeng/.bun/bin` on PATH
so the pre-commit hook could find `bunx`.
