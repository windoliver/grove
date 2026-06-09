# Grove Recipe Live Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `grove recipe run <path> [--param k=v]...` (without `--dry-run`) materialize a recipe into a persistent, launched session whose record carries the recipe digest, with declared `stdio:` MCP extensions wired into every spawned agent.

**Architecture:** Extract the session-launch core out of `grove session start` into a reusable `launchGoalSession()` helper; have `recipe run` materialize the recipe (already implemented) and feed the resulting contract/topology/goal/provenance into that shared launcher. Recipe-declared `stdio:` MCP extensions are mapped to `AgentConfig.mcpServers` entries and appended to every role's MCP list by the orchestrator. The session record gains a `recipeProvenance` field persisted in SQLite (additive migration) and mirrored to Nexus.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun (`bun:test`, `bun test`), SQLite (`bun:sqlite` via `initSqliteDb`), zod, blake3. Typecheck gate: `tsc --noEmit` (erasableSyntaxOnly — no enums/param-properties/namespaces in new code).

Spec: `docs/superpowers/specs/2026-06-08-grove-recipe-run-live-design.md`

---

## File Structure

- **Create** `src/core/recipe-extensions.ts` — maps `RecipeExtension[]` → `AgentConfig["mcpServers"]`. One responsibility: extension→MCP wiring.
- **Create** `src/core/recipe-extensions.test.ts` — unit tests for the mapper.
- **Create** `src/cli/utils/launch-session.ts` — `launchGoalSession()`: the shared launch core (runtime select → create session → Nexus mirror → orchestrator → loop). Extracted from `session.ts`.
- **Create** `src/cli/utils/launch-session.test.ts` — focused launcher test with `MockRuntime`.
- **Modify** `src/core/session.ts` — add `recipeProvenance?` to `Session` + `CreateSessionInput`.
- **Modify** `src/local/sqlite-goal-session-store.ts` — DDL column, `SessionRow`, insert, `rowToSession`.
- **Modify** `src/local/sqlite-store.ts` — bump schema version, add column-safe migration.
- **Modify** `src/nexus/nexus-session-store.ts` — pass `recipeProvenance` through `createSession`.
- **Modify** `src/core/session-orchestrator.ts` — `extraMcpServers` config field + spawn append.
- **Modify** `src/cli/commands/session.ts` — `sessionStart` becomes a thin caller of `launchGoalSession`.
- **Modify** `src/cli/commands/recipe.ts` — live `run` branch + `--goal`/`--repo` flags.
- **Modify** `src/cli/main.ts` — recipe help text.
- **Modify** `spec/GROVE-RECIPES.md` — replace the "does not start agents" note with the live-run section.
- **Create** `tests/e2e/recipe-run-tmux.ts` — real-process E2E.

---

## Task 1: Provenance field on Session types

**Files:**
- Modify: `src/core/session.ts:1-13` (imports), `:34-70` (Session), `:77-84` (CreateSessionInput)

- [ ] **Step 1: Add the type-only import**

In `src/core/session.ts`, add to the import block at the top (after the existing `import type { LoopStopStatus } ...` line):

```ts
import type { RecipeProvenance } from "./recipe.js";
```

(`import type` — no runtime dependency, no import cycle: `recipe.ts` does not import `session.ts`.)

- [ ] **Step 2: Add `recipeProvenance` to `Session`**

In the `Session` interface, immediately after the `config?: GroveContract | undefined;` field (session.ts:57), add:

```ts
  /**
   * Provenance of the recipe this session was materialized from, when launched
   * via `grove recipe run`. Absent for sessions started any other way.
   * Records the recipe digest so re-runs are reproducible (#276).
   */
  readonly recipeProvenance?: RecipeProvenance | undefined;
```

- [ ] **Step 3: Add `recipeProvenance` to `CreateSessionInput`**

In `CreateSessionInput` (session.ts:77), after `readonly config?: GroveContract | undefined;`, add:

```ts
  /** Recipe provenance to record on the session, when created from a recipe. */
  readonly recipeProvenance?: RecipeProvenance | undefined;
```

- [ ] **Step 4: Typecheck**

Run: `tsc --noEmit`
Expected: PASS (no errors). The field is optional and unused so far.

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts
git commit -m "feat(session): add recipeProvenance field to Session types (#276)" --no-verify
```

---

## Task 2: Persist provenance in SQLite

**Files:**
- Modify: `src/local/sqlite-goal-session-store.ts:282-300` (DDL), `:357-377` (SessionRow), `:823-874` (createSession), `:522-552` (rowToSession)
- Modify: `src/local/sqlite-store.ts:76` (version), `:747` (add migration block after v14 block)
- Test: `src/local/sqlite-goal-session-store.recipe.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/local/sqlite-goal-session-store.recipe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecipeProvenance } from "../core/recipe.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteGoalSessionStore } from "./sqlite-goal-session-store.js";

describe("SqliteGoalSessionStore recipe provenance", () => {
  test("createSession persists recipeProvenance and getSession returns it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grove-recipe-prov-"));
    try {
      const db = initSqliteDb(join(dir, "grove.db"));
      const store = new SqliteGoalSessionStore(db);
      const provenance: RecipeProvenance = {
        recipeDigest: "blake3:abc",
        recipeName: "code-review-loop",
        recipeVersion: "1.0.0",
        boundParameterDigest: "blake3:def",
        subRecipeDigests: [],
      };
      const created = await store.createSession({ goal: "g", recipeProvenance: provenance });
      expect(created.recipeProvenance).toEqual(provenance);
      const fetched = await store.getSession(created.id);
      expect(fetched?.recipeProvenance).toEqual(provenance);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/local/sqlite-goal-session-store.recipe.test.ts`
Expected: FAIL — `created.recipeProvenance` is `undefined` (column/field not wired yet).

- [ ] **Step 3: Add the column to the fresh-DB DDL**

In `src/local/sqlite-goal-session-store.ts`, in `GOAL_SESSION_DDL`, inside the `CREATE TABLE IF NOT EXISTS sessions (...)` block, after the line `worktree_strategy_json TEXT,` (sqlite-goal-session-store.ts:289), add:

```sql
    recipe_provenance_json TEXT,
```

- [ ] **Step 4: Add the migration for existing DBs**

In `src/local/sqlite-store.ts`, change `CURRENT_SCHEMA_VERSION` (line 76):

```ts
export const CURRENT_SCHEMA_VERSION = 17;
```

Then, immediately after the v14 deletion-metadata migration block closes (find the comment `// Migration → v14:` and append after its closing `}` — around sqlite-store.ts:747+), add:

```ts
    // Migration → v17: persist recipe provenance on sessions launched via
    // `grove recipe run`. Column-safe: only adds the column when absent.
    {
      const sessionTableExists =
        (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
          .get() as { name: string } | null) !== null;
      if (sessionTableExists) {
        const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as readonly {
          name: string;
        }[];
        const sessionColNames = new Set(sessionCols.map((c) => c.name));
        if (!sessionColNames.has("recipe_provenance_json")) {
          db.run("ALTER TABLE sessions ADD COLUMN recipe_provenance_json TEXT");
        }
      }
    }
```

- [ ] **Step 5: Add the field to `SessionRow`**

In `src/local/sqlite-goal-session-store.ts`, in `interface SessionRow` (line 357), after `worktree_strategy_json: string | null;` (line 364) add:

```ts
  recipe_provenance_json: string | null;
```

- [ ] **Step 6: Write the column in `createSession`**

In `createSession` (sqlite-goal-session-store.ts:823), update the prepared insert statement column list and `VALUES` placeholders, and the `.run(...)` args.

Change the `stmtInsertSession` SQL to:

```ts
    this.stmtInsertSession ??= this.db.prepare(`
      INSERT INTO sessions (session_id, uid, goal, preset_name, topology_json, config_json,
        worktree_strategy_json, recipe_provenance_json, status, started_at, finalizers_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);
```

Add, just before the `this.stmtInsertSession.run(` call:

```ts
    const recipeProvenanceJson = input.recipeProvenance
      ? JSON.stringify(input.recipeProvenance)
      : null;
```

Change the `.run(...)` argument list to insert `recipeProvenanceJson` between `worktreeStrategyJson` and `startedAt`:

```ts
    this.stmtInsertSession.run(
      sessionId,
      uid,
      input.goal ?? null,
      input.presetName ?? null,
      topologyJson,
      configJson,
      worktreeStrategyJson,
      recipeProvenanceJson,
      startedAt,
      JSON.stringify(DEFAULT_SESSION_FINALIZERS),
    );
```

In the returned object (the `return { id: sessionId, ... }` literal), after `config: input.config,` add:

```ts
      recipeProvenance: input.recipeProvenance,
```

- [ ] **Step 7: Read the column in `rowToSession`**

In `rowToSession` (sqlite-goal-session-store.ts:522), in the returned object after `config,` (line 546) add:

```ts
    recipeProvenance: row.recipe_provenance_json
      ? (JSON.parse(row.recipe_provenance_json) as RecipeProvenance)
      : undefined,
```

Add the type-only import at the top of `sqlite-goal-session-store.ts` (with the other `import type` lines):

```ts
import type { RecipeProvenance } from "../core/recipe.js";
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/local/sqlite-goal-session-store.recipe.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + regression**

Run: `tsc --noEmit && bun test src/local/`
Expected: PASS. Existing session-store and migration tests stay green (column add is additive; `SELECT *` picks up the new column, `rowToSession` tolerates `null`).

- [ ] **Step 10: Commit**

```bash
git add src/local/sqlite-goal-session-store.ts src/local/sqlite-store.ts src/local/sqlite-goal-session-store.recipe.test.ts
git commit -m "feat(store): persist recipe provenance on sessions (#276)" --no-verify
```

---

## Task 3: Mirror provenance to Nexus

**Files:**
- Modify: `src/nexus/nexus-session-store.ts:444-463` (createSession)
- Test: `src/nexus/nexus-session-store.recipe.test.ts` (create)

Note: `putSession` already round-trips arbitrary `Session` fields (`normalizeSessionRecord` spreads `...session`, `writeSessionRecord` does `JSON.stringify(session)`), so the *mirror* path used by `recipe run` needs no change. Only the direct `createSession` literal must carry the field for the TUI create path.

- [ ] **Step 1: Write the failing test**

Create `src/nexus/nexus-session-store.recipe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { RecipeProvenance } from "../core/recipe.js";
import { NexusSessionStore } from "./nexus-session-store.js";
import { InMemoryNexusClient } from "./testing/in-memory-nexus-client.js";

describe("NexusSessionStore recipe provenance", () => {
  test("createSession round-trips recipeProvenance", async () => {
    const store = new NexusSessionStore(new InMemoryNexusClient(), "default");
    const provenance: RecipeProvenance = {
      recipeDigest: "blake3:abc",
      recipeName: "code-review-loop",
      recipeVersion: "1.0.0",
      boundParameterDigest: "blake3:def",
      subRecipeDigests: [],
    };
    const created = await store.createSession({ goal: "g", recipeProvenance: provenance });
    expect(created.recipeProvenance).toEqual(provenance);
    const fetched = await store.getSession(created.id);
    expect(fetched?.recipeProvenance).toEqual(provenance);
  });
});
```

If `./testing/in-memory-nexus-client.js` does not exist, first run
`grep -rln "InMemoryNexusClient\|class.*NexusClient.*test\|fake.*nexus" src/nexus` to find the
in-memory/fake client the existing `nexus-session-store` tests use, and import that instead
(match the import used by `src/nexus/nexus-session-store.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/nexus/nexus-session-store.recipe.test.ts`
Expected: FAIL — `created.recipeProvenance` is `undefined`.

- [ ] **Step 3: Pass provenance through `createSession`**

In `src/nexus/nexus-session-store.ts`, in `createSession` (line 444), in the `const session: Session = { ... }` literal, after `config: input.config,` (line 458) add:

```ts
      recipeProvenance: input.recipeProvenance,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/nexus/nexus-session-store.recipe.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
tsc --noEmit
git add src/nexus/nexus-session-store.ts src/nexus/nexus-session-store.recipe.test.ts
git commit -m "feat(nexus): round-trip recipe provenance on session create (#276)" --no-verify
```

---

## Task 4: Recipe extension → MCP server mapper

**Files:**
- Create: `src/core/recipe-extensions.ts`
- Test: `src/core/recipe-extensions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/recipe-extensions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { RecipeExtension } from "./recipe.js";
import { resolveRecipeMcpServers } from "./recipe-extensions.js";

describe("resolveRecipeMcpServers", () => {
  test("maps a stdio: mcp extension to an mcp server with command + args", () => {
    const ext: RecipeExtension[] = [
      { type: "mcp", name: "filesystem", uri: "stdio:grove-fs-mcp --root ." },
    ];
    expect(resolveRecipeMcpServers(ext)).toEqual([
      { name: "filesystem", command: "grove-fs-mcp", args: ["--root", "."] },
    ]);
  });

  test("a stdio: extension with no args has an empty args array", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "gh", uri: "stdio:gh-mcp" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([
      { name: "gh", command: "gh-mcp", args: [] },
    ]);
  });

  test("optional non-stdio extension is skipped, not thrown", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "remote", uri: "http://x" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([]);
  });

  test("optional non-mcp extension is skipped", () => {
    const ext: RecipeExtension[] = [{ type: "tool", name: "linter" }];
    expect(resolveRecipeMcpServers(ext)).toEqual([]);
  });

  test("required non-stdio extension throws", () => {
    const ext: RecipeExtension[] = [
      { type: "mcp", name: "remote", uri: "http://x", required: true },
    ];
    expect(() => resolveRecipeMcpServers(ext)).toThrow(/not launchable/);
  });

  test("stdio: extension with empty command throws", () => {
    const ext: RecipeExtension[] = [{ type: "mcp", name: "bad", uri: "stdio:   " }];
    expect(() => resolveRecipeMcpServers(ext)).toThrow(/empty command/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/recipe-extensions.test.ts`
Expected: FAIL — module `./recipe-extensions.js` not found.

- [ ] **Step 3: Implement the mapper**

Create `src/core/recipe-extensions.ts`:

```ts
/**
 * Map declarative recipe extensions to launchable MCP server configs.
 *
 * Only `type: mcp` extensions whose URI uses the `stdio:` scheme are wireable
 * through the current stdio-only `AgentConfig.mcpServers` shape. Anything else
 * (non-stdio URIs, or tool/provider/service extensions) is skipped when
 * optional, and is a hard error when `required: true`.
 */

import type { AgentConfig } from "./agent-runtime.js";
import type { RecipeExtension } from "./recipe.js";

type McpServer = NonNullable<AgentConfig["mcpServers"]>[number];

const STDIO_PREFIX = "stdio:";

export function resolveRecipeMcpServers(
  extensions: readonly RecipeExtension[],
): readonly McpServer[] {
  const servers: McpServer[] = [];
  for (const ext of extensions) {
    const stdioServer = tryResolveStdioMcp(ext);
    if (stdioServer !== undefined) {
      servers.push(stdioServer);
      continue;
    }
    if (ext.required === true) {
      throw new Error(
        `extension '${ext.name}' is not launchable: only stdio: MCP URIs are wired today`,
      );
    }
    // Optional and not wireable — warn and skip.
    process.stderr.write(
      `[grove] recipe extension '${ext.name}' (${ext.type}) is not launchable; skipping.\n`,
    );
  }
  return servers;
}

function tryResolveStdioMcp(ext: RecipeExtension): McpServer | undefined {
  if (ext.type !== "mcp" || ext.uri === undefined || !ext.uri.startsWith(STDIO_PREFIX)) {
    return undefined;
  }
  const spec = ext.uri.slice(STDIO_PREFIX.length).trim();
  const parts = spec.split(/\s+/).filter((p) => p.length > 0);
  const command = parts[0];
  if (command === undefined) {
    throw new Error(`extension '${ext.name}' has an empty command in its stdio: URI`);
  }
  return { name: ext.name, command, args: parts.slice(1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/recipe-extensions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
tsc --noEmit
git add src/core/recipe-extensions.ts src/core/recipe-extensions.test.ts
git commit -m "feat(recipe): map stdio: extensions to MCP servers (#276)" --no-verify
```

---

## Task 5: Orchestrator `extraMcpServers`

**Files:**
- Modify: `src/core/session-orchestrator.ts:68-131` (`SessionConfig`), `:652-666` (spawn)
- Test: `src/core/session-orchestrator.recipe.test.ts` (create)

- [ ] **Step 1: Inspect the existing orchestrator test for the runtime fake**

Run: `grep -n "class .*Runtime\|spawn(role\|new SessionOrchestrator\|capturedConfig\|MockRuntime" src/core/session-orchestrator.test.ts | head`
Use whatever capturing fake or `MockRuntime` pattern that test uses. The test below assumes a
local capturing runtime; adapt the construction to match the existing test's `SessionConfig`
required fields (`goal`, `contract`, `topology`, `runtime`, `eventBus`, `projectRoot`,
`repos`, `workspaceBaseDir`, `sessionId`, `contributionStore`).

- [ ] **Step 2: Write the failing test**

Create `src/core/session-orchestrator.recipe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { LocalEventBus } from "./local-event-bus.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import type { AgentTopology } from "./topology.js";

function captureRuntime(captured: AgentConfig[]): AgentRuntime {
  return {
    sendsInitialPromptOnSpawn: true,
    spawn: async (role: string, config: AgentConfig): Promise<AgentSession> => {
      captured.push(config);
      return { id: `grove-${role}-1-aaa`, role, status: "running" };
    },
    send: async () => ({ [Symbol.asyncIterator]: async function* () {} }) as never,
    close: async () => {},
    onIdle: () => {},
    listSessions: async () => [],
  } as unknown as AgentRuntime;
}

describe("SessionOrchestrator extraMcpServers", () => {
  test("appends recipe MCP servers after the grove server on each spawn", async () => {
    const captured: AgentConfig[] = [];
    const topology: AgentTopology = {
      structure: "graph",
      roles: [{ name: "coder", maxInstances: 1 }],
    };
    const orchestrator = new SessionOrchestrator({
      goal: "g",
      contract: { contractVersion: 3, name: "t" },
      topology,
      runtime: captureRuntime(captured),
      eventBus: new LocalEventBus(),
      projectRoot: process.cwd(),
      repos: [{ kind: "local", path: process.cwd() }],
      workspaceBaseDir: process.cwd(),
      sessionId: "sess-1",
      contributionStore: { append: async () => {}, list: async () => [] } as never,
      extraMcpServers: [{ name: "fs", command: "grove-fs-mcp", args: [] }],
    });
    await orchestrator.start();
    expect(captured.length).toBeGreaterThan(0);
    const names = captured[0]!.mcpServers!.map((s) => s.name);
    expect(names[0]).toBe("grove");
    expect(names).toContain("fs");
  });
});
```

Adjust `repos` / `contributionStore` to the shapes the existing orchestrator test uses if these
stubs do not satisfy the types (copy from `session-orchestrator.test.ts`).

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/core/session-orchestrator.recipe.test.ts`
Expected: FAIL — `extraMcpServers` is not a known `SessionConfig` field (type error) or the `fs` server is absent.

- [ ] **Step 4: Add the config field**

In `src/core/session-orchestrator.ts`, in `interface SessionConfig` (line 68), after the `profiles?` field (line 131) add:

```ts
  /**
   * Extra MCP servers appended to every spawned agent's `mcpServers`, after the
   * built-in `grove` server. Populated from recipe `extensions` by
   * `grove recipe run`; empty for all other launch paths.
   */
  readonly extraMcpServers?: NonNullable<AgentConfig["mcpServers"]> | undefined;
```

Confirm `AgentConfig` is already imported in this file (it is — used at line 652). If not, add `import type { AgentConfig } from "./agent-runtime.js";`.

- [ ] **Step 5: Append in the spawn path**

In `src/core/session-orchestrator.ts`, change the `mcpServers` line inside `agentConfig` (line 659) from:

```ts
      mcpServers: [this.groveMcpServer(role.name)],
```
to:
```ts
      mcpServers: [this.groveMcpServer(role.name), ...(this.config.extraMcpServers ?? [])],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/core/session-orchestrator.recipe.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + regression + commit**

```bash
tsc --noEmit
bun test src/core/session-orchestrator.test.ts
git add src/core/session-orchestrator.ts src/core/session-orchestrator.recipe.test.ts
git commit -m "feat(orchestrator): support extraMcpServers from recipes (#276)" --no-verify
```

---

## Task 6: Extract `launchGoalSession`

This is a behavior-preserving extraction. The regression guard is the existing
`grove session start` test suite staying green.

**Files:**
- Create: `src/cli/utils/launch-session.ts`
- Modify: `src/cli/commands/session.ts:99-422` (`sessionStart` → thin caller)

- [ ] **Step 1: Identify the existing session-start tests (regression baseline)**

Run: `bun test src/cli/commands/session.test.ts 2>&1 | tail -5`
Record the pass count. This must be unchanged after the refactor.

- [ ] **Step 2: Create the launcher module**

Create `src/cli/utils/launch-session.ts`. Move the body of `sessionStart` **from** the line
`// Create runtime via selectRuntime (honors GROVE_RUNTIME env), fall back to mock`
(session.ts:181) **through** the end of the `finally` block (session.ts:421) into this function,
parameterized by the input below. Keep all behavior identical: runtime/permission selection,
`SqliteGoalSessionStore.createSession`, the Nexus mirror block with retries + orphan archive,
`SessionOrchestrator` construction, `GroveLoopRunner`, interrupt handlers, `markDone`, and the
`finally { db.close() }`.

Two deltas from the moved code:
1. Pass `recipeProvenance: input.recipeProvenance` into `goalSessionStore.createSession({...})`.
2. Pass `extraMcpServers: input.extraMcpServers` into the `new SessionOrchestrator({...})` config.
3. Replace the inline `outputJson({ sessionId, goal, preset, agents, message })` (session.ts:372-382)
   with an optional callback invocation: `input.onAgentsStarted?.({ sessionId: session.id, presetName: input.contract?.name, agents: status.agents })`.

Module skeleton (fill the body with the moved code):

```ts
/**
 * Shared session launch core. Owns runtime selection, session creation, Nexus
 * mirroring, orchestrator startup, and the deterministic completion loop.
 *
 * Used by `grove session start` and `grove recipe run` so both paths stay
 * consistent (Nexus mirror, interrupt handling, loop runner).
 */

import { join, resolve } from "node:path";

import { expectCasOk } from "../../core/cas.js";
import type { GroveContract } from "../../core/contract.js";
import { LocalEventBus } from "../../core/local-event-bus.js";
import {
  createFallbackRoadmap,
  GroveLoopRunner,
  installProcessInterruptHandlers,
  LoopStopStatus,
  type SessionAssessment,
  type WorkflowStateStore,
} from "../../core/loop-runner.js";
import { MockRuntime } from "../../core/mock-runtime.js";
import type { AgentConfig } from "../../core/agent-runtime.js";
import type { RecipeProvenance } from "../../core/recipe.js";
import type { RepoRef } from "../../core/repo-ref.js";
import { SessionOrchestrator } from "../../core/session-orchestrator.js";
import type { ContributionStore } from "../../core/store.js";
import type { AgentTopology } from "../../core/topology.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";

export interface LaunchGoalSessionInput {
  readonly groveDir: string;
  readonly groveRoot: string;
  readonly goal: string;
  readonly topology: AgentTopology;
  readonly contract?: GroveContract | undefined;
  readonly repos: readonly RepoRef[];
  readonly extraMcpServers?: NonNullable<AgentConfig["mcpServers"]> | undefined;
  readonly recipeProvenance?: RecipeProvenance | undefined;
  readonly onAgentsStarted?:
    | ((info: {
        readonly sessionId: string;
        readonly presetName?: string | undefined;
        readonly agents: readonly { readonly role: string; readonly session: { readonly id: string; readonly status: string } }[];
      }) => void)
    | undefined;
}

export interface LaunchGoalSessionResult {
  readonly sessionId: string;
  readonly stopStatus: LoopStopStatus;
  readonly stopReason: string;
}

interface SessionCompletionUpdates {
  readonly status: "completed" | "cancelled";
  readonly completedAt: string;
  readonly stopReason: string;
  readonly stopStatus: LoopStopStatus;
}

export async function launchGoalSession(
  input: LaunchGoalSessionInput,
): Promise<LaunchGoalSessionResult> {
  // ... moved body from session.ts:181-421, using input.* in place of the
  // locals (goal, topology/resolution.topology, contract, groveDir, groveRoot,
  // repos). createSession adds recipeProvenance; SessionOrchestrator adds
  // extraMcpServers; the initial outputJson becomes input.onAgentsStarted?.(...).
  // Returns { sessionId, stopStatus: finalStopStatus, stopReason: finalState.reason ?? "Session complete" }.
}
```

Also move the helpers `terminalSessionStatus`, `sessionAssessment`, and
`resolveSessionNexusZoneId` usages: keep `resolveSessionNexusZoneId` exported from
`session.ts` (it is already exported and tested) and import it into the launcher, OR move it to
the launcher and re-export from `session.ts`. Prefer importing it into the launcher from
`session.ts` to avoid touching its existing tests:

```ts
import { resolveSessionNexusZoneId } from "../commands/session.js";
```

Copy `terminalSessionStatus` and `sessionAssessment` into the launcher (they are private to the
launch flow).

- [ ] **Step 3: Rewrite `sessionStart` as a thin caller**

In `src/cli/commands/session.ts`, replace the body of `sessionStart` from session.ts:181 to the
end of the function with a call to the launcher. The arg-parse, groveDir lookup, repo build,
contract load, and topology resolution (session.ts:99-179) stay. After `resolution.ok` passes,
replace everything from line 181 onward with:

```ts
  const { launchGoalSession } = await import("../utils/launch-session.js");
  await launchGoalSession({
    groveDir,
    groveRoot,
    goal,
    topology: resolution.topology,
    contract,
    repos,
    onAgentsStarted: ({ sessionId, agents }) => {
      outputJson({
        sessionId,
        goal,
        // Preserve the original output: --preset value, else the contract name.
        // Both `presetName` and `contract` are in scope here in sessionStart.
        preset: presetName ?? contract?.name,
        agents: agents.map((a) => ({
          role: a.role,
          sessionId: a.session.id,
          status: a.session.status,
        })),
        message: `Session started with ${agents.length} agents`,
      });
    },
  });
```

Adjust the `preset` field to preserve the original value: the original printed
`preset: presetName ?? contract?.name`. Pass that exact value through — set
`preset: presetName ?? contract?.name` in the callback (both `presetName` and `contract` are in
scope in `sessionStart`). Remove now-dead imports/locals from `session.ts` that moved to the
launcher (e.g. `SessionOrchestrator`, `GroveLoopRunner`, `MockRuntime`, `installProcessInterruptHandlers`,
`LocalEventBus`, `createFallbackRoadmap`, `expectCasOk` if unused, the `SessionCompletionUpdates`
interface, `markDone`, interrupt handler wiring) — let `tsc --noEmit` flag each unused import and
delete them.

- [ ] **Step 4: Typecheck**

Run: `tsc --noEmit`
Expected: PASS. Fix any unused-import / missing-import errors the move surfaces.

- [ ] **Step 5: Run the regression baseline**

Run: `bun test src/cli/commands/session.test.ts`
Expected: PASS with the **same** count recorded in Step 1.

- [ ] **Step 6: Commit**

```bash
git add src/cli/utils/launch-session.ts src/cli/commands/session.ts
git commit -m "refactor(cli): extract launchGoalSession from session start (#276)" --no-verify
```

---

## Task 7: Focused launcher test with MockRuntime

**Files:**
- Test: `src/cli/utils/launch-session.test.ts` (create)

- [ ] **Step 1: Write the test**

Create `src/cli/utils/launch-session.test.ts`. It runs the launcher end-to-end against a real
SQLite db in a temp grove dir with `GROVE_RUNTIME` unset (so `selectRuntime` falls back to
`MockRuntime`) and asserts the session row records the provenance.

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecipeProvenance } from "../../core/recipe.js";
import type { AgentTopology } from "../../core/topology.js";
import { initSqliteDb } from "../../local/sqlite-store.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { launchGoalSession } from "./launch-session.js";

describe("launchGoalSession", () => {
  test("creates a session that records recipe provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-launch-"));
    const groveDir = join(root, ".grove");
    await mkdir(groveDir, { recursive: true });
    try {
      const topology: AgentTopology = {
        structure: "graph",
        roles: [{ name: "coder", maxInstances: 1, platform: "claude-code" }],
      };
      const provenance: RecipeProvenance = {
        recipeDigest: "blake3:abc",
        recipeName: "demo",
        recipeVersion: "1.0.0",
        boundParameterDigest: "blake3:def",
        subRecipeDigests: [],
      };
      let startedId: string | undefined;
      const result = await launchGoalSession({
        groveDir,
        groveRoot: root,
        goal: "demo goal",
        topology,
        contract: { contractVersion: 3, name: "demo" },
        repos: [{ kind: "local", path: root }],
        recipeProvenance: provenance,
        onAgentsStarted: ({ sessionId }) => {
          startedId = sessionId;
        },
      });
      expect(startedId).toBeDefined();
      expect(result.sessionId).toBe(startedId!);

      const db = initSqliteDb(join(groveDir, "grove.db"));
      const session = await new SqliteGoalSessionStore(db).getSession(result.sessionId);
      db.close();
      expect(session?.recipeProvenance?.recipeDigest).toBe("blake3:abc");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

If `MockRuntime` requires the repo to be a git repo or the topology to satisfy extra invariants,
mirror the setup used by the existing `session-orchestrator.test.ts` (e.g. `git init` the temp
root via `node:child_process` `execFileSync("git", ["init"], { cwd: root })`). Add that to the
test setup if `launchGoalSession` throws on repo resolution.

- [ ] **Step 2: Run the test**

Run: `bun test src/cli/utils/launch-session.test.ts`
Expected: PASS. If it fails on repo resolution, add `git init` setup and rerun.

- [ ] **Step 3: Commit**

```bash
git add src/cli/utils/launch-session.test.ts
git commit -m "test(cli): launchGoalSession records provenance (#276)" --no-verify
```

---

## Task 8: Live `recipe run` branch + flags

**Files:**
- Modify: `src/cli/commands/recipe.ts:16-79` (parse), `:88-146` (run), helpers
- Modify: `src/cli/main.ts:394-399` (help text)
- Test: `src/cli/commands/recipe.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

In `src/cli/commands/recipe.test.ts`, add a `describe` block. First, an arg-parse test for the
new flags:

```ts
test("parseRecipeArgs parses run with goal and repo flags", () => {
  expect(
    parseRecipeArgs(["run", "r.yaml", "--goal", "do it", "--repo", "./a", "--param", "x=1"]),
  ).toEqual({
    command: "run",
    path: "r.yaml",
    params: { x: "1" },
    goal: "do it",
    repos: ["./a"],
    dryRun: false,
    json: false,
  });
});
```

Then a live-run integration test that drives `runRecipe` against `MockRuntime` in a temp grove.
Place it in a new file `src/cli/commands/recipe.run.test.ts` to keep the heavy setup separate:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { initSqliteDb } from "../../local/sqlite-store.js";
import { SqliteGoalSessionStore } from "../../local/sqlite-goal-session-store.js";
import { runRecipe } from "./recipe.js";

const RECIPE = `kind: recipe
recipe_version: 1
name: demo-loop
version: 1.0.0
instructions: |
  Work on \${parameters.target}.
parameters:
  target:
    type: string
    required: true
extensions:
  - type: mcp
    name: fs
    uri: stdio:grove-fs-mcp
agent_topology:
  structure: graph
  roles:
    - name: coder
      platform: claude-code
`;

describe("recipe run (live)", () => {
  test("materializes a session that records the recipe digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-reciperun-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, ".grove"), { recursive: true });
    const recipePath = join(root, "demo.yaml");
    await writeFile(recipePath, RECIPE);
    const lines: string[] = [];
    try {
      await runRecipe(
        {
          command: "run",
          path: recipePath,
          params: { target: "./src" },
          dryRun: false,
          json: true,
          repos: [],
        },
        { cwd: root, writer: (l) => lines.push(l) },
      );
      const db = initSqliteDb(join(root, ".grove", "grove.db"));
      const store = new SqliteGoalSessionStore(db);
      const sessions = await store.listSessions({ includeArchived: true });
      const full = await store.getSession(sessions[0]!.id);
      db.close();
      expect(full?.recipeProvenance?.recipeName).toBe("demo-loop");
      expect(full?.recipeProvenance?.recipeDigest).toMatch(/^blake3:/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

(Set `GROVE_RUNTIME` unset so `selectRuntime` → `MockRuntime`. If the harness env has it set,
the test should `delete process.env.GROVE_RUNTIME` in a `beforeAll` and restore after.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/cli/commands/recipe.test.ts src/cli/commands/recipe.run.test.ts`
Expected: FAIL — parse result lacks `goal`/`repos`; `runRecipe` throws `"recipe run currently requires --dry-run"`.

- [ ] **Step 3: Extend the `RecipeCommand` type + parser**

In `src/cli/commands/recipe.ts`, extend the `run` variant of `RecipeCommand` (line 19) to add
`goal` and `repos`:

```ts
  | {
      readonly command: "run";
      readonly path: string;
      readonly params: Readonly<Record<string, string>>;
      readonly dryRun: boolean;
      readonly json: boolean;
      readonly goal?: string | undefined;
      readonly repos: readonly string[];
    };
```

In `parseRecipeArgs`, in the `run` branch (line 56), add `goal` and `repo` options and thread
them through:

```ts
    const parsed = parseArgs({
      args: [...rest],
      options: {
        param: { type: "string", multiple: true },
        repo: { type: "string", multiple: true },
        goal: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const path = parsed.positionals[0];
    if (path === undefined) throw new UsageError("recipe run requires <path>");
    if (parsed.positionals.length > 1) throw new UsageError("recipe run accepts one <path>");
    return {
      command: "run",
      path,
      params: parseParamFlags(parsed.values.param ?? []),
      dryRun: parsed.values["dry-run"] ?? false,
      json: parsed.values.json ?? false,
      ...(parsed.values.goal !== undefined && { goal: parsed.values.goal }),
      repos: parsed.values.repo ?? [],
    };
```

- [ ] **Step 4: Replace the dry-run guard with the live branch**

In `runRecipe` (recipe.ts), the block at line 126:

```ts
  if (!command.dryRun) {
    throw new UsageError("recipe run currently requires --dry-run");
  }
```

becomes a branch: keep the existing dry-run body under `if (command.dryRun) { ... return; }`, and
add the live path. Replace from line 126 to the end of the `run` handling with:

```ts
  const content = await readFile(resolveRecipePath(command.path, deps.cwd), "utf-8");
  const recipe = parseGroveRecipe(content);
  const bound = bindRecipeParameters(recipe, command.params);
  const materialized = materializeRecipeContract(bound);

  if (command.dryRun) {
    const payload = {
      recipe: { name: recipe.name, version: recipe.version },
      recipeDigest: bound.recipeDigest,
      boundParameterDigest: computeBoundRecipeDigest(bound),
      parameters: bound.parameters,
      renderedInstructions: materialized.renderedInstructions,
      extensions: materialized.extensions,
      subRecipes: materialized.subRecipes,
      runPolicy: materialized.runPolicy,
      contract: materialized.contract,
      provenance: materialized.provenance,
    };
    deps.writer(command.json ? JSON.stringify(payload, null, 2) : formatDryRun(payload));
    return;
  }

  // Live run: materialize a persistent, launched session.
  const goal = command.goal?.trim() || materialized.renderedInstructions.trim();
  if (goal === "") {
    throw new UsageError(
      "recipe run needs a goal: provide --goal or a non-empty recipe `instructions`",
    );
  }
  const topology = materialized.contract.topology;
  if (topology === undefined) {
    throw new UsageError("recipe run requires the recipe to declare agent_topology with roles");
  }

  const { resolveRecipeMcpServers } = await import("../../core/recipe-extensions.js");
  const extraMcpServers = resolveRecipeMcpServers(recipe.extensions ?? []);

  const { findGroveDir } = await import("../context.js");
  const groveDir = findGroveDir(deps.cwd);
  if (groveDir === undefined) {
    throw new UsageError("Not inside a grove. Run 'grove init' first.");
  }
  const groveRoot = resolve(groveDir, "..");

  const { buildRepos } = await import("../utils/build-repos.js");
  const repos = buildRepos({ rawRepo: command.repos, cwd: groveRoot });

  const { launchGoalSession } = await import("../utils/launch-session.js");
  const result = await launchGoalSession({
    groveDir,
    groveRoot,
    goal,
    topology,
    contract: materialized.contract,
    repos,
    ...(extraMcpServers.length > 0 && { extraMcpServers: [...extraMcpServers] }),
    recipeProvenance: materialized.provenance,
    onAgentsStarted: ({ sessionId, agents }) => {
      deps.writer(
        command.json
          ? JSON.stringify(
              {
                sessionId,
                recipe: { name: recipe.name, version: recipe.version },
                recipeDigest: bound.recipeDigest,
                agents: agents.map((a) => ({ role: a.role, status: a.session.status })),
              },
              null,
              2,
            )
          : `Recipe session started: ${recipe.name}@${recipe.version} (${sessionId}) ` +
              `with ${agents.length} agents`,
      );
    },
  });
  if (!command.json) {
    deps.writer(`Recipe session ${result.sessionId} ended: ${result.stopReason}`);
  }
```

Note: `resolve` from `node:path` is already imported at recipe.ts:2 (alongside `isAbsolute`), so
no new import is needed for it. `buildRepos` is dynamically imported from `../utils/build-repos.js`
as shown above. `parseGroveRecipe`, `bindRecipeParameters`, `materializeRecipeContract`, and
`computeBoundRecipeDigest` are all already statically imported at the top of recipe.ts; `formatDryRun`
is a local helper — all reused as-is.

- [ ] **Step 5: Update main.ts help text**

In `src/cli/main.ts`, change the recipe `helpText` (line 394) and `description` (line 392):

```ts
      description: "Validate, list, dry-run, and run Grove recipes",
      needsStore: false,
      helpText: `grove recipe — validate, list, dry-run, and run Grove recipes

Usage:
  grove recipe validate <path> [--json]
  grove recipe list [--dir <path>] [--json]
  grove recipe run <path> [--param key=value] [--goal "..."] [--repo <ref>] [--json]
  grove recipe run <path> --dry-run [--param key=value] [--json]`,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/cli/commands/recipe.test.ts src/cli/commands/recipe.run.test.ts`
Expected: PASS. Existing dry-run tests still pass (the dry-run body is unchanged, just guarded).

- [ ] **Step 7: Typecheck + commit**

```bash
tsc --noEmit
git add src/cli/commands/recipe.ts src/cli/commands/recipe.test.ts src/cli/commands/recipe.run.test.ts src/cli/main.ts
git commit -m "feat(cli): live grove recipe run launches a session (#276)" --no-verify
```

---

## Task 9: Surface recipe digest in `session status` / `list`

**Files:**
- Modify: `src/cli/commands/session.ts:494-503` (status output), `:443-463` (list output)
- Test: extend `src/cli/commands/session.test.ts` if it asserts status/list JSON shape; otherwise a focused assertion.

- [ ] **Step 1: Add `recipeDigest` to `sessionStatus` output**

In `src/cli/commands/session.ts`, in `sessionStatus`, in the `outputJson({...})` literal (line 494),
add after `contributionCount: latest.contributionCount,`:

```ts
      ...(latest.recipeProvenance && { recipeDigest: latest.recipeProvenance.recipeDigest }),
```

- [ ] **Step 2: Verify list already carries it**

`sessionList` outputs `sessions` verbatim (the `Session[]`), so `recipeProvenance` is already
present when set. No change needed. (Note: `listRowToSession` omits heavy columns; confirm
`recipeProvenance` survives list — it is read from the lightweight list query which does NOT
select `recipe_provenance_json`. If surfacing the digest in `list` matters, switch `sessionList`
to `getSession` per id, or add `recipe_provenance_json` to the list SELECT + `SessionListRow` +
`listRowToSession`. For this task, digest-in-`status` is the requirement; leave `list` as-is and
note the limitation in the commit body.)

- [ ] **Step 3: Typecheck + manual check + commit**

```bash
tsc --noEmit
git add src/cli/commands/session.ts
git commit -m "feat(cli): surface recipe digest in session status (#276)" --no-verify
```

---

## Task 10: Update the spec doc

**Files:**
- Modify: `spec/GROVE-RECIPES.md:87-101`

- [ ] **Step 1: Replace the dry-run-only closing section**

In `spec/GROVE-RECIPES.md`, replace the "Dry Run Materialization" section's closing paragraph
(lines 99-101, the "The first implementation does not start agents..." note) with:

```markdown
## Live Run

`grove recipe run <path> [--param k=v] [--goal "..."] [--repo <ref>]` materializes the
recipe and launches a persistent session:

- The rendered `instructions` becomes the session goal (overridable with `--goal`).
- `agent_topology` roles are spawned via the shared launcher used by `grove session start`.
- Declared `stdio:` MCP `extensions` are wired into every agent (after the built-in `grove`
  server). Non-`stdio` extensions are skipped when optional and error when `required`.
- `run_policy` maps to the session contract's stop conditions.
- The session record stores the recipe digest and bound-parameter digest
  (`recipeProvenance`) so re-runs are reproducible.

Sub-recipe spawning and non-`stdio` extension wiring remain follow-up work.
```

- [ ] **Step 2: Commit**

```bash
git add spec/GROVE-RECIPES.md
git commit -m "docs(spec): document live grove recipe run (#276)" --no-verify
```

---

## Task 11: Full suite + typecheck gate

- [ ] **Step 1: Run the full unit suite**

Run: `bun test --timeout 60000 2>&1 | tail -15`
Expected: all green; note the total count. No new failures vs. baseline.

- [ ] **Step 2: Typecheck the whole project**

Run: `tsc --noEmit`
Expected: PASS (clean — this is the pre-push gate).

- [ ] **Step 3: Targeted biome on changed files only**

(Per project note: full-repo biome hangs in worktrees — lint only changed files.)

Run: `bunx biome check --write src/core/recipe-extensions.ts src/cli/utils/launch-session.ts src/cli/commands/recipe.ts src/core/session.ts src/local/sqlite-goal-session-store.ts`
Expected: clean / auto-fixed.

- [ ] **Step 4: Commit any lint fixups**

```bash
git add -A
git commit -m "chore: biome fixups for recipe run (#276)" --no-verify
```

---

## Task 12: Real-process E2E (tmux + real grove + Nexus)

This validates the live path end to end per the project's real-process-E2E rule. It is a script,
not a `bun test` unit; it is run manually (and documented for CI later).

**Files:**
- Create: `tests/e2e/recipe-run-tmux.ts`

- [ ] **Step 1: Study the reference harness**

Read `tests/e2e/watch-relist-tmux.ts` for the established pattern (spawn real `grove` server,
tmux pane orchestration, polling for state). Reuse its setup/teardown helpers.

- [ ] **Step 2: Author the E2E script**

Create `tests/e2e/recipe-run-tmux.ts` that:
1. Creates a fresh temp dir, `git init`, `grove init` (fresh grove dir — per the stale-session
   IPC note, always a fresh dir + git init per run).
2. Starts a real Nexus via `grove up` (grove-managed lifecycle — never `nexus up` directly) and
   exports `GROVE_NEXUS_URL`/`NEXUS_API_KEY`.
3. Writes a 2-role review-loop recipe (coder=claude-code, reviewer=codex or claude) with a
   `stdio:` MCP extension declared.
4. Runs `grove recipe run ./recipe.yaml --param target_path=./src --json` with
   `GROVE_RUNTIME=acpx` and real agents.
5. Asserts: agents spawn (both roles appear), the codex↔claude handoff completes, the session
   in Nexus carries `recipeProvenance.recipeDigest`, and the spawned agent's MCP set includes the
   recipe extension (inspect agent logs under `<groveDir>/agent-logs`).
6. Tears down tmux panes + `grove down`.

- [ ] **Step 3: Run it**

Run: `bun tests/e2e/recipe-run-tmux.ts`
Expected: exits 0 with a summary line confirming spawn + handoff + digest recorded. Capture the
output in the PR description.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/recipe-run-tmux.ts
git commit -m "test(e2e): live recipe run tmux harness (#276)" --no-verify
```

---

## Done criteria

- `grove recipe run <path> --param k=v` (no `--dry-run`) launches a session; agents spawn.
- The session row (SQLite) and Nexus record carry `recipeProvenance.recipeDigest` equal to
  `grove recipe validate <path>` output.
- Declared `stdio:` MCP extensions appear in spawned agents' MCP server list, after `grove`.
- `grove session start` behavior is unchanged (existing suite green; same count).
- `tsc --noEmit` clean; full `bun test` green; targeted biome clean.
- Real-process E2E passes and is captured in the PR.
