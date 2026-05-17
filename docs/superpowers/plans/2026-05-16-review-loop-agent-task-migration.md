# Review-Loop → AgentTask Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route a codex → claude review loop end-to-end through `AgentTask` + `Scheduler`, with a new `grove review-loop` CLI, a `Succeeded` transition, and a server-mediated `/done` endpoint reachable from MCP.

**Architecture:** Strangler-fig on top of PR #439. Add `DoneSignaled` condition; on grove-server, a new `POST /api/agent-tasks/:id/done` route writes the condition; in `TaskController`, `reconcileRunning` advances `DoneSignaled=True → Succeeded`; in `DefaultBind`, each task's prompt is wrapped with its `dependsOn` ancestors' `Succeeded` summaries. MCP `grove_done` POSTs to `/done` when the bound agent has `GROVE_AGENT_TASK_ID` in env. `grove session start` and legacy `contributeOperation` are untouched.

**Tech Stack:** Bun + TypeScript w/ `isolatedDeclarations: true`, `bun:test`, Hono + zod for HTTP routes, tmux for E2E.

**Spec:** `docs/superpowers/specs/2026-05-16-review-loop-agent-task-migration-design.md`

---

## File Structure

**New files**

- `src/core/scheduler/upstream-prompt.ts` — `buildPromptWithUpstream` pure function.
- `src/core/scheduler/upstream-prompt.test.ts`
- `src/mcp/agent-task-context.ts` — env reader.
- `src/mcp/agent-task-context.test.ts`
- `src/mcp/agent-task-done.ts` — `POST /done` helper.
- `src/mcp/agent-task-done.test.ts`
- `src/cli/commands/review-loop.ts` — CLI subcommand handler.
- `src/cli/commands/review-loop.test.ts`
- `tests/e2e/review-loop-codex-claude-tmux.ts` — full tmux E2E.

**Modified files**

- `src/core/agent-task.ts` — add `DoneSignaled` to `AgentTaskConditionType`.
- `src/core/task-controller.ts` — `Succeeded` transition + `sessionToCloseOnSuccess`.
- `src/core/task-controller.test.ts` — tests for new transition + dependency unblocking chain.
- `src/core/scheduler/framework.ts` — broaden `SchedulerContext.store` Pick.
- `src/core/scheduler/plugins/default-bind.ts` — dependency prompt wrapping + env passthrough.
- `src/core/scheduler/plugins/default-bind.test.ts` — tests for wrapping + env vars.
- `src/server/routes/agent-tasks.ts` — `POST /:id/done` route (bearer-authed, before controller-token middleware).
- `src/server/routes/agent-tasks.test.ts` — tests for `/done` route.
- `src/server/serve.ts` — default `GROVE_SERVER_URL` + extract first bearer token to `GROVE_API_TOKEN` before constructing TaskController.
- `src/mcp/tools/done.ts` — call done helper when `GROVE_AGENT_TASK_ID` set.
- `src/mcp/tools/done.test.ts` — tests for done-endpoint branch.
- `src/cli/main.ts` — register `review-loop` subcommand.

---

## Task 1: Add `DoneSignaled` to `AgentTaskConditionType`

**Files:**
- Modify: `src/core/agent-task.ts:15-26`

- [ ] **Step 1: Write the failing test**

Append two cases to `src/core/agent-task.condition-types.test.ts`:

```ts
test("includes DoneSignaled for agent-signaled completion", () => {
  expect(AgentTaskConditionType.DoneSignaled).toBe("DoneSignaled");
});
```

- [ ] **Step 2: Run to verify fail**

`bun test src/core/agent-task.condition-types.test.ts` — expected FAIL on the new case.

- [ ] **Step 3: Add the enum member**

Edit `src/core/agent-task.ts`. The `AgentTaskConditionType` const becomes:

```ts
export const AgentTaskConditionType = {
  Admitted: "Admitted",
  Scheduled: "Scheduled",
  Bound: "Bound",
  Running: "Running",
  AwaitingReview: "AwaitingReview",
  Succeeded: "Succeeded",
  Failed: "Failed",
  Blocked: "Blocked",
  Unschedulable: "Unschedulable",
  PermitRequired: "PermitRequired",
  DoneSignaled: "DoneSignaled",
} as const;
```

- [ ] **Step 4: Run tests to verify pass**

`bun test src/core/agent-task.condition-types.test.ts src/core/agent-task.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-task.ts src/core/agent-task.condition-types.test.ts
git commit -m "feat(core): add DoneSignaled condition type for AgentTask"
```

---

## Task 2: `Succeeded` transition in `TaskController.reconcileRunning`

**Files:**
- Modify: `src/core/task-controller.ts`
- Modify: `src/core/task-controller.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/core/task-controller.test.ts` after the existing `TaskController + Scheduler integration` block (replace the helpers/imports if duplicated; see context):

```ts
describe("TaskController — DoneSignaled → Succeeded", () => {
  function viewWithCondition(
    overrides: { sessionId?: string; doneSummary?: string } = {},
  ): AgentTaskView {
    return taskView({
      phase: AgentTaskPhase.Running,
      sessionId: overrides.sessionId ?? "session-running",
      observedGeneration: 1,
      conditions: overrides.doneSummary === undefined
        ? []
        : [
            makeCondition("DoneSignaled", {
              status: "True",
              reason: "agent-grove-done",
              message: overrides.doneSummary,
            }),
          ],
    });
  }

  test("Running task with DoneSignaled=True transitions to Succeeded", async () => {
    const store = new FakeTaskStore();
    store.seed(viewWithCondition({ doneSummary: "Approved by reviewer." }));
    const runtime = new FakeRuntime();
    runtime.sessions.set("session-running", {
      id: "session-running",
      role: "worker",
      status: "running",
    });
    const controller = controllerFor(store, { runtime });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Succeeded);
    expect(condition(patch.conditions, "Succeeded")?.status).toBe("True");
    expect(condition(patch.conditions, "Succeeded")?.message).toBe("Approved by reviewer.");
    expect(condition(patch.conditions, "Running")?.status).toBe("False");
  });

  test("DoneSignaled takes precedence over session-status-stopped", async () => {
    const store = new FakeTaskStore();
    store.seed(viewWithCondition({ doneSummary: "Done." }));
    // Runtime returns no live session (agent already exited after grove_done)
    const runtime = new FakeRuntime();
    const controller = controllerFor(store, { runtime });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Succeeded);
  });

  test("Running task without DoneSignaled and lost session still fails (back-compat)", async () => {
    const store = new FakeTaskStore();
    store.seed(viewWithCondition({}));
    const runtime = new FakeRuntime();
    const controller = controllerFor(store, { runtime });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Failed);
  });

  test("Succeeded transition closes runtime session", async () => {
    const store = new FakeTaskStore();
    store.seed(viewWithCondition({ doneSummary: "ok" }));
    const runtime = new FakeRuntime();
    const session = {
      id: "session-running",
      role: "worker",
      status: "running" as const,
    };
    runtime.sessions.set(session.id, session);
    const controller = controllerFor(store, { runtime });

    await controller.reconcileTask("task-1");

    expect(runtime.closeCalls).toHaveLength(1);
    expect(runtime.closeCalls[0]?.id).toBe(session.id);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/core/task-controller.test.ts` — expected FAIL on the four new tests (controller still falls through to failLostSession when session gone).

- [ ] **Step 3: Add `sessionToCloseOnSuccess` to ReconciliationResult**

Edit `src/core/task-controller.ts`. Find the `ReconciliationResult` interface and add the new field:

```ts
interface ReconciliationResult {
  readonly patch: AgentTaskStatusPatch;
  readonly transition: AgentTaskStatusTransition;
  readonly sessionToCloseOnPatchFailure?: AgentSession | undefined;
  readonly sessionToCloseOnSuccess?: AgentSession | undefined;
}
```

- [ ] **Step 4: Replace `reconcileRunning` with the DoneSignaled-aware version**

Locate the existing `reconcileRunning` method in `src/core/task-controller.ts` (around line 312-324). Replace its body:

```ts
private async reconcileRunning(task: AgentTaskView): Promise<ReconciliationResult | undefined> {
  if (task.status.sessionId === undefined) {
    return failLostSession(task, this.nowIso());
  }

  const doneCondition = task.status.conditions.find(
    (c) => c.type === AgentTaskConditionType.DoneSignaled && c.status === "True",
  );
  if (doneCondition !== undefined) {
    const sessions = await this.runtime.listSessions();
    const session = sessions.find((s) => s.id === task.status.sessionId);
    return succeedTask(task, doneCondition.message ?? "", this.nowIso(), session);
  }

  const sessions = await this.runtime.listSessions();
  const session = sessions.find((candidate) => candidate.id === task.status.sessionId);
  if (session !== undefined && (session.status === "running" || session.status === "idle")) {
    return runningLiveCatchUp(task, this.nowIso());
  }

  return failLostSession(task, this.nowIso());
}
```

Add this helper at module scope alongside `failLostSession` (after `runningLiveCatchUp`):

```ts
function succeedTask(
  task: AgentTaskView,
  summary: string,
  nowIso: string,
  session: AgentSession | undefined,
): ReconciliationResult {
  const conditions = upsertCondition(
    upsertCondition(task.status.conditions, {
      type: AgentTaskConditionType.Running,
      status: "False",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "done-signaled",
      message: "",
    }),
    {
      type: AgentTaskConditionType.Succeeded,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: "done-signaled",
      message: summary,
    },
  );
  return {
    patch: {
      phase: AgentTaskPhase.Succeeded,
      observedGeneration: task.spec.generation,
      conditions,
      lastTransitionAt: nowIso,
    },
    transition: transition(task, AgentTaskPhase.Succeeded, "done-signaled"),
    ...(session === undefined ? {} : { sessionToCloseOnSuccess: session }),
  };
}
```

- [ ] **Step 5: Honor `sessionToCloseOnSuccess` in `reconcileTask`**

Locate `reconcileTask` (around line 136). After the successful `patchAgentTaskStatus` call (post-`onTransition?.(result.transition)`), close the session if requested. Replace the `try { await this.taskStore.patchAgentTaskStatus(taskId, result.patch); } catch ...` block with:

```ts
try {
  await this.taskStore.patchAgentTaskStatus(taskId, result.patch);
} catch (error) {
  if (result.sessionToCloseOnPatchFailure !== undefined) {
    await this.closeAfterPatchFailure(result.sessionToCloseOnPatchFailure);
  }
  throw error;
}
this.onTransition?.(result.transition);
if (result.sessionToCloseOnSuccess !== undefined) {
  await this.closeAfterPatchFailure(result.sessionToCloseOnSuccess);
}
return result.transition;
```

(`closeAfterPatchFailure` is already a swallow-all helper around `runtime.close`; reusing it gives us the right error-tolerance semantics.)

- [ ] **Step 6: Run tests to verify pass**

`bun test src/core/task-controller.test.ts` — expected PASS (existing + 4 new).

- [ ] **Step 7: Commit**

```bash
git add src/core/task-controller.ts src/core/task-controller.test.ts
git commit -m "feat(task-controller): Succeeded transition on DoneSignaled condition"
```

---

## Task 3: Create `upstream-prompt.ts` pure function

**Files:**
- Create: `src/core/scheduler/upstream-prompt.ts`
- Create: `src/core/scheduler/upstream-prompt.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/scheduler/upstream-prompt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildPromptWithUpstream, type UpstreamSection } from "./upstream-prompt.js";

describe("buildPromptWithUpstream", () => {
  test("returns base prompt unchanged when no upstream sections", () => {
    expect(buildPromptWithUpstream("do work", [])).toBe("do work");
  });

  test("wraps base prompt with single upstream section", () => {
    const sections: UpstreamSection[] = [{ taskId: "coder-1", summary: "Implemented X." }];
    const out = buildPromptWithUpstream("Review my changes.", sections);
    expect(out).toContain("## Upstream output");
    expect(out).toContain("### coder-1 (succeeded)");
    expect(out).toContain("Implemented X.");
    expect(out).toContain("## Your task");
    expect(out).toContain("Review my changes.");
  });

  test("concatenates multiple sections in order", () => {
    const sections: UpstreamSection[] = [
      { taskId: "a", summary: "first" },
      { taskId: "b", summary: "second" },
    ];
    const out = buildPromptWithUpstream("base", sections);
    const aIdx = out.indexOf("### a (succeeded)");
    const bIdx = out.indexOf("### b (succeeded)");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("substitutes '(no summary)' when summary is empty", () => {
    const sections: UpstreamSection[] = [{ taskId: "a", summary: "" }];
    const out = buildPromptWithUpstream("base", sections);
    expect(out).toContain("(no summary)");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/core/scheduler/upstream-prompt.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/core/scheduler/upstream-prompt.ts`:

```ts
export interface UpstreamSection {
  readonly taskId: string;
  readonly summary: string;
}

export function buildPromptWithUpstream(
  basePrompt: string,
  sections: readonly UpstreamSection[],
): string {
  if (sections.length === 0) return basePrompt;
  const blocks = sections.map(
    (s) => `### ${s.taskId} (succeeded)\n${s.summary.length > 0 ? s.summary : "(no summary)"}`,
  );
  return `## Upstream output\n\n${blocks.join("\n\n")}\n\n## Your task\n\n${basePrompt}`;
}
```

- [ ] **Step 4: Run tests**

`bun test src/core/scheduler/upstream-prompt.test.ts` — expected PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/upstream-prompt.ts src/core/scheduler/upstream-prompt.test.ts
git commit -m "feat(scheduler): upstream-prompt builder for dependency context"
```

---

## Task 4: Broaden `SchedulerContext.store` Pick to include `getAgentTask`

**Files:**
- Modify: `src/core/scheduler/framework.ts`

- [ ] **Step 1: Edit the type**

Open `src/core/scheduler/framework.ts`. Locate the `SchedulerContext` interface. Change the `store` field from:

```ts
readonly store: Pick<AgentTaskStore, "listAgentTaskEntities">;
```

to:

```ts
readonly store: Pick<AgentTaskStore, "listAgentTaskEntities" | "getAgentTask">;
```

- [ ] **Step 2: Run tests to confirm no breakage**

`bun test src/core/scheduler/` — expected PASS. Existing tests pass `AgentTaskStore` instances that already satisfy the wider Pick (any test using a fake-store-with-only-listAgentTaskEntities will now fail — fix by adding a stub `getAgentTask`).

- [ ] **Step 3: Fix any failing tests by adding `getAgentTask` stub**

For each failing test, locate the inline `store: { listAgentTaskEntities: async () => [] }` literal and add:

```ts
store: {
  listAgentTaskEntities: async () => [],
  getAgentTask: async () => undefined,
}
```

Affected files (search and patch each):
- `src/core/scheduler/scheduler.test.ts`
- `src/core/scheduler/plugins/runtime-capability.test.ts`
- `src/core/scheduler/plugins/budget-remaining.test.ts`
- `src/core/scheduler/plugins/task-affinity.test.ts`
- `src/core/scheduler/plugins/auto-permit.test.ts`
- `src/core/scheduler/plugins/user-confirm-permit.test.ts`
- `src/core/scheduler/plugins/default-bind.test.ts`
- `src/core/scheduler/plugins/worktree-exclusivity.test.ts`
- `src/core/scheduler/acceptance-config-reweight.test.ts`

Run `bun test src/core/scheduler/` after each batch until green.

- [ ] **Step 4: Commit**

```bash
git add src/core/scheduler/
git commit -m "refactor(scheduler): broaden SchedulerContext.store Pick to include getAgentTask"
```

---

## Task 5: `DefaultBind` reads dependencies + wraps prompt

**Files:**
- Modify: `src/core/scheduler/plugins/default-bind.ts`
- Modify: `src/core/scheduler/plugins/default-bind.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/core/scheduler/plugins/default-bind.test.ts`:

```ts
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskConditionType } from "../../agent-task.js";

function makeView(id: string, doneSummary: string): AgentTaskView {
  return {
    spec: {
      id,
      worktree: "/tmp/w",
      runtime: "codex",
      role: "coder",
      prompt: "x",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id,
      phase: AgentTaskPhase.Succeeded,
      contributions: [],
      conditions: [
        {
          type: AgentTaskConditionType.Succeeded,
          status: "True",
          observedGeneration: 1,
          lastTransitionTime: "2026-05-16T00:00:00.000Z",
          reason: "done-signaled",
          message: doneSummary,
        },
      ],
      observedGeneration: 1,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 2,
    },
  };
}

describe("DefaultBindPlugin — dependency prompt wrapping", () => {
  test("dependsOn=[] leaves prompt unchanged", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const task = taskWith({ prompt: "base prompt", dependsOn: [] });
    const ctx: SchedulerContext = {
      task,
      profiles: [],
      store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
      now: () => 0,
    };
    await plugin.bind(ctx, profile);
    expect(runtime.spawnCalls[0]?.config.prompt).toBe("base prompt");
  });

  test("dependsOn with Succeeded dependency wraps prompt", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const task = taskWith({ prompt: "review my changes", dependsOn: ["coder-1"] });
    const ctx: SchedulerContext = {
      task,
      profiles: [],
      store: {
        listAgentTaskEntities: async () => [],
        getAgentTask: async (id) => (id === "coder-1" ? makeView("coder-1", "Implemented X") : undefined),
      },
      now: () => 0,
    };
    await plugin.bind(ctx, profile);
    const prompt = runtime.spawnCalls[0]?.config.prompt ?? "";
    expect(prompt).toContain("## Upstream output");
    expect(prompt).toContain("### coder-1 (succeeded)");
    expect(prompt).toContain("Implemented X");
    expect(prompt).toContain("## Your task");
    expect(prompt).toContain("review my changes");
  });

  test("dependsOn with multiple deps preserves declaration order", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const task = taskWith({ prompt: "base", dependsOn: ["a", "b"] });
    const ctx: SchedulerContext = {
      task,
      profiles: [],
      store: {
        listAgentTaskEntities: async () => [],
        getAgentTask: async (id) => makeView(id, `summary-${id}`),
      },
      now: () => 0,
    };
    await plugin.bind(ctx, profile);
    const prompt = runtime.spawnCalls[0]?.config.prompt ?? "";
    const aIdx = prompt.indexOf("### a (succeeded)");
    const bIdx = prompt.indexOf("### b (succeeded)");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("missing dependency view falls back to '(no summary)'", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const task = taskWith({ prompt: "x", dependsOn: ["ghost"] });
    const ctx: SchedulerContext = {
      task,
      profiles: [],
      store: {
        listAgentTaskEntities: async () => [],
        getAgentTask: async () => undefined,
      },
      now: () => 0,
    };
    await plugin.bind(ctx, profile);
    const prompt = runtime.spawnCalls[0]?.config.prompt ?? "";
    expect(prompt).toContain("(no summary)");
  });
});
```

(`taskWith`, `profile`, `FakeRuntime` are already defined earlier in the file.)

- [ ] **Step 2: Run to confirm fail**

`bun test src/core/scheduler/plugins/default-bind.test.ts` — expected FAIL on the 4 new tests.

- [ ] **Step 3: Update `DefaultBind.bind`**

Edit `src/core/scheduler/plugins/default-bind.ts`. Import the upstream prompt helper at the top:

```ts
import { buildPromptWithUpstream, type UpstreamSection } from "../upstream-prompt.js";
```

Replace the body of `bind` so it gathers dependency summaries and wraps the prompt:

```ts
async bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult> {
  const upstreamSections: UpstreamSection[] = [];
  for (const depId of ctx.task.spec.dependsOn) {
    const dep = await ctx.store.getAgentTask(depId);
    const succeeded = dep?.status.conditions.find(
      (c) => c.type === "Succeeded" && c.status === "True",
    );
    upstreamSections.push({ taskId: depId, summary: succeeded?.message ?? "" });
  }
  const wrappedPrompt = buildPromptWithUpstream(ctx.task.spec.prompt, upstreamSections);

  const model = profile.model ?? readBudgetString(ctx.task.spec.budget, "model");
  const config: AgentConfig = {
    role: ctx.task.spec.role,
    command: profile.runtimeCommand,
    cwd: ctx.task.spec.worktree,
    goal: ctx.task.spec.prompt,
    prompt: wrappedPrompt,
    ...(profile.platform === undefined ? {} : { platform: profile.platform }),
    ...(model === undefined ? {} : { model }),
    env: {
      GROVE_AGENT_TASK_ID: ctx.task.spec.id,
      GROVE_AGENT_TASK_GENERATION: String(ctx.task.spec.generation),
      GROVE_AGENT_TASK_RUNTIME: profile.runtimeCommand,
    },
  };
  const session = await this.runtime.spawn(ctx.task.spec.role, config);
  return { session };
}
```

- [ ] **Step 4: Run tests**

`bun test src/core/scheduler/plugins/default-bind.test.ts` — expected PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/default-bind.ts src/core/scheduler/plugins/default-bind.test.ts
git commit -m "feat(scheduler): DefaultBind wraps prompt with dependency Succeeded summaries"
```

---

## Task 6: `DefaultBind` passes through `GROVE_SERVER_URL` + `GROVE_API_TOKEN` env

**Files:**
- Modify: `src/core/scheduler/plugins/default-bind.ts`
- Modify: `src/core/scheduler/plugins/default-bind.test.ts`

- [ ] **Step 1: Append failing test**

Append to `src/core/scheduler/plugins/default-bind.test.ts`:

```ts
describe("DefaultBindPlugin — env passthrough for AgentTask done", () => {
  test("forwards GROVE_SERVER_URL and GROVE_API_TOKEN when set in process env", async () => {
    const originalUrl = process.env.GROVE_SERVER_URL;
    const originalToken = process.env.GROVE_API_TOKEN;
    process.env.GROVE_SERVER_URL = "http://localhost:4515";
    process.env.GROVE_API_TOKEN = "test-token-123";
    try {
      const runtime = new FakeRuntime();
      const plugin = new DefaultBindPlugin({ runtime });
      const task = taskWith({});
      const ctx: SchedulerContext = {
        task,
        profiles: [],
        store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
        now: () => 0,
      };
      await plugin.bind(ctx, profile);
      const env = runtime.spawnCalls[0]?.config.env ?? {};
      expect(env.GROVE_SERVER_URL).toBe("http://localhost:4515");
      expect(env.GROVE_API_TOKEN).toBe("test-token-123");
    } finally {
      if (originalUrl === undefined) delete process.env.GROVE_SERVER_URL;
      else process.env.GROVE_SERVER_URL = originalUrl;
      if (originalToken === undefined) delete process.env.GROVE_API_TOKEN;
      else process.env.GROVE_API_TOKEN = originalToken;
    }
  });

  test("omits GROVE_SERVER_URL / GROVE_API_TOKEN when unset in process env", async () => {
    const originalUrl = process.env.GROVE_SERVER_URL;
    const originalToken = process.env.GROVE_API_TOKEN;
    delete process.env.GROVE_SERVER_URL;
    delete process.env.GROVE_API_TOKEN;
    try {
      const runtime = new FakeRuntime();
      const plugin = new DefaultBindPlugin({ runtime });
      const task = taskWith({});
      const ctx: SchedulerContext = {
        task,
        profiles: [],
        store: { listAgentTaskEntities: async () => [], getAgentTask: async () => undefined },
        now: () => 0,
      };
      await plugin.bind(ctx, profile);
      const env = runtime.spawnCalls[0]?.config.env ?? {};
      expect(env.GROVE_SERVER_URL).toBeUndefined();
      expect(env.GROVE_API_TOKEN).toBeUndefined();
    } finally {
      if (originalUrl !== undefined) process.env.GROVE_SERVER_URL = originalUrl;
      if (originalToken !== undefined) process.env.GROVE_API_TOKEN = originalToken;
    }
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/core/scheduler/plugins/default-bind.test.ts` — expected FAIL.

- [ ] **Step 3: Add env passthrough**

In `src/core/scheduler/plugins/default-bind.ts`, modify the `env:` block inside the `AgentConfig` object literal:

```ts
env: {
  GROVE_AGENT_TASK_ID: ctx.task.spec.id,
  GROVE_AGENT_TASK_GENERATION: String(ctx.task.spec.generation),
  GROVE_AGENT_TASK_RUNTIME: profile.runtimeCommand,
  ...(process.env.GROVE_SERVER_URL === undefined ? {} : { GROVE_SERVER_URL: process.env.GROVE_SERVER_URL }),
  ...(process.env.GROVE_API_TOKEN === undefined ? {} : { GROVE_API_TOKEN: process.env.GROVE_API_TOKEN }),
},
```

- [ ] **Step 4: Run tests**

`bun test src/core/scheduler/plugins/default-bind.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/default-bind.ts src/core/scheduler/plugins/default-bind.test.ts
git commit -m "feat(scheduler): DefaultBind forwards GROVE_SERVER_URL+GROVE_API_TOKEN to agent env"
```

---

## Task 7: `POST /api/agent-tasks/:id/done` route

**Files:**
- Modify: `src/server/routes/agent-tasks.ts`
- Modify: `src/server/routes/agent-tasks.test.ts`

- [ ] **Step 1: Read the existing route file**

Open `src/server/routes/agent-tasks.ts`. Locate where `requireControllerToken` is applied (currently used on the `PATCH /:id/status` route at line ~270 — verify exact line). The new `POST /:id/done` route must be registered BEFORE any `agentTasks.use(requireControllerToken, ...)` group, or registered with explicit bearer-only middleware.

In current code, `requireControllerToken` is applied per-route via wrapper rather than as a group middleware. Verify by reading the file. If per-route, the new route inherits no controller-token requirement by default — which is what we want.

- [ ] **Step 2: Write failing test**

Append to `src/server/routes/agent-tasks.test.ts`:

```ts
describe("POST /api/agent-tasks/:id/done", () => {
  test("writes DoneSignaled condition with summary", async () => {
    const { app, store } = await createTestApp();
    await store.putAgentTaskSpec({
      id: "task-x",
      worktree: "/tmp/w",
      runtime: "codex",
      role: "coder",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    });

    const res = await app.request("/api/agent-tasks/task-x/done", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ summary: "Approved." }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.taskId).toBe("task-x");

    const updated = await store.getAgentTask("task-x");
    const done = updated?.status.conditions.find((c) => c.type === "DoneSignaled");
    expect(done?.status).toBe("True");
    expect(done?.message).toBe("Approved.");
    expect(done?.reason).toBe("agent-grove-done");
  });

  test("returns 404 for unknown task", async () => {
    const { app } = await createTestApp();
    const res = await app.request("/api/agent-tasks/missing/done", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ summary: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("does NOT require X-Grove-Controller-Token (bearer-only)", async () => {
    const { app, store } = await createTestApp();
    await store.putAgentTaskSpec({
      id: "task-y",
      worktree: "/tmp/w",
      runtime: "codex",
      role: "coder",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    });

    const res = await app.request("/api/agent-tasks/task-y/done", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      // no X-Grove-Controller-Token header
      body: JSON.stringify({ summary: "done" }),
    });
    expect(res.status).toBe(200);
  });
});
```

(Use `createTestApp` if already defined in the test file; otherwise reuse the helper pattern already used by existing tests in the file. Inspect the file first.)

- [ ] **Step 3: Run to confirm fail**

`bun test src/server/routes/agent-tasks.test.ts` — expected FAIL (route undefined).

- [ ] **Step 4: Add the route**

Edit `src/server/routes/agent-tasks.ts`. Locate where existing routes are registered. Add this BEFORE the `PATCH /:id/status` registration (so the bearer-only `/done` is matched first):

```ts
agentTasks.post(
  "/:id/done",
  zValidator("json", z.object({ summary: z.string().max(2000) }).strict()),
  async (c) => {
    const deps = c.get("deps");
    const taskId = c.req.param("id");
    const body = c.req.valid("json" as never) as { summary: string };
    const store = deps.agentTaskStore;
    if (store === undefined) throw new Error("AgentTask store middleware did not run");

    const current = await store.getAgentTask(taskId);
    if (current === undefined) {
      return c.json({ error: { code: "NOT_FOUND", message: `task '${taskId}' not found` } }, 404);
    }

    const nowIso = new Date().toISOString();
    const condition: Condition = {
      type: AgentTaskConditionType.DoneSignaled,
      status: "True",
      observedGeneration: current.spec.generation,
      lastTransitionTime: nowIso,
      reason: "agent-grove-done",
      message: body.summary,
    };
    const nextConditions = upsertCondition(current.status.conditions, condition);

    const result = await store.patchAgentTaskStatus(taskId, {
      conditions: nextConditions,
      observedGeneration: current.spec.generation,
    });
    if (result.kind === "rv-mismatch") {
      const refreshed = await store.getAgentTask(taskId);
      if (refreshed === undefined) {
        return c.json({ error: { code: "NOT_FOUND", message: "task disappeared" } }, 404);
      }
      const retried = await store.patchAgentTaskStatus(taskId, {
        conditions: upsertCondition(refreshed.status.conditions, {
          ...condition,
          observedGeneration: refreshed.spec.generation,
        }),
        observedGeneration: refreshed.spec.generation,
      });
      if (retried.kind === "rv-mismatch") {
        return c.json({ error: { code: "CONFLICT", message: "concurrent update" } }, 409);
      }
    }
    return c.json({ ok: true, taskId, condition: "DoneSignaled" });
  },
);
```

Required imports (add to the existing import block at the top of the file):

```ts
import { AgentTaskConditionType } from "../../core/agent-task.js";
import type { Condition } from "../../core/entity.js";
import { upsertCondition } from "../../core/condition-utils.js";
```

If `upsertCondition` is not yet exported from a shared module, copy the implementation from `src/core/task-controller.ts`. Check first:

```bash
grep -n "export function upsertCondition" src/core/
```

If absent, in this same task:
1. Create `src/core/condition-utils.ts` exporting `upsertCondition` (extract from task-controller.ts).
2. Update task-controller.ts to import from `./condition-utils.js` instead of the local copy.
3. Add a tiny test `src/core/condition-utils.test.ts` exercising upsert behavior.

- [ ] **Step 5: Run tests**

`bun test src/server/routes/agent-tasks.test.ts src/core/task-controller.test.ts` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/agent-tasks.ts src/server/routes/agent-tasks.test.ts src/core/condition-utils.ts src/core/condition-utils.test.ts src/core/task-controller.ts
git commit -m "feat(server): POST /api/agent-tasks/:id/done bearer-authed endpoint"
```

---

## Task 8: `serve.ts` exports `GROVE_SERVER_URL` and `GROVE_API_TOKEN`

**Files:**
- Modify: `src/server/serve.ts`

- [ ] **Step 1: Locate setup**

Open `src/server/serve.ts`. Find the early environment-setup block (after `PORT` is parsed). Identify where `GROVE_DIR`, `PORT`, etc. are set.

- [ ] **Step 2: Add defaults**

Immediately after `const PORT = parsePort(process.env.PORT, 4515);` (around line 55), add:

```ts
// Defaults for env that downstream agents inherit. DefaultBind forwards both to
// MCP so grove_done can POST /api/agent-tasks/:id/done.
if (process.env.GROVE_SERVER_URL === undefined) {
  process.env.GROVE_SERVER_URL = `http://${HOST ?? "localhost"}:${PORT}`;
}
```

For `GROVE_API_TOKEN`: it must be a valid bearer token. The existing setup reads `server-keys.yaml` later in the file. Add right after the `loadKeyRegistry` call (around line 152) — locate `const rawRegistry = loadKeyRegistry(...)`:

```ts
if (process.env.GROVE_API_TOKEN === undefined) {
  const firstToken = Object.keys(rawRegistry.keys)[0];
  if (firstToken !== undefined) {
    process.env.GROVE_API_TOKEN = firstToken;
  }
}
```

If `rawRegistry` is empty (no keys yet), leave `GROVE_API_TOKEN` undefined — the agent will see a clear error when `grove_done` runs.

- [ ] **Step 3: Smoke check**

Add no new tests for serve.ts (it's process-level, excluded from coverage per file header). Just verify the file still compiles:

`bun run -e 'import("./src/server/serve.ts")'` — should fail at runtime (no listen) but not at type-check. Alternative: just rely on the E2E in Task 16.

Run `bun test src/server/` — confirm no existing tests break.

- [ ] **Step 4: Commit**

```bash
git add src/server/serve.ts
git commit -m "feat(server): default GROVE_SERVER_URL + extract GROVE_API_TOKEN for agent inherit"
```

---

## Task 9: `src/mcp/agent-task-context.ts` env reader

**Files:**
- Create: `src/mcp/agent-task-context.ts`
- Create: `src/mcp/agent-task-context.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/mcp/agent-task-context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readAgentTaskContext } from "./agent-task-context.js";

describe("readAgentTaskContext", () => {
  test("returns context when both env vars set", () => {
    const ctx = readAgentTaskContext({
      GROVE_AGENT_TASK_ID: "task-1",
      GROVE_AGENT_TASK_GENERATION: "3",
    });
    expect(ctx).toEqual({ taskId: "task-1", generation: 3 });
  });

  test("returns undefined when taskId missing", () => {
    const ctx = readAgentTaskContext({ GROVE_AGENT_TASK_GENERATION: "1" });
    expect(ctx).toBeUndefined();
  });

  test("returns undefined when generation missing", () => {
    const ctx = readAgentTaskContext({ GROVE_AGENT_TASK_ID: "x" });
    expect(ctx).toBeUndefined();
  });

  test("returns undefined when generation is non-numeric", () => {
    const ctx = readAgentTaskContext({
      GROVE_AGENT_TASK_ID: "x",
      GROVE_AGENT_TASK_GENERATION: "abc",
    });
    expect(ctx).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/mcp/agent-task-context.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

Create `src/mcp/agent-task-context.ts`:

```ts
export interface AgentTaskContext {
  readonly taskId: string;
  readonly generation: number;
}

export function readAgentTaskContext(
  env: Readonly<Record<string, string | undefined>>,
): AgentTaskContext | undefined {
  const taskId = env.GROVE_AGENT_TASK_ID;
  const gen = env.GROVE_AGENT_TASK_GENERATION;
  if (taskId === undefined || gen === undefined) return undefined;
  const generation = Number.parseInt(gen, 10);
  if (!Number.isFinite(generation)) return undefined;
  return { taskId, generation };
}
```

- [ ] **Step 4: Run tests**

`bun test src/mcp/agent-task-context.test.ts` — expected PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/agent-task-context.ts src/mcp/agent-task-context.test.ts
git commit -m "feat(mcp): agent-task-context env reader"
```

---

## Task 10: `src/mcp/agent-task-done.ts` POST helper

**Files:**
- Create: `src/mcp/agent-task-done.ts`
- Create: `src/mcp/agent-task-done.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/mcp/agent-task-done.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { signalAgentTaskDone } from "./agent-task-done.js";

describe("signalAgentTaskDone", () => {
  test("POSTs to /api/agent-tasks/:id/done with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await signalAgentTaskDone(
      { taskId: "task-x", generation: 1 },
      "review approved",
      {
        baseUrl: "http://localhost:4515",
        token: "abc123",
        fetchImpl: fakeFetch,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:4515/api/agent-tasks/task-x/done");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer abc123");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ summary: "review approved" }));
  });

  test("throws when baseUrl missing", async () => {
    await expect(
      signalAgentTaskDone({ taskId: "x", generation: 1 }, "s", {
        baseUrl: undefined,
        token: "t",
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/GROVE_SERVER_URL/);
  });

  test("throws when token missing", async () => {
    await expect(
      signalAgentTaskDone({ taskId: "x", generation: 1 }, "s", {
        baseUrl: "http://x",
        token: undefined,
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/GROVE_API_TOKEN/);
  });

  test("throws on non-2xx response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not found", { status: 404 });
    await expect(
      signalAgentTaskDone({ taskId: "x", generation: 1 }, "s", {
        baseUrl: "http://x",
        token: "t",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/404/);
  });

  test("encodes taskId for URL safety", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    await signalAgentTaskDone({ taskId: "task/with/slashes", generation: 1 }, "s", {
      baseUrl: "http://x",
      token: "t",
      fetchImpl: fakeFetch,
    });
    expect(calls[0]).toBe("http://x/api/agent-tasks/task%2Fwith%2Fslashes/done");
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/mcp/agent-task-done.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

Create `src/mcp/agent-task-done.ts`:

```ts
import type { AgentTaskContext } from "./agent-task-context.js";

export interface SignalAgentTaskDoneOptions {
  readonly baseUrl: string | undefined;
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export async function signalAgentTaskDone(
  ctx: AgentTaskContext,
  summary: string,
  options: SignalAgentTaskDoneOptions,
): Promise<void> {
  if (options.baseUrl === undefined || options.baseUrl.length === 0) {
    throw new Error("GROVE_SERVER_URL not set; cannot signal AgentTask done");
  }
  if (options.token === undefined || options.token.length === 0) {
    throw new Error("GROVE_API_TOKEN not set; cannot signal AgentTask done");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl}/api/agent-tasks/${encodeURIComponent(ctx.taskId)}/done`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ summary }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /done returned ${res.status}: ${text}`);
  }
}
```

- [ ] **Step 4: Run tests**

`bun test src/mcp/agent-task-done.test.ts` — expected PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/agent-task-done.ts src/mcp/agent-task-done.test.ts
git commit -m "feat(mcp): signalAgentTaskDone POST helper"
```

---

## Task 11: Wire `grove_done` to call the done helper

**Files:**
- Modify: `src/mcp/tools/done.ts`
- Modify: `src/mcp/tools/done.test.ts`

- [ ] **Step 1: Read existing test file**

Open `src/mcp/tools/done.test.ts` to understand its existing structure. Most likely uses `McpServer` test harness + a fake `contributeOperation`.

- [ ] **Step 2: Append failing tests**

Append to `src/mcp/tools/done.test.ts`:

```ts
describe("grove_done — AgentTask bridge", () => {
  test("when GROVE_AGENT_TASK_ID set, POSTs /done before contributeOperation", async () => {
    const order: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      order.push(`fetch ${String(input)}`);
      return new Response("{}", { status: 200 });
    };
    const originalEnv = {
      taskId: process.env.GROVE_AGENT_TASK_ID,
      gen: process.env.GROVE_AGENT_TASK_GENERATION,
      url: process.env.GROVE_SERVER_URL,
      token: process.env.GROVE_API_TOKEN,
    };
    process.env.GROVE_AGENT_TASK_ID = "task-1";
    process.env.GROVE_AGENT_TASK_GENERATION = "1";
    process.env.GROVE_SERVER_URL = "http://localhost:4515";
    process.env.GROVE_API_TOKEN = "tok";
    try {
      // Construct a test MCP server with stub deps; invoke grove_done.
      // (See existing test patterns in this file for the harness setup.)
      const result = await invokeDoneTool({
        summary: "looks good",
        fetchImpl: fakeFetch,
        contributeSpy: (call) => order.push(`contribute ${call.summary}`),
      });
      expect(order[0]).toBe("fetch http://localhost:4515/api/agent-tasks/task-1/done");
      expect(order[1]).toBe("contribute [DONE] looks good");
      expect(result.isError).toBeUndefined();
    } finally {
      // restore env
      if (originalEnv.taskId === undefined) delete process.env.GROVE_AGENT_TASK_ID;
      else process.env.GROVE_AGENT_TASK_ID = originalEnv.taskId;
      if (originalEnv.gen === undefined) delete process.env.GROVE_AGENT_TASK_GENERATION;
      else process.env.GROVE_AGENT_TASK_GENERATION = originalEnv.gen;
      if (originalEnv.url === undefined) delete process.env.GROVE_SERVER_URL;
      else process.env.GROVE_SERVER_URL = originalEnv.url;
      if (originalEnv.token === undefined) delete process.env.GROVE_API_TOKEN;
      else process.env.GROVE_API_TOKEN = originalEnv.token;
    }
  });

  test("when env vars absent, skips POST and only writes contribution (back-compat)", async () => {
    const originalEnv = process.env.GROVE_AGENT_TASK_ID;
    delete process.env.GROVE_AGENT_TASK_ID;
    try {
      const order: string[] = [];
      const result = await invokeDoneTool({
        summary: "no task",
        fetchImpl: async () => {
          order.push("fetch");
          return new Response("{}", { status: 200 });
        },
        contributeSpy: (call) => order.push(`contribute ${call.summary}`),
      });
      expect(order).toEqual(["contribute [DONE] no task"]); // no fetch
      expect(result.isError).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) process.env.GROVE_AGENT_TASK_ID = originalEnv;
    }
  });

  test("POST failure logs warning but still writes contribution", async () => {
    const originalEnv = {
      taskId: process.env.GROVE_AGENT_TASK_ID,
      gen: process.env.GROVE_AGENT_TASK_GENERATION,
      url: process.env.GROVE_SERVER_URL,
      token: process.env.GROVE_API_TOKEN,
    };
    process.env.GROVE_AGENT_TASK_ID = "task-1";
    process.env.GROVE_AGENT_TASK_GENERATION = "1";
    process.env.GROVE_SERVER_URL = "http://localhost:4515";
    process.env.GROVE_API_TOKEN = "tok";
    try {
      const contributed: string[] = [];
      const result = await invokeDoneTool({
        summary: "x",
        fetchImpl: async () => new Response("err", { status: 500 }),
        contributeSpy: (call) => contributed.push(call.summary),
      });
      expect(contributed).toEqual(["[DONE] x"]);
      expect(result.isError).toBeUndefined();
    } finally {
      if (originalEnv.taskId === undefined) delete process.env.GROVE_AGENT_TASK_ID;
      else process.env.GROVE_AGENT_TASK_ID = originalEnv.taskId;
      if (originalEnv.gen === undefined) delete process.env.GROVE_AGENT_TASK_GENERATION;
      else process.env.GROVE_AGENT_TASK_GENERATION = originalEnv.gen;
      if (originalEnv.url === undefined) delete process.env.GROVE_SERVER_URL;
      else process.env.GROVE_SERVER_URL = originalEnv.url;
      if (originalEnv.token === undefined) delete process.env.GROVE_API_TOKEN;
      else process.env.GROVE_API_TOKEN = originalEnv.token;
    }
  });
});

// Test harness — adapt to match existing patterns. If existing tests use a different
// harness, refactor these to match.
async function invokeDoneTool(opts: {
  readonly summary: string;
  readonly fetchImpl: typeof fetch;
  readonly contributeSpy: (call: { readonly summary: string }) => void;
}): Promise<{ isError?: boolean }> {
  // Build minimal McpDeps with a contributeOperation stub.
  // ... (see McpDeps shape in src/mcp/deps.ts; use a stub operationDeps that
  //      records contribute calls via contributeSpy)
  throw new Error("implement using existing McpDeps test pattern");
}
```

NOTE: the `invokeDoneTool` harness is intentionally pseudo-code — adapt to the test pattern already used in `src/mcp/tools/done.test.ts`. Read the existing file first to see how it constructs `McpDeps` and invokes the registered tool callback. Use that same pattern. Inject `fetch` either via a deps field or `globalThis.fetch` mock.

- [ ] **Step 3: Run to confirm fail**

`bun test src/mcp/tools/done.test.ts` — expected FAIL.

- [ ] **Step 4: Update `done.ts`**

Edit `src/mcp/tools/done.ts`. Add imports at the top:

```ts
import { readAgentTaskContext } from "../agent-task-context.js";
import { signalAgentTaskDone } from "../agent-task-done.js";
```

Inside the `async (args) => { ... }` handler, BEFORE the `contributeOperation` call, add:

```ts
const taskCtx = readAgentTaskContext(process.env);
if (taskCtx !== undefined) {
  try {
    await signalAgentTaskDone(taskCtx, args.summary, {
      baseUrl: process.env.GROVE_SERVER_URL,
      token: process.env.GROVE_API_TOKEN,
    });
  } catch (err) {
    process.stderr.write(
      `[grove-done] task=${taskCtx.taskId} POST /done failed (${err instanceof Error ? err.message : String(err)}); contribution write proceeding\n`,
    );
  }
}
```

The existing `contributeOperation` call follows unchanged.

- [ ] **Step 5: Run tests**

`bun test src/mcp/tools/done.test.ts` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/done.ts src/mcp/tools/done.test.ts
git commit -m "feat(mcp): grove_done signals AgentTask done before writing contribution"
```

---

## Task 12: `grove review-loop start` CLI — args + workspace + POST coder

**Files:**
- Create: `src/cli/commands/review-loop.ts`
- Create: `src/cli/commands/review-loop.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/cli/commands/review-loop.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReviewLoopStartArgs, type ReviewLoopStartArgs } from "./review-loop.js";

describe("parseReviewLoopStartArgs", () => {
  test("requires --goal", () => {
    expect(() => parseReviewLoopStartArgs([])).toThrow(/--goal/);
  });

  test("returns parsed args with defaults", () => {
    const args = parseReviewLoopStartArgs(["--goal", "Build feature X"]);
    expect(args).toEqual({
      goal: "Build feature X",
      coder: "codex",
      reviewer: "claude",
      watch: false,
      groveUrl: "http://localhost:4515",
      timeoutSec: 600,
    } satisfies ReviewLoopStartArgs);
  });

  test("honors all flags", () => {
    const args = parseReviewLoopStartArgs([
      "--goal", "X",
      "--coder", "codex-cli",
      "--reviewer", "claude-code",
      "--watch",
      "--grove-url", "http://example:9999",
      "--timeout", "120",
    ]);
    expect(args.coder).toBe("codex-cli");
    expect(args.reviewer).toBe("claude-code");
    expect(args.watch).toBe(true);
    expect(args.groveUrl).toBe("http://example:9999");
    expect(args.timeoutSec).toBe(120);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/cli/commands/review-loop.test.ts` — expected FAIL.

- [ ] **Step 3: Implement skeleton**

Create `src/cli/commands/review-loop.ts`:

```ts
import { parseArgs } from "node:util";

export interface ReviewLoopStartArgs {
  readonly goal: string;
  readonly coder: string;
  readonly reviewer: string;
  readonly watch: boolean;
  readonly groveUrl: string;
  readonly timeoutSec: number;
}

export function parseReviewLoopStartArgs(args: readonly string[]): ReviewLoopStartArgs {
  const { values } = parseArgs({
    args: [...args],
    options: {
      goal: { type: "string" },
      coder: { type: "string", default: "codex" },
      reviewer: { type: "string", default: "claude" },
      watch: { type: "boolean", default: false },
      "grove-url": { type: "string", default: "http://localhost:4515" },
      timeout: { type: "string", default: "600" },
    },
    strict: false,
  });
  const goal = values.goal as string | undefined;
  if (goal === undefined || goal.length === 0) {
    throw new Error("--goal is required");
  }
  return {
    goal,
    coder: values.coder as string,
    reviewer: values.reviewer as string,
    watch: values.watch as boolean,
    groveUrl: values["grove-url"] as string,
    timeoutSec: Number.parseInt(values.timeout as string, 10),
  };
}

export async function executeReviewLoop(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand !== "start") {
    console.log(`grove review-loop <subcommand>

Subcommands:
  start --goal <text> [--coder <runtime>] [--reviewer <runtime>] [--watch]
                      [--grove-url <url>] [--timeout <seconds>]
                          Start a codex → claude review loop via AgentTask + Scheduler.
                          Requires a running grove-server with scheduler config in grove.json.`);
    return;
  }
  // The full start handler is filled in by later tasks.
  throw new Error("review-loop start not yet implemented");
}
```

- [ ] **Step 4: Run tests**

`bun test src/cli/commands/review-loop.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/review-loop.ts src/cli/commands/review-loop.test.ts
git commit -m "feat(cli): grove review-loop start arg parsing"
```

---

## Task 13: `grove review-loop start` — workspace bootstrap + POST tasks

**Files:**
- Modify: `src/cli/commands/review-loop.ts`
- Modify: `src/cli/commands/review-loop.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/cli/commands/review-loop.test.ts`:

```ts
import { buildTaskSpecs } from "./review-loop.js";

describe("buildTaskSpecs", () => {
  test("constructs coder + reviewer specs with shared worktree", () => {
    const specs = buildTaskSpecs({
      goal: "Build X",
      coder: "codex",
      reviewer: "claude",
      worktree: "/tmp/wt",
      timestamp: "2026-05-16T10:00:00.000Z",
    });
    expect(specs.coder.id).toBe("review-loop-2026-05-16T10:00:00.000Z-coder");
    expect(specs.coder.runtime).toBe("codex");
    expect(specs.coder.role).toBe("coder");
    expect(specs.coder.prompt).toBe("Build X");
    expect(specs.coder.worktree).toBe("/tmp/wt");
    expect(specs.coder.dependsOn).toEqual([]);
    expect(specs.coder.generation).toBe(1);

    expect(specs.reviewer.id).toBe("review-loop-2026-05-16T10:00:00.000Z-reviewer");
    expect(specs.reviewer.runtime).toBe("claude");
    expect(specs.reviewer.role).toBe("reviewer");
    expect(specs.reviewer.prompt).toContain("Review the work completed for: Build X");
    expect(specs.reviewer.worktree).toBe("/tmp/wt");
    expect(specs.reviewer.dependsOn).toEqual([specs.coder.id]);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

`bun test src/cli/commands/review-loop.test.ts` — expected FAIL.

- [ ] **Step 3: Add `buildTaskSpecs` and implement `start`**

Edit `src/cli/commands/review-loop.ts`. Add the export:

```ts
import type { AgentTaskSpecRecord } from "../../core/agent-task.js";

export interface TaskSpecBuilderInputs {
  readonly goal: string;
  readonly coder: string;
  readonly reviewer: string;
  readonly worktree: string;
  readonly timestamp: string;
}

export interface TaskSpecPair {
  readonly coder: AgentTaskSpecRecord;
  readonly reviewer: AgentTaskSpecRecord;
}

export function buildTaskSpecs(inputs: TaskSpecBuilderInputs): TaskSpecPair {
  const baseId = `review-loop-${inputs.timestamp}`;
  const coderId = `${baseId}-coder`;
  const reviewerId = `${baseId}-reviewer`;
  const coder: AgentTaskSpecRecord = {
    id: coderId,
    worktree: inputs.worktree,
    runtime: inputs.coder,
    role: "coder",
    prompt: inputs.goal,
    dependsOn: [],
    generation: 1,
    createdAt: inputs.timestamp,
  };
  const reviewer: AgentTaskSpecRecord = {
    id: reviewerId,
    worktree: inputs.worktree,
    runtime: inputs.reviewer,
    role: "reviewer",
    prompt: `Review the work completed for: ${inputs.goal}`,
    dependsOn: [coderId],
    generation: 1,
    createdAt: inputs.timestamp,
  };
  return { coder, reviewer };
}
```

Replace the `throw new Error("review-loop start not yet implemented");` line with the full start flow:

```ts
import { mkdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { join } from "node:path";

// ... inside executeReviewLoop after the `subcommand === "start"` branch:
const parsed = parseReviewLoopStartArgs(rest);
const { findGroveDir } = await import("../context.js");
const groveDir = findGroveDir(process.cwd());
if (groveDir === undefined) {
  throw new Error("Not inside a grove. Run 'grove init' first.");
}

// Discover bearer token from server-keys.yaml.
const serverKeysPath = join(groveDir, "server-keys.yaml");
const rawYaml = readFileSync(serverKeysPath, "utf-8");
const keysFile = parseYaml(rawYaml) as {
  keys: Record<string, { namespace: string; createdAt: string }>;
};
const token = Object.keys(keysFile.keys)[0];
if (token === undefined) {
  throw new Error(`No bearer token found in ${serverKeysPath}`);
}

// Provision a shared worktree dir under .grove/workspaces/review-loop-<ts>/.
const timestamp = new Date().toISOString();
const safeTs = timestamp.replace(/[:.]/g, "-");
const worktree = join(groveDir, "workspaces", `review-loop-${safeTs}`);
mkdirSync(worktree, { recursive: true });

const specs = buildTaskSpecs({
  goal: parsed.goal,
  coder: parsed.coder,
  reviewer: parsed.reviewer,
  worktree,
  timestamp,
});

// POST coder first; if it fails, abort before reviewer.
await putAgentTask(parsed.groveUrl, token, specs.coder);
try {
  await putAgentTask(parsed.groveUrl, token, specs.reviewer);
} catch (err) {
  // Best-effort cleanup: try to delete coder if reviewer creation fails.
  await deleteAgentTask(parsed.groveUrl, token, specs.coder.id).catch(() => undefined);
  throw err;
}

const output = {
  groveUrl: parsed.groveUrl,
  worktree,
  tasks: {
    coder: { id: specs.coder.id, runtime: specs.coder.runtime, role: specs.coder.role },
    reviewer: {
      id: specs.reviewer.id,
      runtime: specs.reviewer.runtime,
      role: specs.reviewer.role,
      dependsOn: specs.reviewer.dependsOn,
    },
  },
};
console.log(JSON.stringify(output, null, 2));

if (parsed.watch) {
  await watchTasks(parsed.groveUrl, token, [specs.coder.id, specs.reviewer.id], parsed.timeoutSec);
}
```

Add the HTTP helpers (`putAgentTask`, `deleteAgentTask`, `watchTasks`) to the same file. `putAgentTask`:

```ts
async function putAgentTask(
  baseUrl: string,
  token: string,
  spec: AgentTaskSpecRecord,
): Promise<void> {
  const url = `${baseUrl}/api/agent-tasks/${encodeURIComponent(spec.id)}`;
  const body = {
    worktree: spec.worktree,
    runtime: spec.runtime,
    role: spec.role,
    prompt: spec.prompt,
    dependsOn: spec.dependsOn,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "If-Match": "*",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 0 || res.status >= 500) {
      throw new Error(
        `PUT /api/agent-tasks/${spec.id} failed (${res.status}). Hint: is grove-server running? Try 'grove up' first.\n${text}`,
      );
    }
    throw new Error(`PUT /api/agent-tasks/${spec.id} failed: ${res.status} ${text}`);
  }
}

async function deleteAgentTask(baseUrl: string, token: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/api/agent-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}
```

`watchTasks` is implemented in Task 14.

- [ ] **Step 4: Run unit tests**

`bun test src/cli/commands/review-loop.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/review-loop.ts src/cli/commands/review-loop.test.ts
git commit -m "feat(cli): grove review-loop start posts coder+reviewer AgentTasks"
```

---

## Task 14: `grove review-loop --watch` polling loop

**Files:**
- Modify: `src/cli/commands/review-loop.ts`

- [ ] **Step 1: Add `watchTasks` implementation**

In `src/cli/commands/review-loop.ts`, add the polling helper (stub from Task 13 now gets the real body):

```ts
type AgentTaskStatusView = {
  readonly spec: { readonly id: string };
  readonly status: {
    readonly phase: string;
    readonly sessionId?: string;
    readonly conditions?: ReadonlyArray<{ readonly type: string; readonly status: string }>;
  };
};

async function fetchTask(baseUrl: string, token: string, id: string): Promise<AgentTaskStatusView | undefined> {
  const res = await fetch(`${baseUrl}/api/agent-tasks/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`GET /api/agent-tasks/${id} failed: ${res.status}`);
  }
  return (await res.json()) as AgentTaskStatusView;
}

async function watchTasks(
  baseUrl: string,
  token: string,
  taskIds: readonly string[],
  timeoutSec: number,
): Promise<void> {
  const lastPhase = new Map<string, string>();
  const deadline = Date.now() + timeoutSec * 1000;
  const terminal = new Set(["Succeeded", "Failed"]);

  while (Date.now() < deadline) {
    let allTerminal = true;
    for (const id of taskIds) {
      const view = await fetchTask(baseUrl, token, id);
      if (view === undefined) {
        console.log(JSON.stringify({ event: "missing", taskId: id, at: new Date().toISOString() }));
        process.exit(1);
      }
      const phase = view.status.phase;
      const prev = lastPhase.get(id);
      if (prev !== phase) {
        console.log(
          JSON.stringify({
            event: "phase-change",
            taskId: id,
            from: prev ?? "(initial)",
            to: phase,
            at: new Date().toISOString(),
          }),
        );
        lastPhase.set(id, phase);
      }
      if (!terminal.has(phase)) allTerminal = false;
    }
    if (allTerminal) {
      const anyFailed = [...lastPhase.values()].some((p) => p === "Failed");
      console.log(
        JSON.stringify({
          event: "complete",
          exitCode: anyFailed ? 1 : 0,
          finalPhases: Object.fromEntries(lastPhase),
        }),
      );
      process.exit(anyFailed ? 1 : 0);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(
    JSON.stringify({
      event: "timeout",
      timeoutSec,
      lastPhases: Object.fromEntries(lastPhase),
    }),
  );
  process.exit(2);
}
```

- [ ] **Step 2: Add unit test**

Append to `src/cli/commands/review-loop.test.ts`:

```ts
describe("watchTasks (unit-level via mocked fetch)", () => {
  test("exits 0 when both tasks reach Succeeded", async () => {
    // Mock global fetch to return progressively-advancing task states.
    const responses: Record<string, AgentTaskStatusView[]> = {
      "a": [
        { spec: { id: "a" }, status: { phase: "Pending", conditions: [] } },
        { spec: { id: "a" }, status: { phase: "PendingBind", conditions: [] } },
        { spec: { id: "a" }, status: { phase: "Running", sessionId: "s", conditions: [] } },
        { spec: { id: "a" }, status: { phase: "Succeeded", sessionId: "s", conditions: [] } },
      ],
      "b": [
        { spec: { id: "b" }, status: { phase: "Pending", conditions: [] } },
        { spec: { id: "b" }, status: { phase: "Pending", conditions: [] } },
        { spec: { id: "b" }, status: { phase: "Pending", conditions: [] } },
        { spec: { id: "b" }, status: { phase: "Running", sessionId: "s", conditions: [] } },
        { spec: { id: "b" }, status: { phase: "Succeeded", sessionId: "s", conditions: [] } },
      ],
    };
    const counters = new Map<string, number>();
    const originalFetch = globalThis.fetch;
    const originalExit = process.exit;
    let exitCode: number | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const match = url.match(/agent-tasks\/([^/]+)$/);
      if (match === null) return new Response("not found", { status: 404 });
      const id = match[1];
      const idx = counters.get(id) ?? 0;
      const responsesForId = responses[id] ?? [];
      const view = responsesForId[Math.min(idx, responsesForId.length - 1)];
      counters.set(id, idx + 1);
      return new Response(JSON.stringify(view), { status: 200 });
    }) as typeof fetch;
    (process.exit as unknown) = ((code: number) => {
      exitCode = code;
      throw new Error("__exit__");
    }) as typeof process.exit;
    try {
      // Call watchTasks via internal export (re-export for testing).
      const { __testHooks } = await import("./review-loop.js");
      await expect(
        __testHooks.watchTasks("http://x", "t", ["a", "b"], 30),
      ).rejects.toThrow("__exit__");
      expect(exitCode).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      (process.exit as unknown) = originalExit;
    }
  });
});

type AgentTaskStatusView = {
  readonly spec: { readonly id: string };
  readonly status: {
    readonly phase: string;
    readonly sessionId?: string;
    readonly conditions?: ReadonlyArray<{ readonly type: string; readonly status: string }>;
  };
};
```

In `review-loop.ts`, add at the bottom for testing:

```ts
export const __testHooks = { watchTasks, fetchTask, putAgentTask, deleteAgentTask };
```

- [ ] **Step 3: Run tests**

`bun test src/cli/commands/review-loop.test.ts` — expected PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/review-loop.ts src/cli/commands/review-loop.test.ts
git commit -m "feat(cli): grove review-loop --watch streams phase transitions"
```

---

## Task 15: Register `review-loop` in `main.ts`

**Files:**
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Add the command entry**

Open `src/cli/main.ts`. Find the array of command objects (starts around line 113 with `init`). Insert (alphabetically, after `review`):

```ts
{
  name: "review-loop",
  description: "Start a codex → claude review loop via AgentTask + Scheduler",
  needsStore: false,
  handler: async (args) => {
    const { executeReviewLoop } = await import("./commands/review-loop.js");
    await executeReviewLoop(args);
  },
},
```

- [ ] **Step 2: Run integration test**

`bun run src/cli/main.ts review-loop` — should print the help text.
`bun run src/cli/main.ts review-loop start` — should error with `--goal is required`.

Also run `bun test src/cli/` — confirm no regression in existing CLI tests.

- [ ] **Step 3: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat(cli): register grove review-loop subcommand in main dispatch"
```

---

## Task 16: tmux E2E `review-loop-codex-claude-tmux.ts`

**Files:**
- Create: `tests/e2e/review-loop-codex-claude-tmux.ts`

- [ ] **Step 1: Create the harness file**

Copy the structure from `tests/e2e/scheduler-pipeline-tmux.ts` (recently added in this PR). The new harness:

1. Setup phase:
   - `mkdtempSync` workdir, `mkdirSync` `.grove/` inside it.
   - `grove init --preset review-loop --force review-loop-e2e` (in tmux pane 0 or via spawnSync).
   - Overwrite `grove.json` with:

```json
{
  "name": "review-loop-e2e",
  "mode": "local",
  "scheduler": {
    "profiles": [
      {
        "name": "codex-default",
        "platform": "codex",
        "runtimeCommand": "codex",
        "supportedRoles": ["coder"]
      },
      {
        "name": "claude-default",
        "platform": "claude-code",
        "runtimeCommand": "claude",
        "supportedRoles": ["reviewer"]
      }
    ],
    "pipeline": {
      "filters": ["RuntimeCapability", "BudgetRemaining", "WorktreeExclusivity"],
      "scores": [{ "name": "TaskAffinity", "weight": 1 }],
      "permits": ["AutoPermit"],
      "bind": "DefaultBind"
    }
  }
}
```

2. Start grove-server in a tmux pane on a unique port (e.g., 12795):

```ts
const env = [
  `GROVE_DIR=${groveDir}`,
  `PORT=${SERVER_PORT}`,
  `GROVE_TASK_CONTROLLER=1`,
].join(" ");
// tmux new-session -d -s ... -x 220 -y 50 sh -c
//   "${env} bun run ${PROJECT_ROOT}/src/server/serve.ts 2>&1 | tee ${serverLogFile}; cat"
```

3. Wait for `task-controller enabled (scheduler: 2 profiles, 3 filters)` in the server pane (proves wiring picked up grove.json).

4. Wait for `listening` to confirm HTTP up.

5. Read bearer token from `.grove/server-keys.yaml`.

6. Run `grove review-loop start --goal "Print hello and call grove_done" --grove-url http://localhost:12795 --watch --timeout 120` as a subprocess. Capture stdout (line-delimited JSON).

7. Assertions on the captured stream:
   - Parse each line as JSON.
   - There must be a `phase-change` event for both task IDs going `Pending → ... → Succeeded`.
   - The final event must be `{ event: "complete", exitCode: 0, ... }`.
   - The subprocess exit code must be 0.

8. Final pane capture:
   - Capture and print the server pane (last 200 lines) so the user sees `task-controller enabled` + transition logs.
   - Capture and print the final GET for each task (to show the `Succeeded` condition messages).

9. Cleanup (skip if `--keep`):
   - Kill tmux server: `tmux -L <socket> kill-server`.
   - Remove workdir.

Naming:
- `SOCKET = "grove-review-loop-e2e"`
- `SESSION = "grove-review-loop-e2e"`
- `SERVER_PORT = 12795`

Reuse the `capturePane`, `waitForPane`, `sleep`, `cleanup` helpers from `scheduler-pipeline-tmux.ts` (copy them — the existing file is also standalone).

- [ ] **Step 2: Make file executable as standalone**

Add the same `// NOT wired into bun test — run as: bun run tests/e2e/review-loop-codex-claude-tmux.ts` header.

- [ ] **Step 3: Commit (before running)**

```bash
git add tests/e2e/review-loop-codex-claude-tmux.ts
git commit -m "test(review-loop): tmux E2E harness for codex → claude AgentTask flow"
```

(We commit the harness even before it passes so the next task can iterate on it.)

---

## Task 17: Run the E2E + iterate to green

**Files:**
- Modify (as needed): `tests/e2e/review-loop-codex-claude-tmux.ts` and any plumbing it surfaces issues with.

- [ ] **Step 1: Run the harness**

```bash
bun run tests/e2e/review-loop-codex-claude-tmux.ts
```

- [ ] **Step 2: Diagnose any failure**

Common failure points and the right fix:

- `task-controller enabled (scheduler: 2 profiles, 3 filters)` line missing → Task 8's `GROVE_SERVER_URL` / `GROVE_API_TOKEN` setup is in the wrong place, OR `GROVE_DIR` doesn't contain a grove.json — fix harness.
- `grove review-loop` exits non-zero with "connection refused" → port mismatch between harness and CLI invocation.
- Coder task stuck in `Running`, never reaches `Succeeded` → `grove_done` POST not firing. Check:
  - Does the server pane show `POST /api/agent-tasks/<id>/done`? If not, MCP env vars aren't reaching the agent. Verify `DefaultBind` env passthrough.
  - Does `[grove-done] task=... POST /done failed` appear in MCP stderr? If yes, route or auth is wrong.
- Reviewer task never unblocks → `dependsOn` check or `Succeeded` transition issue. Check `[task-controller] <id>: Running → Succeeded` log.
- Real-spawn issues (claude/codex won't start) → may need login/auth. Diagnose; if blocked, mark E2E as MANUAL with documented setup steps and accept unit-level coverage.

Make ONE good-faith fix attempt per identified issue. If after 3 iterations the E2E still fails for non-trivial reasons (e.g., real CLI behavior we can't control), commit the harness in a state that documents the failure mode and report BLOCKED.

- [ ] **Step 3: Commit final harness state**

If green:

```bash
git add tests/e2e/review-loop-codex-claude-tmux.ts
git commit -m "test(review-loop): E2E green — codex → claude handoff via scheduler"
```

If blocked but harness improved:

```bash
git add tests/e2e/review-loop-codex-claude-tmux.ts
git commit -m "test(review-loop): tmux E2E partially working — see harness header for status"
```

Either way, in the final user-facing report explicitly state: which assertions pass, which don't, why.

---

## Final verification

- [ ] **Run the full test suite**

```bash
bun test src/
```

Expected: all pre-existing tests pass + the new unit tests from tasks 1-15.

- [ ] **Compare scheduler-pipeline E2E + new E2E**

```bash
bun run tests/e2e/scheduler-pipeline-tmux.ts
bun run tests/e2e/review-loop-codex-claude-tmux.ts
```

Both should exit 0 (or the review-loop E2E exits 0 if green; if BLOCKED, exit code documents why).

- [ ] **Check the gap from PR #439 is closed**

The original PR #439 noted: "the legacy review-loop (codex submits → claude reviews) still runs on the older session-orchestrator path, not via AgentTask". The new `grove review-loop` CLI proves an alternative path that DOES go through AgentTask + Scheduler. Confirm in your final summary.

---

## Out of scope (deferred to follow-ups)

- Cascade cancellation when a dependency Fails (dependent stays Pending forever today).
- Multi-reviewer fan-out (one coder, two reviewers in parallel).
- Replacing `SessionOrchestrator` / migrating `grove session start`.
- `AwaitingReview` phase semantics (currently in the enum but unused; would be relevant for richer review-cycle UX).
- Permit decision store backing for `UserConfirmPermit` (UI prompts for "approve this profile?").
- Chaos test: kill controller mid-Succeeded-transition.
- Telemetry exporters (Prometheus, OpenTelemetry) for AgentTask transitions.
