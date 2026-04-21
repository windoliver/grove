# Make GROVE.md Optional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `grove init` create a bare grove without `GROVE.md` and let `POST /api/sessions` create sessions from a preset when no contract is loaded on the server.

**Architecture:** Pull `presetToGroveMdConfig` out of `src/cli/commands/init.ts` into `src/cli/grove-md-builder.ts` so it can be reused. Add `presetToSessionConfig(preset, name)` in `src/cli/presets/index.ts` that builds a `GroveContract` by round-tripping through `buildGroveMd` / `parseGroveContract` (single source of truth for preset → contract). Guard the `GROVE.md` write on preset presence. Update the session-creation route to resolve a session config from preset when `runtime.contract` is absent; return 400 when neither is available.

**Tech Stack:** Bun, TypeScript, Hono, Zod, Biome, `bun test`.

**Spec:** [`docs/superpowers/specs/2026-04-20-grove-md-optional-design.md`](../specs/2026-04-20-grove-md-optional-design.md)

**Issue:** [#200](https://github.com/windoliver/grove/issues/200)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/cli/grove-md-builder.ts` | GroveMdConfig shape + renderers; owns preset → GroveMdConfig mapping | Add `presetToGroveMdConfig` (moved from init.ts). Accept minimal `{ name, description? }` context instead of `InitOptions` to stay decoupled from the init command. |
| `src/cli/commands/init.ts` | `grove init` orchestration | Import `presetToGroveMdConfig` from grove-md-builder. Guard `GROVE.md` write on `preset !== undefined`. Adjust JSDoc/help wording. |
| `src/cli/presets/index.ts` | Preset registry (full `PresetConfig`) | Add `presetToSessionConfig(preset, name)` — builds a `GroveContract` via the same buildGroveMd → parseGroveContract pipeline the init command uses. |
| `src/server/routes/sessions.ts` | `POST /api/sessions` handler | Replace the 501 `NOT_CONFIGURED` branch with a preset-resolution fallback. Return 400 when neither contract nor preset is available. Import `getPreset` / `presetToSessionConfig`. |
| `src/server/serve.ts` | HTTP server bootstrap | Add one `console.log` when `runtime.contract === undefined` for operator visibility. |
| `tests/cli/init-bare.test.ts` (new) | Covers bare-init path | Assert `grove.db` + `grove.json` exist, `GROVE.md` absent after `grove init` without `--preset`. |
| `tests/cli/preset-to-session-config.test.ts` (new) | Covers the new helper | Assert round-trip produces a valid `GroveContract` with preset fields preserved. |
| `tests/server/routes/sessions-no-contract.test.ts` (new) | Covers the server fallback path | Assert preset-only session creation succeeds without a contract; assert 400 paths. |
| `tests/presets/preset-integration.test.ts` | Existing preset tests | Add a bare-init sibling test asserting absence of `GROVE.md` (existing assertions at :183 and :875 are still valid because they test the `--preset` path). |
| `README.md` | User-facing docs | "GROVE.md is optional" callout under Getting Started; update line ~400 claim that `grove init` always generates it. |

No changes to `src/local/runtime.ts`, `src/tui/main.ts`, `src/tui/resolve-backend.ts`, `src/core/presets.ts`, `src/core/policy-enforcer.ts`, or any enforcing-store file — they already tolerate the absent-contract case from #198/#199.

---

## Task 1: Extract `presetToGroveMdConfig` into `grove-md-builder.ts`

Pull the helper out of `init.ts` so `presetToSessionConfig` (Task 2) can reuse the identical field mapping. Behavior must be byte-for-byte identical for the current `grove init --preset X` path.

**Files:**
- Modify: `src/cli/grove-md-builder.ts` (add export)
- Modify: `src/cli/commands/init.ts:192-197, 370-392` (import + delete local copy)
- Test: `tests/presets/preset-integration.test.ts` (no change — behavior unchanged)

- [ ] **Step 1.1: Read current `presetToGroveMdConfig` and its imports**

Already mapped: `src/cli/commands/init.ts:372-392`. The function depends on `PresetConfig` (from `src/cli/presets/index.ts`) and `GroveMdConfig` (from `src/cli/grove-md-builder.ts`). To avoid a cycle (`grove-md-builder` importing from `cli/presets` which imports `GroveMdConfig` from `grove-md-builder`), accept a minimal context object instead of the full preset/options.

- [ ] **Step 1.2: Add the function to `src/cli/grove-md-builder.ts`**

Append at the bottom of the file (after `defaultGroveMdConfig`):

```typescript
// ---------------------------------------------------------------------------
// Preset → GroveMdConfig conversion
// ---------------------------------------------------------------------------

/**
 * Map a preset configuration (as produced by a `*Preset` object) into the
 * `GroveMdConfig` shape consumed by `buildGroveMd`. `context` supplies the
 * grove-level identity that the preset itself does not carry.
 */
export interface PresetMdInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly mode: "evaluation" | "exploration";
  readonly metrics?: readonly MetricEntry[] | undefined;
  readonly gates?: readonly GateEntry[] | undefined;
  readonly stopConditions?: StopConditionsConfig | undefined;
  readonly concurrency?: ConcurrencyConfig | undefined;
  readonly execution?: ExecutionConfig | undefined;
  readonly topology?: import("../core/topology.js").AgentTopology | undefined;
  readonly presetDescription?: string | undefined;
}

export function presetToGroveMdConfig(
  preset: PresetMdInput,
  context: { readonly name: string; readonly description?: string | undefined },
): GroveMdConfig {
  const description = context.description ?? preset.presetDescription;
  return {
    contractVersion: preset.topology ? 3 : 2,
    name: context.name,
    description,
    mode: preset.mode,
    metrics: preset.metrics,
    topology: preset.topology,
    gates: preset.gates,
    stopConditions: preset.stopConditions,
    concurrency: preset.concurrency,
    execution: preset.execution,
    body:
      `# ${context.name}\n\n${description}\n\n` +
      `> The topology above is the **default** for this grove. ` +
      `Override it per-session:\n` +
      `> \`grove session start --preset <name> --goal "..."\`\n` +
      `> or via the API: \`POST /api/sessions { "preset": "<name>" }\``,
  };
}
```

The `PresetMdInput` interface is a structural subset of `PresetConfig`. Because `PresetConfig` already exposes each of these fields readonly, any `PresetConfig` value satisfies `PresetMdInput` structurally. The only renamed field is `description` → `presetDescription` to avoid colliding with `context.description`.

- [ ] **Step 1.3: Remove the private copy from `init.ts`**

Delete `src/cli/commands/init.ts:370-392` (the `presetToGroveMdConfig` function and its section header).

- [ ] **Step 1.4: Update the init call site**

In `src/cli/commands/init.ts`, change:

```typescript
const mdConfig = preset
  ? presetToGroveMdConfig(preset, options)
  : defaultGroveMdConfig(options);
```

to:

```typescript
const mdConfig = preset
  ? presetToGroveMdConfig(
      { ...preset, presetDescription: preset.description },
      { name: options.name, description: options.description },
    )
  : defaultGroveMdConfig(options);
```

Add `presetToGroveMdConfig` to the existing `grove-md-builder.js` import at the top of the file (currently imports `buildGroveMd`, `defaultGroveMdConfig`, `type GroveMdConfig`).

- [ ] **Step 1.5: Typecheck and run existing preset integration tests**

Run: `bun run typecheck`
Expected: zero errors.

Run: `bun test tests/presets/preset-integration.test.ts`
Expected: all tests pass (behavior is unchanged — same field mapping).

- [ ] **Step 1.6: Commit**

```bash
git add src/cli/grove-md-builder.ts src/cli/commands/init.ts
git commit -m "refactor(cli): extract presetToGroveMdConfig into grove-md-builder (#200)

Moves the preset -> GroveMdConfig mapping out of init.ts so a future
presetToSessionConfig helper (#200) can reuse the same pipeline.
Accepts a minimal context instead of InitOptions to keep the helper
decoupled from the CLI command."
```

---

## Task 2: Add `presetToSessionConfig` in `src/cli/presets/index.ts`

Build a `GroveContract` from a preset by round-tripping through `buildGroveMd` / `parseGroveContract`. Single source of truth — same output as `grove init --preset X` would produce on disk.

**Files:**
- Create: `tests/cli/preset-to-session-config.test.ts`
- Modify: `src/cli/presets/index.ts` (add function + exports)

- [ ] **Step 2.1: Write the failing test**

Create `tests/cli/preset-to-session-config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { getPreset, presetToSessionConfig } from "../../src/cli/presets/index.js";

describe("presetToSessionConfig", () => {
  test("review-loop produces a GroveContract with preset fields preserved", () => {
    const preset = getPreset("review-loop");
    expect(preset).toBeDefined();

    const contract = presetToSessionConfig(preset!, "my-grove");

    expect(contract.name).toBe("my-grove");
    expect(contract.mode).toBe("exploration");
    expect(contract.topology?.structure).toBe("graph");
    expect(contract.topology?.roles).toHaveLength(2);
    expect(contract.topology?.roles.map((r) => r.name)).toEqual(["coder", "reviewer"]);
    expect(contract.concurrency?.maxActiveClaims).toBe(4);
    expect(contract.execution?.defaultLeaseSeconds).toBe(300);
  });

  test("swarm-ops preset produces a GroveContract with tree topology", () => {
    const preset = getPreset("swarm-ops");
    const contract = presetToSessionConfig(preset!, "my-grove");
    expect(contract.topology?.structure).toBe("tree");
    expect(contract.topology?.roles.map((r) => r.name)).toEqual([
      "coordinator",
      "worker",
      "qa",
    ]);
  });

  test("contract round-trips through parseGroveContract with no loss of topology fields", async () => {
    const preset = getPreset("review-loop");
    const contract = presetToSessionConfig(preset!, "my-grove");
    // Round-trip safety: if we build a GROVE.md file with init and parse it
    // back, the result should match presetToSessionConfig for the key fields.
    expect(contract.contractVersion).toBeGreaterThanOrEqual(2);
    expect(contract.topology?.spawning?.dynamic).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun test tests/cli/preset-to-session-config.test.ts`
Expected: FAIL — `presetToSessionConfig is not a function` (or TypeScript import error).

- [ ] **Step 2.3: Implement `presetToSessionConfig`**

In `src/cli/presets/index.ts`, add at the bottom of the file:

```typescript
// ---------------------------------------------------------------------------
// Preset → GroveContract conversion
// ---------------------------------------------------------------------------

import { parseGroveContract, type GroveContract } from "../../core/contract.js";
import { buildGroveMd, presetToGroveMdConfig } from "../grove-md-builder.js";

/**
 * Build a `GroveContract` from a preset by round-tripping through
 * `buildGroveMd` + `parseGroveContract`. This is the same pipeline that
 * `grove init --preset <name>` uses on disk — same output, same validation
 * surface. Used by the server when no GROVE.md is loaded and a caller
 * supplies a preset name on `POST /api/sessions`.
 *
 * `name` is the grove-level name (e.g. the goal or a caller-supplied
 * identifier). The preset's own `name` is the preset ID
 * (e.g. "review-loop") and is not used here.
 */
export function presetToSessionConfig(
  preset: PresetConfig,
  name: string,
): GroveContract {
  const mdConfig = presetToGroveMdConfig(
    { ...preset, presetDescription: preset.description },
    { name, description: preset.description },
  );
  const md = buildGroveMd(mdConfig);
  return parseGroveContract(md);
}
```

Imports go at the top of the file with the existing imports (keep the file's style — top-of-file imports only). Move the two new imports up there and remove the inline placement shown above.

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `bun test tests/cli/preset-to-session-config.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 2.5: Typecheck and lint**

Run: `bun run typecheck`
Expected: zero errors.

Run: `bun run lint`
Expected: zero errors (Biome may reorder imports; run `bun run format` if it complains).

- [ ] **Step 2.6: Commit**

```bash
git add src/cli/presets/index.ts tests/cli/preset-to-session-config.test.ts
git commit -m "feat(cli): add presetToSessionConfig helper (#200)

Builds a GroveContract from a PresetConfig by round-tripping through
buildGroveMd + parseGroveContract. Server routes use this to resolve
session config when no GROVE.md is loaded."
```

---

## Task 3: Guard the `GROVE.md` write in `grove init`

`grove init` without `--preset` should not write `GROVE.md`. `grove init --preset X` continues to write it (Task 6 of the issue).

**Files:**
- Create: `tests/cli/init-bare.test.ts`
- Modify: `src/cli/commands/init.ts:190-197`

- [ ] **Step 3.1: Write the failing test**

Create `tests/cli/init-bare.test.ts`:

```typescript
import { describe, expect, test, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeInit } from "../../src/cli/commands/init.js";

let tempDirs: string[] = [];

async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `grove-init-bare-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs = [];
});

describe("grove init (bare, no --preset)", () => {
  test("creates .grove/ structure without writing GROVE.md", async () => {
    const dir = await createTempDir("no-preset");
    await executeInit({
      name: "bare-grove",
      mode: "evaluation",
      seed: [],
      metric: [],
      force: false,
      agentOverrides: {},
      cwd: dir,
    });

    expect(existsSync(join(dir, ".grove"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "workspaces"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);
    expect(existsSync(join(dir, "GROVE.md"))).toBe(false);
  });

  test("does not overwrite a user-authored GROVE.md when no preset is given", async () => {
    const dir = await createTempDir("preserve-user-md");
    const { writeFile } = await import("node:fs/promises");
    const userContent = "# my custom contract\n";
    await writeFile(join(dir, "GROVE.md"), userContent, "utf-8");

    await executeInit({
      name: "bare-grove",
      mode: "evaluation",
      seed: [],
      metric: [],
      force: true,
      agentOverrides: {},
      cwd: dir,
    });

    const { readFile } = await import("node:fs/promises");
    const after = await readFile(join(dir, "GROVE.md"), "utf-8");
    expect(after).toBe(userContent);
  });
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `bun test tests/cli/init-bare.test.ts`
Expected: FAIL — both tests will fail. The first because `GROVE.md` exists (init writes a default one). The second because init overwrites the user file.

- [ ] **Step 3.3: Guard the GROVE.md write on preset presence**

Open `src/cli/commands/init.ts`. Find the block at lines ~190-197:

```typescript
    // 5. Generate GROVE.md
    progress(3, "Generating GROVE.md contract");
    const grovemdPath = join(options.cwd, "GROVE.md");
    const mdConfig = preset
      ? presetToGroveMdConfig(
          { ...preset, presetDescription: preset.description },
          { name: options.name, description: options.description },
        )
      : defaultGroveMdConfig(options);
    const grovemdContent = buildGroveMd(mdConfig);
    await writeFile(grovemdPath, grovemdContent, "utf-8");
```

Replace with:

```typescript
    // 5. Generate GROVE.md (only when a preset is provided — bare init leaves
    //    GROVE.md absent so PolicyEnforcer reads from session config #199).
    if (preset) {
      progress(3, "Generating GROVE.md contract");
      const grovemdPath = join(options.cwd, "GROVE.md");
      const mdConfig = presetToGroveMdConfig(
        { ...preset, presetDescription: preset.description },
        { name: options.name, description: options.description },
      );
      const grovemdContent = buildGroveMd(mdConfig);
      await writeFile(grovemdPath, grovemdContent, "utf-8");
    }
```

- [ ] **Step 3.4: Drop the now-unused `defaultGroveMdConfig` import**

Check the file's import at the top:

```typescript
import { buildGroveMd, defaultGroveMdConfig, type GroveMdConfig } from "../grove-md-builder.js";
```

If `defaultGroveMdConfig` has no remaining callers in init.ts, change to:

```typescript
import { buildGroveMd, presetToGroveMdConfig, type GroveMdConfig } from "../grove-md-builder.js";
```

(Keep `GroveMdConfig` if the type is still referenced elsewhere in the file; remove if not.)

Leave `defaultGroveMdConfig` exported from `grove-md-builder.ts` — it may still be used elsewhere (verify with a repo-wide grep before deleting):

```bash
rg -n "defaultGroveMdConfig" src/ tests/
```

If the grep returns zero hits after removing the init.ts import, delete the function from `grove-md-builder.ts` in a follow-up commit. Otherwise leave it.

- [ ] **Step 3.5: Run both the new and existing tests**

Run: `bun test tests/cli/init-bare.test.ts tests/presets/preset-integration.test.ts`
Expected: new tests PASS, existing preset tests still PASS (their cases all pass `--preset`, so `GROVE.md` is still written).

- [ ] **Step 3.6: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: zero errors.

- [ ] **Step 3.7: Commit**

```bash
git add src/cli/commands/init.ts tests/cli/init-bare.test.ts
git commit -m "feat(cli): skip GROVE.md write when grove init has no preset (#200)

Bare init (no --preset) creates .grove/ but leaves GROVE.md absent.
PolicyEnforcer reads from session config per #199, so a missing
GROVE.md no longer blocks enforcement."
```

---

## Task 4: Add a bare-init sibling test in `tests/presets/preset-integration.test.ts`

The spec calls for a bare-init sibling test adjacent to the existing `--preset` cases. Tasks 3 already covers this in a new file; add one here too so readers of `preset-integration.test.ts` see the contrast.

**Files:**
- Modify: `tests/presets/preset-integration.test.ts` (insert new `describe` block)

- [ ] **Step 4.1: Locate the existing bare-init fixture helper**

Open `tests/presets/preset-integration.test.ts:54-62` — the `makeOptions` helper requires a preset name. Add a sibling helper that omits the preset. Near the top of the helpers section:

```typescript
function makeBareOptions(cwd: string, name: string): InitOptions {
  return {
    name,
    mode: "evaluation",
    seed: [],
    metric: [],
    force: false,
    agentOverrides: {},
    cwd,
  };
}
```

- [ ] **Step 4.2: Add a "bare init (no preset)" describe block**

Insert after the final preset `describe` block (around `tests/presets/preset-integration.test.ts:875`, at the end of the preset groups):

```typescript
// ============================================================================
// 7. bare init (no --preset)
// ============================================================================

describe("grove init without --preset", () => {
  test("creates .grove/ structure without writing GROVE.md", async () => {
    const dir = await createTempDir("bare");
    await executeInit(makeBareOptions(dir, "bare project"));

    expect(existsSync(join(dir, ".grove"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.db"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "cas"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "workspaces"))).toBe(true);
    expect(existsSync(join(dir, ".grove", "grove.json"))).toBe(true);
    expect(existsSync(join(dir, "GROVE.md"))).toBe(false);
  });

  test("grove.json is written with preset=undefined and mode=local", async () => {
    const dir = await createTempDir("bare-grove-json");
    await executeInit(makeBareOptions(dir, "bare project"));

    const config = readGroveJson(dir);
    expect(config.preset).toBeUndefined();
    expect(config.mode).toBe("local");
    expect(config.name).toBe("bare project");
  });
});
```

The `createTempDir`, `readGroveJson`, and `executeInit` helpers are already imported at the top of the file.

- [ ] **Step 4.3: Run the new block**

Run: `bun test tests/presets/preset-integration.test.ts`
Expected: all existing tests pass + new bare-init tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add tests/presets/preset-integration.test.ts
git commit -m "test(presets): add bare-init sibling cases alongside --preset cases (#200)"
```

---

## Task 5: Update `POST /api/sessions` to resolve preset when no contract is loaded

Replace the 501 `NOT_CONFIGURED` branch with a preset-resolution fallback. Return 400 when neither `runtime.contract` nor a `preset` / `presetName` is supplied.

**Files:**
- Create: `tests/server/routes/sessions-no-contract.test.ts`
- Modify: `src/server/routes/sessions.ts:69-83, plus surrounding baseConfig logic at ~141-145`

- [ ] **Step 5.1: Read the current handler and surrounding helpers**

Already mapped:
- Current 501 branch: `src/server/routes/sessions.ts:73-83`
- `baseConfig` synthesis: `src/server/routes/sessions.ts:141-145`
- Imports: top of file at `src/server/routes/sessions.ts:11-19`
- `ServerDeps.contract` is `GroveContract | undefined` — already typed optional.

- [ ] **Step 5.2: Write the failing test**

Create `tests/server/routes/sessions-no-contract.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { createApp } from "../../../src/server/app.js";
import type { ServerDeps } from "../../../src/server/deps.js";
import { SqliteGoalSessionStore } from "../../../src/local/sqlite-goal-session-store.js";
import { initSqliteDb } from "../../../src/local/sqlite-store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function makeDepsWithoutContract(): ServerDeps {
  const dir = join(
    tmpdir(),
    `grove-sessions-no-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "grove.db");
  const db = initSqliteDb(dbPath);
  const goalSessionStore = new SqliteGoalSessionStore(db);

  return {
    contributionStore: {} as never,
    claimStore: {} as never,
    bountyStore: undefined as never,
    outcomeStore: undefined,
    goalSessionStore,
    handoffStore: {} as never,
    handoffStoreForSession: () => ({}) as never,
    cas: {} as never,
    frontier: {} as never,
    gossip: undefined,
    topology: undefined,
    contract: undefined, // <-- no GROVE.md loaded
    idempotencyStore: {} as never,
  } as ServerDeps;
}

describe("POST /api/sessions without loaded contract", () => {
  let deps: ServerDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    deps = makeDepsWithoutContract();
    app = createApp(deps);
  });

  test("with preset only → 201 with snapshotted session config", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal", preset: "review-loop" }),
    });

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.sessionId).toBeDefined();
    expect(body.config).toBeDefined();
    expect(body.config.topology?.structure).toBe("graph");
    expect(body.config.concurrency?.maxActiveClaims).toBe(4);
  });

  test("with neither preset nor contract → 400", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal" }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("contract or preset required");
  });

  test("with unknown preset → 400", async () => {
    const resp = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "test goal", preset: "does-not-exist" }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Unknown preset");
  });
});
```

- [ ] **Step 5.3: Run the test to verify it fails**

Run: `bun test tests/server/routes/sessions-no-contract.test.ts`
Expected: FAIL — the "with preset only" test returns 501 (current `NOT_CONFIGURED` path); the other two tests' assertions don't match current error text.

- [ ] **Step 5.4: Update the imports in `src/server/routes/sessions.ts`**

Add imports at the top of the file (alongside existing imports at lines 11-19):

```typescript
import { getPreset, presetToSessionConfig } from "../../cli/presets/index.js";
import type { GroveContract } from "../../core/contract.js";
```

- [ ] **Step 5.5: Rewrite the no-contract branch**

Locate lines 69-83 in `src/server/routes/sessions.ts`:

```typescript
sessions.post("/", async (c) => {
  const { goalSessionStore, contract } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");
  if (!contract) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: "No contract loaded — cannot snapshot session config",
        },
      },
      501,
    );
  }
```

Replace with (keep the `!goalSessionStore` line):

```typescript
sessions.post("/", async (c) => {
  const { goalSessionStore, contract } = c.get("deps");
  if (!goalSessionStore) return notConfigured(c, "Goal/session store is not configured");
```

Then relocate the contract-or-preset gating below, after `presetName` has been parsed (around line 92 where `presetName = parsed.data.preset ?? parsed.data.presetName` is already computed). Insert:

```typescript
  // Resolve base config: frozen snapshot source for this session.
  // - Prefer a server-loaded GROVE.md (runtime.contract) when present.
  // - Otherwise fall back to preset resolution; #198/#199 mean the
  //   session's frozen config is what drives enforcement, so callers
  //   who supply a preset don't need a contract on the server.
  // - Reject when neither is available so misconfiguration surfaces.
  let baseConfig: GroveContract | undefined;
  if (contract) {
    baseConfig = contract;
  } else if (presetName) {
    const preset = getPreset(presetName);
    if (!preset) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `Unknown preset '${presetName}'`,
          },
        },
        400,
      );
    }
    baseConfig = presetToSessionConfig(preset, presetName);
  } else {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "contract or preset required when no GROVE.md is loaded",
        },
      },
      400,
    );
  }
```

Then delete the existing `sessionConfig` line that assumes `contract` (line ~145):

```typescript
  const sessionConfig = resolvedTopology ? { ...contract, topology: resolvedTopology } : contract;
```

and replace with:

```typescript
  const sessionConfig = resolvedTopology
    ? { ...baseConfig, topology: resolvedTopology }
    : baseConfig;
```

- [ ] **Step 5.6: Run the test to verify it passes**

Run: `bun test tests/server/routes/sessions-no-contract.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5.7: Update the pre-existing `501` expectation test**

`tests/server/goals-sessions.test.ts:515-543` currently asserts that POST /api/sessions returns 501 when no contract is loaded. After this change, that path returns 400 (preset missing) unless a preset is supplied. Update the test:

Locate the test starting at `tests/server/goals-sessions.test.ts:515`:

```typescript
  test("session creation without server contract returns 501", async () => {
    // ... body sets up a no-contract context and POSTs { goal: "Should fail" }
    expect(res.status).toBe(501);
```

Rename and update the assertions:

```typescript
  test("session creation without server contract and without preset returns 400", async () => {
    // ... same setup — context without contract
    // body: JSON.stringify({ goal: "Should fail" }) — no preset
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("contract or preset required");
```

Keep the temp-dir setup/teardown and the `goalSessionStore` wiring identical. Only the test name, the expected status, and the body assertions change.

- [ ] **Step 5.8: Run the full server/routes suite to catch regressions**

Run: `bun test tests/server/`
Expected: everything passes — the updated `goals-sessions.test.ts` test now expects 400, and the new `sessions-no-contract.test.ts` covers the 201-with-preset path.

- [ ] **Step 5.9: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: zero errors.

- [ ] **Step 5.10: Commit**

```bash
git add src/server/routes/sessions.ts tests/server/routes/sessions-no-contract.test.ts tests/server/goals-sessions.test.ts
git commit -m "feat(server): resolve session config from preset when no contract is loaded (#200)

Replaces the 501 NOT_CONFIGURED branch with preset-driven config
resolution. When runtime.contract is undefined and the request
supplies a preset, the server builds the session's frozen config
from the preset registry. Returns 400 when neither is available.

Updates goals-sessions.test.ts to match the new 400 behavior."
```

---

## Task 6: Add a bootstrap log line when `runtime.contract` is undefined

Operator-visible breadcrumb so it's obvious whether a missing `GROVE.md` is intentional.

**Files:**
- Modify: `src/server/serve.ts:33-37` area (after `runtime` creation but before `deps` construction)

- [ ] **Step 6.1: Add the log line**

Open `src/server/serve.ts`. Find the block at lines 33-37:

```typescript
const runtime = createLocalRuntime({
  groveDir: GROVE_DIR,
  workspace: false,
  parseContract: true,
});
```

Add immediately after it:

```typescript
if (!runtime.contract) {
  console.log(
    "no GROVE.md found — sessions must provide a preset or a loaded contract",
  );
}
```

No test required — single-statement behavioral note, exercised by Task 5's integration path.

- [ ] **Step 6.2: Smoke-check**

Run: `bun run typecheck`
Expected: zero errors.

Manual smoke (optional, non-blocking):
```bash
cd $(mktemp -d) && mkdir .grove && GROVE_DIR=$PWD/.grove bun run src/server/serve.ts &
# look for "no GROVE.md found" in stdout, then kill %1
```

- [ ] **Step 6.3: Commit**

```bash
git add src/server/serve.ts
git commit -m "feat(server): log at bootstrap when no GROVE.md is loaded (#200)"
```

---

## Task 7: Update `README.md` and the CLI `--help` wording

**Files:**
- Modify: `README.md` (Getting Started section, plus line ~400)
- Modify: `src/cli/commands/init.ts:40-42` (JSDoc for parseInitArgs)

- [ ] **Step 7.1: Add a "GROVE.md is optional" callout in `README.md`**

Locate the Getting Started section (near the `grove init --preset` example around lines 141-168). Immediately before or after the existing example, add:

```markdown
### GROVE.md is optional

Every grove works with or without a `GROVE.md` file.

```bash
# Bare grove — no GROVE.md, session config comes from preset per-session.
grove init my-project

# With project defaults — writes GROVE.md populated from the preset.
grove init my-project --preset review-loop
```

When you start a session (`grove session start --preset …` or `POST /api/sessions { "preset": "…" }`), Grove snapshots the full config into the session record. `GROVE.md`, when present, acts as a project-level default for sessions that don't override it.
```

- [ ] **Step 7.2: Update the stale claim at `README.md:400`**

Find the line currently reading:
```
`GROVE.md` is Grove's contract file, generated by `grove init` and read by all
```

Replace with:
```
`GROVE.md` is Grove's contract file — generated by `grove init --preset <name>` and read by all
```

(Keep the surrounding paragraph; only this line changes.)

- [ ] **Step 7.3: Update the `parseInitArgs` JSDoc**

In `src/cli/commands/init.ts`, find the JSDoc block at lines 37-42:

```typescript
/**
 * Parse `grove init` arguments.
 *
 * Usage: grove init [name] [--seed <path>...] [--mode <mode>] [--metric <name:direction>...]
 *        [--description <text>] [--force] [--preset <name>]
 */
```

Replace with:

```typescript
/**
 * Parse `grove init` arguments.
 *
 * Usage: grove init [name] [--seed <path>...] [--mode <mode>] [--metric <name:direction>...]
 *        [--description <text>] [--force] [--preset <name>]
 *
 * Without `--preset`, init creates a bare `.grove/` and does NOT write
 * `GROVE.md` — sessions configure themselves from a preset at start time.
 * With `--preset`, init also generates `GROVE.md` as human-readable
 * project-level defaults.
 */
```

- [ ] **Step 7.4: Commit**

```bash
git add README.md src/cli/commands/init.ts
git commit -m "docs: note that GROVE.md is optional; update init help (#200)"
```

---

## Task 8: Final verification

Run the full suite and the lint + typecheck gates together. No code changes here — if anything fails, return to the relevant task.

- [ ] **Step 8.1: Full test run**

Run: `bun test`
Expected: all tests pass. Zero new failures, zero new flakes.

- [ ] **Step 8.2: Typecheck**

Run: `bun run typecheck`
Expected: zero errors.

- [ ] **Step 8.3: Lint**

Run: `bun run lint`
Expected: zero errors.

- [ ] **Step 8.4: Manual smoke test (optional)**

```bash
cd "$(mktemp -d)"
bun run /path/to/grove/src/cli/main.ts init my-bare-grove
# Expect: .grove/ directory exists, GROVE.md does NOT exist.
ls -la
ls -la .grove
test ! -f GROVE.md && echo "OK: no GROVE.md"

cd "$(mktemp -d)"
bun run /path/to/grove/src/cli/main.ts init my-preset-grove --preset review-loop
# Expect: .grove/ directory exists, GROVE.md exists and parses.
test -f GROVE.md && echo "OK: GROVE.md present"
```

- [ ] **Step 8.5: Update the issue checklist**

If you have `gh` available and the issue is still open, post a comment cross-referencing the merged commits. Or mark the tasks in the issue body by editing it directly. This is bookkeeping — not a code change.

```bash
gh issue comment 200 --repo windoliver/grove --body "Implementation complete. Commits: <list>. Ready for review."
```

(Leave this step open if the implementer doesn't have write access to the repo.)

---

## Self-Review Notes

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `grove init` bare — no GROVE.md | Task 3 |
| `grove init --preset` — still writes GROVE.md | Task 3 (preserved) + Task 4 (test) |
| `POST /api/sessions` preset fallback | Task 5 |
| Bootstrap log when no contract | Task 6 |
| TUI preset picker unchanged | no task (spec explicitly none) |
| Server bootstrap tolerates missing GROVE.md | no task (pre-existing, Task 6 adds log only) |
| README + CLI help wording | Task 7 |
| `presetToSessionConfig` helper | Task 2 |
| Extract `presetToGroveMdConfig` for reuse | Task 1 |
| Tests: bare-init, preset-to-session-config, no-contract-sessions, preset-integration sibling | Tasks 3, 2, 5, 4 |

No spec items missing.

**Type consistency:**
- `presetToSessionConfig(preset: PresetConfig, name: string): GroveContract` is used consistently in Task 2 (definition) and Task 5 (call site).
- `presetToGroveMdConfig(preset: PresetMdInput, context: { name, description? }): GroveMdConfig` is used consistently in Task 1 (definition) and Task 2 (call site) and Task 3 (init call site).

**Placeholder scan:** none found. All code blocks show the full text. All commands show exact arguments.
