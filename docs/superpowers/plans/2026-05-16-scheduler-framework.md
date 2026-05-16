# Scheduler Framework Implementation Plan (D3, #300)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kubernetes-scheduler-style plugin pipeline (Filter → Score → Permit → Bind) that selects a `RuntimeProfile` for each `AgentTask` before bind, and wire it into `TaskController.reconcilePendingBind`.

**Architecture:** New `src/core/scheduler/` module. Pure `Scheduler` class runs the four-stage pipeline over candidate `RuntimeProfile` records and returns a typed `SchedulingResult`. `TaskController` gains an optional `scheduler` option; when present, `reconcilePendingBind` calls `scheduler.schedule(task)` and maps the result variant to a status patch. When absent, today's direct-bind path is preserved.

**Tech Stack:** TypeScript with `isolatedDeclarations`, `bun:test`, `zod` v4 for config validation.

**Spec:** `docs/superpowers/specs/2026-05-16-scheduler-framework-design.md`

---

## File Structure

**New files**

- `src/core/scheduler/framework.ts` — plugin interfaces, `SchedulerContext`, `SchedulingResult`, verdict types.
- `src/core/scheduler/profile.ts` — `RuntimeProfile` type + `synthesizeFallbackProfile(task)`.
- `src/core/scheduler/scheduler.ts` — `Scheduler` class.
- `src/core/scheduler/scheduler.test.ts` — pipeline tests.
- `src/core/scheduler/config.ts` — `SchedulerConfig` zod schema + `loadSchedulerConfig`.
- `src/core/scheduler/config.test.ts` — config tests.
- `src/core/scheduler/plugins/runtime-capability.ts` + `.test.ts`
- `src/core/scheduler/plugins/budget-remaining.ts` + `.test.ts`
- `src/core/scheduler/plugins/worktree-exclusivity.ts` + `.test.ts`
- `src/core/scheduler/plugins/task-affinity.ts` + `.test.ts`
- `src/core/scheduler/plugins/auto-permit.ts` + `.test.ts`
- `src/core/scheduler/plugins/user-confirm-permit.ts` + `.test.ts`
- `src/core/scheduler/plugins/default-bind.ts` + `.test.ts`
- `src/core/scheduler/plugins/index.ts` — built-in plugin registry.
- `src/core/scheduler/index.ts` — public re-exports.

**Modified files**

- `src/core/agent-task.ts` — extend `AgentTaskConditionType` enum.
- `src/core/task-controller.ts` — add `scheduler?` option, `applyDecision`, new branch in `reconcilePendingBind`.
- `src/core/task-controller.test.ts` — extend with scheduler-injected scenarios.
- `src/core/index.ts` — re-export scheduler module.

**Convention:** every file in `src/core/scheduler/` uses `.js` import suffixes to match the rest of the repo's ESM-style imports.

---

## Task 1: Extend `AgentTaskConditionType` with `Unschedulable` + `PermitRequired`

**Files:**
- Modify: `src/core/agent-task.ts:15-26`

- [ ] **Step 1: Write the failing test**

Create `src/core/agent-task.condition-types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTaskConditionType } from "./agent-task.js";

describe("AgentTaskConditionType", () => {
  test("includes Unschedulable for scheduler-rejected tasks", () => {
    expect(AgentTaskConditionType.Unschedulable).toBe("Unschedulable");
  });

  test("includes PermitRequired for scheduler permit-wait", () => {
    expect(AgentTaskConditionType.PermitRequired).toBe("PermitRequired");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/agent-task.condition-types.test.ts`
Expected: FAIL — property `Unschedulable` does not exist on type.

- [ ] **Step 3: Add the two enum members**

Edit `src/core/agent-task.ts` lines 15-24, replacing the `AgentTaskConditionType` object with:

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
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/agent-task.condition-types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run existing agent-task tests to confirm no regression**

Run: `bun test src/core/agent-task.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/agent-task.ts src/core/agent-task.condition-types.test.ts
git commit -m "feat(core): add Unschedulable + PermitRequired condition types (#300)"
```

---

## Task 2: Define plugin interfaces (`framework.ts`)

**Files:**
- Create: `src/core/scheduler/framework.ts`

This file is type-only (no runtime logic), so the "test" is a compile-time use site. We add a tiny `bun:test` smoke that imports every exported symbol so missing exports fail fast.

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/framework.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type {
  BindPlugin,
  FilterPlugin,
  FilterRejection,
  FilterVerdict,
  PermitPlugin,
  PermitVerdict,
  SchedulerContext,
  SchedulingResult,
  ScorePlugin,
} from "./framework.js";

describe("framework exports", () => {
  test("FilterVerdict discriminates by admit", () => {
    const admit: FilterVerdict = { admit: true };
    const reject: FilterVerdict = { admit: false, reason: "x" };
    expect(admit.admit).toBe(true);
    expect(reject.admit).toBe(false);
  });

  test("PermitVerdict status union covers granted/denied/wait", () => {
    const grants: PermitVerdict[] = [
      { status: "granted" },
      { status: "denied", reason: "no" },
      { status: "wait", reason: "later" },
    ];
    expect(grants).toHaveLength(3);
  });

  test("SchedulingResult kind union covers four variants", () => {
    const kinds: SchedulingResult["kind"][] = ["bound", "unschedulable", "wait", "denied"];
    expect(kinds).toEqual(["bound", "unschedulable", "wait", "denied"]);
  });

  test("FilterRejection records plugin + reason", () => {
    const rejection: FilterRejection = { plugin: "test", reason: "x" };
    expect(rejection.plugin).toBe("test");
  });

  test("plugin interfaces have name field", () => {
    const filter: FilterPlugin = {
      name: "n",
      filter: async () => ({ admit: true }),
    };
    const score: ScorePlugin = { name: "n", score: async () => 0 };
    const permit: PermitPlugin = { name: "n", permit: async () => ({ status: "granted" }) };
    const bind: BindPlugin = {
      name: "n",
      bind: async () => ({ session: { id: "s", role: "r", status: "running" } }),
    };
    expect(filter.name).toBe("n");
    expect(score.name).toBe("n");
    expect(permit.name).toBe("n");
    expect(bind.name).toBe("n");
  });

  test("SchedulerContext shape compiles", () => {
    const _ctx: Pick<SchedulerContext, "now"> = { now: () => 0 };
    expect(typeof _ctx.now).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/framework.test.ts`
Expected: FAIL — `framework.js` does not exist.

- [ ] **Step 3: Create `framework.ts`**

Create `src/core/scheduler/framework.ts`:

```ts
import type { AgentSession } from "../agent-runtime.js";
import type { AgentTaskView } from "../agent-task.js";
import type { AgentTaskStore } from "../store.js";
import type { RuntimeProfile } from "./profile.js";

export interface SchedulerContext {
  readonly task: AgentTaskView;
  readonly profiles: readonly RuntimeProfile[];
  readonly store: Pick<AgentTaskStore, "listAgentTaskEntities">;
  readonly now: () => number;
}

export type FilterVerdict =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string; readonly message?: string | undefined };

export interface FilterPlugin {
  readonly name: string;
  filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict>;
}

export interface ScorePlugin {
  readonly name: string;
  score(ctx: SchedulerContext, profile: RuntimeProfile): Promise<number>;
}

export type PermitVerdict =
  | { readonly status: "granted" }
  | { readonly status: "denied"; readonly reason: string; readonly message?: string | undefined }
  | { readonly status: "wait"; readonly reason: string; readonly message?: string | undefined };

export interface PermitPlugin {
  readonly name: string;
  permit(ctx: SchedulerContext, profile: RuntimeProfile): Promise<PermitVerdict>;
}

export interface BindResult {
  readonly session: AgentSession;
}

export interface BindPlugin {
  readonly name: string;
  bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult>;
}

export interface FilterRejection {
  readonly plugin: string;
  readonly reason: string;
  readonly message?: string | undefined;
}

export interface ProfileRejection {
  readonly profile: RuntimeProfile;
  readonly rejections: readonly FilterRejection[];
}

export type SchedulingResult =
  | {
      readonly kind: "bound";
      readonly profile: RuntimeProfile;
      readonly session: AgentSession;
      readonly reservationToken?: string | undefined;
    }
  | {
      readonly kind: "unschedulable";
      readonly rejections: readonly ProfileRejection[];
    }
  | {
      readonly kind: "wait";
      readonly plugin: string;
      readonly reason: string;
      readonly message?: string | undefined;
      readonly profile: RuntimeProfile;
    }
  | {
      readonly kind: "denied";
      readonly plugin: string;
      readonly reason: string;
      readonly message?: string | undefined;
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/scheduler/framework.test.ts`
Expected: FAIL — `profile.js` does not exist yet (next task creates it).

To unblock just this task, add a temporary stub `profile.ts`:

```ts
export interface RuntimeProfile {
  readonly name: string;
}
```

Run again: `bun test src/core/scheduler/framework.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/framework.ts src/core/scheduler/framework.test.ts src/core/scheduler/profile.ts
git commit -m "feat(scheduler): plugin interfaces + scheduling result types (#300)"
```

---

## Task 3: Implement `RuntimeProfile` + `synthesizeFallbackProfile` (`profile.ts`)

**Files:**
- Modify: `src/core/scheduler/profile.ts` (replacing the Task 2 stub)
- Create: `src/core/scheduler/profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/profile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import { synthesizeFallbackProfile } from "./profile.js";

function taskWithRuntime(runtime: string, model?: string): AgentTaskView {
  return {
    spec: {
      id: "task-1",
      worktree: "/tmp/w",
      runtime,
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...(model === undefined ? {} : { budget: { model } }),
    },
    status: {
      id: "task-1",
      phase: AgentTaskPhase.Pending,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

describe("synthesizeFallbackProfile", () => {
  test("maps task.spec.runtime 'claude' to claude-code platform", () => {
    const profile = synthesizeFallbackProfile(taskWithRuntime("claude"));
    expect(profile.platform).toBe("claude-code");
    expect(profile.runtimeCommand).toBe("claude");
    expect(profile.name).toBe("fallback-claude");
  });

  test("maps 'codex' and 'gemini' to their platforms", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("codex")).platform).toBe("codex");
    expect(synthesizeFallbackProfile(taskWithRuntime("gemini")).platform).toBe("gemini");
  });

  test("uses undefined platform for unknown runtime", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("custom")).platform).toBeUndefined();
  });

  test("carries model from task.spec.budget.model when present", () => {
    expect(synthesizeFallbackProfile(taskWithRuntime("claude", "claude-opus-4-7")).model).toBe(
      "claude-opus-4-7",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/profile.test.ts`
Expected: FAIL — `synthesizeFallbackProfile` is not exported.

- [ ] **Step 3: Replace `profile.ts` stub with the full implementation**

Replace the contents of `src/core/scheduler/profile.ts`:

```ts
import type { AgentTaskView } from "../agent-task.js";
import type { AgentPlatformType } from "../topology.js";

export interface RuntimeProfileBudget {
  readonly maxCostUsd?: number | undefined;
  readonly maxTurns?: number | undefined;
  readonly allowedModels?: readonly string[] | undefined;
}

export interface RuntimeProfile {
  readonly name: string;
  readonly platform: AgentPlatformType | undefined;
  readonly runtimeCommand: string;
  readonly model?: string | undefined;
  readonly supportedRoles?: readonly string[] | undefined;
  readonly budget?: RuntimeProfileBudget | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

export function synthesizeFallbackProfile(task: AgentTaskView): RuntimeProfile {
  const runtime = task.spec.runtime;
  const model = readModelFromBudget(task.spec.budget);
  return {
    name: `fallback-${runtime}`,
    platform: runtimeToPlatform(runtime),
    runtimeCommand: runtime,
    ...(model === undefined ? {} : { model }),
  };
}

function runtimeToPlatform(runtime: string): AgentPlatformType | undefined {
  if (runtime === "claude" || runtime === "claude-code") return "claude-code";
  if (runtime === "codex") return "codex";
  if (runtime === "gemini") return "gemini";
  return undefined;
}

function readModelFromBudget(budget: unknown): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const model = (budget as { model?: unknown }).model;
  return typeof model === "string" ? model : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/profile.test.ts`
Expected: PASS (4 tests).

Run: `bun test src/core/scheduler/framework.test.ts`
Expected: PASS (6 tests, still green).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/profile.ts src/core/scheduler/profile.test.ts
git commit -m "feat(scheduler): RuntimeProfile type + fallback synthesis (#300)"
```

---

## Task 4: Scheduler pipeline — `unschedulable` when all filters reject

**Files:**
- Create: `src/core/scheduler/scheduler.ts`
- Create: `src/core/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/scheduler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../agent-runtime.js";
import type { AgentTaskEntity, AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import type {
  BindPlugin,
  FilterPlugin,
  PermitPlugin,
  ScorePlugin,
} from "./framework.js";
import type { RuntimeProfile } from "./profile.js";
import { Scheduler } from "./scheduler.js";

const TASK_ID = "task-1";

function taskView(): AgentTaskView {
  return {
    spec: {
      id: TASK_ID,
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id: TASK_ID,
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(name: string, overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    name,
    platform: "claude-code",
    runtimeCommand: "claude",
    ...overrides,
  };
}

function emptyStore(): { listAgentTaskEntities: () => Promise<readonly AgentTaskEntity[]> } {
  return { listAgentTaskEntities: async () => [] };
}

function alwaysReject(name: string, reason: string): FilterPlugin {
  return { name, filter: async () => ({ admit: false, reason }) };
}

function alwaysAdmit(name: string): FilterPlugin {
  return { name, filter: async () => ({ admit: true }) };
}

function constantScore(name: string, value: number): ScorePlugin {
  return { name, score: async () => value };
}

function autoPermit(): PermitPlugin {
  return { name: "auto", permit: async () => ({ status: "granted" }) };
}

function staticBind(session: AgentSession): BindPlugin {
  return { name: "static", bind: async () => ({ session }) };
}

describe("Scheduler.schedule — unschedulable", () => {
  test("returns unschedulable when all profiles are rejected", async () => {
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysReject("deny-all", "blocked")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("unschedulable");
    if (result.kind === "unschedulable") {
      expect(result.rejections).toHaveLength(2);
      expect(result.rejections[0]?.rejections[0]?.reason).toBe("blocked");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: FAIL — `Scheduler` not exported.

- [ ] **Step 3: Create `scheduler.ts`**

Create `src/core/scheduler/scheduler.ts`:

```ts
import type { AgentTaskView } from "../agent-task.js";
import type {
  BindPlugin,
  FilterPlugin,
  FilterRejection,
  PermitPlugin,
  ProfileRejection,
  SchedulerContext,
  SchedulingResult,
  ScorePlugin,
} from "./framework.js";
import type { RuntimeProfile } from "./profile.js";
import { synthesizeFallbackProfile } from "./profile.js";

export interface SchedulerOptions {
  readonly profiles: readonly RuntimeProfile[];
  readonly filters: readonly FilterPlugin[];
  readonly scores: readonly ScorePluginEntry[];
  readonly permits: readonly PermitPlugin[];
  readonly bindPlugin: BindPlugin;
  readonly store: SchedulerContext["store"];
  readonly now?: (() => number) | undefined;
}

export interface ScorePluginEntry {
  readonly plugin: ScorePlugin;
  readonly weight?: number | undefined;
}

export class Scheduler {
  private readonly profiles: readonly RuntimeProfile[];
  private readonly filters: readonly FilterPlugin[];
  private readonly scores: readonly ScorePluginEntry[];
  private readonly permits: readonly PermitPlugin[];
  private readonly bindPlugin: BindPlugin;
  private readonly store: SchedulerContext["store"];
  private readonly now: () => number;

  constructor(options: SchedulerOptions) {
    this.profiles = options.profiles;
    this.filters = options.filters;
    this.scores = normalizeScores(options.scores);
    this.permits = options.permits;
    this.bindPlugin = options.bindPlugin;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  async schedule(task: AgentTaskView): Promise<SchedulingResult> {
    const profiles = this.profiles.length > 0 ? this.profiles : [synthesizeFallbackProfile(task)];
    const ctx: SchedulerContext = {
      task,
      profiles,
      store: this.store,
      now: this.now,
    };

    const filtered = await this.runFilters(ctx);
    const admitted = filtered.filter((entry) => entry.rejections.length === 0);
    if (admitted.length === 0) {
      return { kind: "unschedulable", rejections: filtered };
    }

    // Score/permit/bind are added in later tasks. For Task 4, take the first admitted profile.
    const winner = admitted[0]!.profile;
    const { session } = await this.bindPlugin.bind(ctx, winner);
    return { kind: "bound", profile: winner, session, reservationToken: undefined };
  }

  private async runFilters(ctx: SchedulerContext): Promise<readonly ProfileRejection[]> {
    return Promise.all(
      ctx.profiles.map(async (profile) => {
        const rejections: FilterRejection[] = [];
        for (const plugin of this.filters) {
          const verdict = await plugin.filter(ctx, profile);
          if (!verdict.admit) {
            rejections.push({
              plugin: plugin.name,
              reason: verdict.reason,
              message: verdict.message,
            });
          }
        }
        return { profile, rejections } satisfies ProfileRejection;
      }),
    );
  }
}

function normalizeScores(scores: readonly ScorePluginEntry[]): readonly ScorePluginEntry[] {
  return scores.map((entry) => ({
    plugin: entry.plugin,
    weight: entry.weight ?? 1,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/scheduler.ts src/core/scheduler/scheduler.test.ts
git commit -m "feat(scheduler): pipeline skeleton + unschedulable path (#300)"
```

---

## Task 5: Scheduler scoring — highest score wins, config-order breaks ties

**Files:**
- Modify: `src/core/scheduler/scheduler.ts`
- Modify: `src/core/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/core/scheduler/scheduler.test.ts`:

```ts
describe("Scheduler.schedule — scoring", () => {
  test("highest weighted-sum score wins", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysAdmit("admit-all")],
      scores: [
        { plugin: constantScoreFor(profile("a").name, 20, profile("b").name, 80), weight: 1 },
      ],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("b");
  });

  test("tie broken by config declaration order", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("first"), profile("second")],
      filters: [alwaysAdmit("admit-all")],
      scores: [{ plugin: constantScore("flat", 50), weight: 1 }],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("first");
  });

  test("weights multiply per-score contributions", async () => {
    const session: AgentSession = { id: "s", role: "worker", status: "running" };
    const scheduler = new Scheduler({
      profiles: [profile("a"), profile("b")],
      filters: [alwaysAdmit("admit-all")],
      scores: [
        { plugin: constantScoreFor("a", 100, "b", 0), weight: 1 },
        { plugin: constantScoreFor("a", 0, "b", 100), weight: 2 },
      ],
      permits: [autoPermit()],
      bindPlugin: staticBind(session),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("b");
  });
});

function constantScoreFor(nameA: string, valueA: number, nameB: string, valueB: number): ScorePlugin {
  return {
    name: `pair-${nameA}-${nameB}`,
    score: async (_ctx, profile) => {
      if (profile.name === nameA) return valueA;
      if (profile.name === nameB) return valueB;
      return 0;
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: FAIL — scoring not implemented; "first" profile wins regardless because Task 4 takes admitted[0].

- [ ] **Step 3: Replace the post-filter logic in `scheduler.ts`**

In `src/core/scheduler/scheduler.ts`, replace the body of `schedule` after the `admitted.length === 0` check with:

```ts
    const winner = await this.pickWinner(ctx, admitted.map((entry) => entry.profile));
    const { session } = await this.bindPlugin.bind(ctx, winner);
    return { kind: "bound", profile: winner, session, reservationToken: undefined };
```

Add the new private method below `runFilters`:

```ts
  private async pickWinner(
    ctx: SchedulerContext,
    admitted: readonly RuntimeProfile[],
  ): Promise<RuntimeProfile> {
    if (admitted.length === 1) return admitted[0]!;

    const totals = new Map<string, number>();
    for (const profile of admitted) totals.set(profile.name, 0);

    for (const entry of this.scores) {
      const weight = entry.weight ?? 1;
      for (const profile of admitted) {
        const raw = await entry.plugin.score(ctx, profile);
        totals.set(profile.name, (totals.get(profile.name) ?? 0) + raw * weight);
      }
    }

    const orderIndex = (profile: RuntimeProfile): number =>
      ctx.profiles.findIndex((candidate) => candidate.name === profile.name);

    const ranked = [...admitted].sort((a, b) => {
      const diff = (totals.get(b.name) ?? 0) - (totals.get(a.name) ?? 0);
      if (diff !== 0) return diff;
      return orderIndex(a) - orderIndex(b);
    });
    return ranked[0]!;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: PASS (4 tests total in scheduler.test.ts).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/scheduler.ts src/core/scheduler/scheduler.test.ts
git commit -m "feat(scheduler): weighted scoring + stable tie-break (#300)"
```

---

## Task 6: Permit stage — granted/wait/denied short-circuits

**Files:**
- Modify: `src/core/scheduler/scheduler.ts`
- Modify: `src/core/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/core/scheduler/scheduler.test.ts`:

```ts
describe("Scheduler.schedule — permit stage", () => {
  test("permit wait short-circuits before bind", async () => {
    const bind = staticBind({ id: "s", role: "worker", status: "running" });
    const bindSpy = { called: false };
    const observingBind: BindPlugin = {
      name: "watch",
      bind: async (ctx, profile) => {
        bindSpy.called = true;
        return bind.bind(ctx, profile);
      },
    };
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        { name: "manual", permit: async () => ({ status: "wait", reason: "awaiting-user" }) },
      ],
      bindPlugin: observingBind,
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("wait");
    expect(bindSpy.called).toBe(false);
    if (result.kind === "wait") {
      expect(result.plugin).toBe("manual");
      expect(result.reason).toBe("awaiting-user");
      expect(result.profile.name).toBe("a");
    }
  });

  test("permit denied short-circuits before bind", async () => {
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        { name: "policy", permit: async () => ({ status: "denied", reason: "not-allowed" }) },
      ],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.plugin).toBe("policy");
      expect(result.reason).toBe("not-allowed");
    }
  });

  test("permit stage stops at first non-granted verdict", async () => {
    const calls: string[] = [];
    const scheduler = new Scheduler({
      profiles: [profile("a")],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [
        {
          name: "first",
          permit: async () => {
            calls.push("first");
            return { status: "wait", reason: "later" };
          },
        },
        {
          name: "second",
          permit: async () => {
            calls.push("second");
            return { status: "granted" };
          },
        },
      ],
      bindPlugin: staticBind({ id: "s", role: "worker", status: "running" }),
      store: emptyStore(),
      now: () => 0,
    });

    await scheduler.schedule(taskView());

    expect(calls).toEqual(["first"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: FAIL — permits not yet consulted, scheduler binds anyway.

- [ ] **Step 3: Insert permit stage in `scheduler.ts`**

In `src/core/scheduler/scheduler.ts`, change `schedule()` so the section between `pickWinner` and `bindPlugin.bind` becomes:

```ts
    const winner = await this.pickWinner(ctx, admitted.map((entry) => entry.profile));

    for (const plugin of this.permits) {
      const verdict = await plugin.permit(ctx, winner);
      if (verdict.status === "denied") {
        return {
          kind: "denied",
          plugin: plugin.name,
          reason: verdict.reason,
          message: verdict.message,
        };
      }
      if (verdict.status === "wait") {
        return {
          kind: "wait",
          plugin: plugin.name,
          reason: verdict.reason,
          message: verdict.message,
          profile: winner,
        };
      }
    }

    const { session } = await this.bindPlugin.bind(ctx, winner);
    return { kind: "bound", profile: winner, session, reservationToken: undefined };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/scheduler.ts src/core/scheduler/scheduler.test.ts
git commit -m "feat(scheduler): permit stage short-circuits bind (#300)"
```

---

## Task 7: Scheduler — empty profiles → fallback synthesized

**Files:**
- Modify: `src/core/scheduler/scheduler.test.ts`

The fallback path was implemented in Task 4 (`profiles.length > 0 ? ... : synthesizeFallbackProfile(task)`). Add a test that proves it.

- [ ] **Step 1: Add failing test**

Append to `src/core/scheduler/scheduler.test.ts`:

```ts
describe("Scheduler.schedule — fallback profile", () => {
  test("synthesizes a single profile from task.spec.runtime when none configured", async () => {
    const bindCalls: RuntimeProfile[] = [];
    const scheduler = new Scheduler({
      profiles: [],
      filters: [alwaysAdmit("admit-all")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: {
        name: "capture",
        bind: async (_ctx, profile) => {
          bindCalls.push(profile);
          return { session: { id: "s", role: "worker", status: "running" } };
        },
      },
      store: emptyStore(),
      now: () => 0,
    });

    const result = await scheduler.schedule(taskView());

    expect(result.kind).toBe("bound");
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0]?.name).toBe("fallback-claude");
    expect(bindCalls[0]?.runtimeCommand).toBe("claude");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/core/scheduler/scheduler.test.ts`
Expected: PASS — falls out of existing fallback logic.

If it fails, recheck Task 4 step 3's `profiles` resolution.

- [ ] **Step 3: Commit**

```bash
git add src/core/scheduler/scheduler.test.ts
git commit -m "test(scheduler): cover empty-profiles fallback synthesis (#300)"
```

---

## Task 8: RuntimeCapability filter

**Files:**
- Create: `src/core/scheduler/plugins/runtime-capability.ts`
- Create: `src/core/scheduler/plugins/runtime-capability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/runtime-capability.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { RuntimeCapabilityFilter } from "./runtime-capability.js";

function makeCtx(task: AgentTaskView, profiles: RuntimeProfile[] = []): SchedulerContext {
  return {
    task,
    profiles,
    store: { listAgentTaskEntities: async () => [] },
    now: () => 0,
  };
}

function task(overrides: Partial<AgentTaskView["spec"]> = {}): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...overrides,
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    name: "p",
    platform: "claude-code",
    runtimeCommand: "claude",
    ...overrides,
  };
}

describe("RuntimeCapabilityFilter", () => {
  const filter = new RuntimeCapabilityFilter();

  test("admits when task.spec.runtime matches profile.runtimeCommand", async () => {
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task.spec.runtime mismatches profile.runtimeCommand", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ runtime: "codex" })),
      profile({ runtimeCommand: "claude" }),
    );
    expect(verdict).toEqual({
      admit: false,
      reason: "runtime-mismatch",
      message: "task pins runtime 'codex' but profile runs 'claude'",
    });
  });

  test("rejects when profile.supportedRoles excludes task.spec.role", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ role: "reviewer" })),
      profile({ supportedRoles: ["worker"] }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("role-unsupported");
  });

  test("admits when profile.supportedRoles is undefined regardless of role", async () => {
    const verdict = await filter.filter(makeCtx(task({ role: "anything" })), profile());
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task asks for a model not in profile.budget.allowedModels", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ budget: { model: "claude-haiku-4-5" } })),
      profile({ budget: { allowedModels: ["claude-opus-4-7"] } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("model-not-allowed");
  });

  test("admits when budget.allowedModels is undefined", async () => {
    const verdict = await filter.filter(
      makeCtx(task({ budget: { model: "anything" } })),
      profile(),
    );
    expect(verdict).toEqual({ admit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/runtime-capability.test.ts`
Expected: FAIL — `RuntimeCapabilityFilter` not exported.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/runtime-capability.ts`:

```ts
import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export class RuntimeCapabilityFilter implements FilterPlugin {
  readonly name = "RuntimeCapability";

  async filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict> {
    const requestedRuntime = ctx.task.spec.runtime;
    if (
      typeof requestedRuntime === "string" &&
      requestedRuntime.length > 0 &&
      requestedRuntime !== profile.runtimeCommand
    ) {
      return {
        admit: false,
        reason: "runtime-mismatch",
        message: `task pins runtime '${requestedRuntime}' but profile runs '${profile.runtimeCommand}'`,
      };
    }

    if (profile.supportedRoles !== undefined && !profile.supportedRoles.includes(ctx.task.spec.role)) {
      return {
        admit: false,
        reason: "role-unsupported",
        message: `profile '${profile.name}' does not support role '${ctx.task.spec.role}'`,
      };
    }

    const requestedModel = readBudgetString(ctx.task.spec.budget, "model");
    const allowedModels = profile.budget?.allowedModels;
    if (
      requestedModel !== undefined &&
      allowedModels !== undefined &&
      !allowedModels.includes(requestedModel)
    ) {
      return {
        admit: false,
        reason: "model-not-allowed",
        message: `profile '${profile.name}' does not allow model '${requestedModel}'`,
      };
    }

    return { admit: true };
  }
}

function readBudgetString(budget: unknown, key: string): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/runtime-capability.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/runtime-capability.ts src/core/scheduler/plugins/runtime-capability.test.ts
git commit -m "feat(scheduler): RuntimeCapability filter plugin (#300)"
```

---

## Task 9: BudgetRemaining filter

**Files:**
- Create: `src/core/scheduler/plugins/budget-remaining.ts`
- Create: `src/core/scheduler/plugins/budget-remaining.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/budget-remaining.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { BudgetRemainingFilter, type BudgetLedger } from "./budget-remaining.js";

function makeCtx(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

function task(overrides: Partial<AgentTaskView["spec"]> = {}): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...overrides,
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return { name: "p", platform: "claude-code", runtimeCommand: "claude", ...overrides };
}

describe("BudgetRemainingFilter", () => {
  test("admits when task budget fits within profile budget", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 5 }, maxTurns: 10 })),
      profile({ budget: { maxCostUsd: 10, maxTurns: 50 } }),
    );
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when task maxCostUsd exceeds profile maxCostUsd", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 20 } })),
      profile({ budget: { maxCostUsd: 10 } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("budget-exceeds-profile");
  });

  test("rejects when task maxTurns exceeds profile maxTurns", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ maxTurns: 100 })),
      profile({ budget: { maxTurns: 50 } }),
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("turns-exceeds-profile");
  });

  test("admits when profile budget is undefined regardless of task budget", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(
      makeCtx(task({ budget: { maxCostUsd: 999 } })),
      profile(),
    );
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when task budget is undefined", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(makeCtx(task()), profile({ budget: { maxCostUsd: 1 } }));
    expect(verdict).toEqual({ admit: true });
  });

  test("ledger that returns false rejects with ledger-exhausted reason", async () => {
    const ledger: BudgetLedger = { hasRemaining: async () => false };
    const filter = new BudgetRemainingFilter({ ledger });
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) expect(verdict.reason).toBe("ledger-exhausted");
  });

  test("default ledger is permissive", async () => {
    const filter = new BudgetRemainingFilter();
    const verdict = await filter.filter(makeCtx(task()), profile());
    expect(verdict).toEqual({ admit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/budget-remaining.test.ts`
Expected: FAIL — `BudgetRemainingFilter` not exported.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/budget-remaining.ts`:

```ts
import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import type { AgentTaskView } from "../../agent-task.js";

export interface BudgetLedger {
  hasRemaining(profile: RuntimeProfile, task: AgentTaskView): Promise<boolean>;
}

const PERMISSIVE_LEDGER: BudgetLedger = {
  hasRemaining: async () => true,
};

export interface BudgetRemainingFilterOptions {
  readonly ledger?: BudgetLedger | undefined;
}

export class BudgetRemainingFilter implements FilterPlugin {
  readonly name = "BudgetRemaining";
  private readonly ledger: BudgetLedger;

  constructor(options: BudgetRemainingFilterOptions = {}) {
    this.ledger = options.ledger ?? PERMISSIVE_LEDGER;
  }

  async filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict> {
    const requestedCost = readBudgetNumber(ctx.task.spec.budget, "maxCostUsd");
    if (
      requestedCost !== undefined &&
      profile.budget?.maxCostUsd !== undefined &&
      requestedCost > profile.budget.maxCostUsd
    ) {
      return {
        admit: false,
        reason: "budget-exceeds-profile",
        message: `task wants $${requestedCost} but profile '${profile.name}' caps at $${profile.budget.maxCostUsd}`,
      };
    }

    const requestedTurns = ctx.task.spec.maxTurns;
    if (
      requestedTurns !== undefined &&
      profile.budget?.maxTurns !== undefined &&
      requestedTurns > profile.budget.maxTurns
    ) {
      return {
        admit: false,
        reason: "turns-exceeds-profile",
        message: `task wants ${requestedTurns} turns but profile '${profile.name}' caps at ${profile.budget.maxTurns}`,
      };
    }

    const hasRemaining = await this.ledger.hasRemaining(profile, ctx.task);
    if (!hasRemaining) {
      return {
        admit: false,
        reason: "ledger-exhausted",
        message: `ledger reports no remaining budget for profile '${profile.name}'`,
      };
    }

    return { admit: true };
  }
}

function readBudgetNumber(budget: unknown, key: string): number | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/budget-remaining.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/budget-remaining.ts src/core/scheduler/plugins/budget-remaining.test.ts
git commit -m "feat(scheduler): BudgetRemaining filter plugin (#300)"
```

---

## Task 10: WorktreeExclusivity filter

**Files:**
- Create: `src/core/scheduler/plugins/worktree-exclusivity.ts`
- Create: `src/core/scheduler/plugins/worktree-exclusivity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/worktree-exclusivity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskEntity, AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase, agentTaskViewToEntity } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { WorktreeExclusivityFilter } from "./worktree-exclusivity.js";

function view(id: string, worktree: string, phase: AgentTaskPhase): AgentTaskView {
  return {
    spec: {
      id,
      worktree,
      runtime: "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
    status: {
      id,
      phase,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function ctxWith(task: AgentTaskView, others: readonly AgentTaskView[]): SchedulerContext {
  const entities: AgentTaskEntity[] = [task, ...others].map((v) => agentTaskViewToEntity(v));
  return {
    task,
    profiles: [],
    store: { listAgentTaskEntities: async () => entities },
    now: () => 0,
  };
}

const profile: RuntimeProfile = { name: "p", platform: "claude-code", runtimeCommand: "claude" };

describe("WorktreeExclusivityFilter", () => {
  const filter = new WorktreeExclusivityFilter();

  test("admits when no other task shares the worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const verdict = await filter.filter(ctxWith(task, []), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("rejects when another Running task shares the worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/a", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.reason).toBe("worktree-busy");
      expect(verdict.message).toContain("other");
    }
  });

  test("admits when other task on same worktree is Succeeded", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/a", AgentTaskPhase.Succeeded);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when other Running task is on a different worktree", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.PendingBind);
    const other = view("other", "/w/b", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, [other]), profile);
    expect(verdict).toEqual({ admit: true });
  });

  test("admits when the only Running task on the worktree is the task itself", async () => {
    const task = view("self", "/w/a", AgentTaskPhase.Running);
    const verdict = await filter.filter(ctxWith(task, []), profile);
    expect(verdict).toEqual({ admit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/worktree-exclusivity.test.ts`
Expected: FAIL — plugin missing.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/worktree-exclusivity.ts`:

```ts
import type { FilterPlugin, FilterVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export class WorktreeExclusivityFilter implements FilterPlugin {
  readonly name = "WorktreeExclusivity";

  async filter(ctx: SchedulerContext, _profile: RuntimeProfile): Promise<FilterVerdict> {
    const entities = await ctx.store.listAgentTaskEntities();
    const worktree = ctx.task.spec.worktree;
    const selfId = ctx.task.spec.id;
    const conflict = entities.find(
      (entity) =>
        entity.id !== selfId &&
        entity.spec.worktree === worktree &&
        entity.status.phase === "Running",
    );
    if (conflict !== undefined) {
      return {
        admit: false,
        reason: "worktree-busy",
        message: `running task '${conflict.id}' holds worktree '${worktree}'`,
      };
    }
    return { admit: true };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/worktree-exclusivity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/worktree-exclusivity.ts src/core/scheduler/plugins/worktree-exclusivity.test.ts
git commit -m "feat(scheduler): WorktreeExclusivity filter plugin (#300)"
```

---

## Task 11: TaskAffinity score

**Files:**
- Create: `src/core/scheduler/plugins/task-affinity.ts`
- Create: `src/core/scheduler/plugins/task-affinity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/task-affinity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskView } from "../../agent-task.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { TaskAffinityScore } from "./task-affinity.js";

function ctxWith(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

function task(
  overrides: { runtime?: string; affinity?: Readonly<Record<string, string>> } = {},
): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: overrides.runtime ?? "claude",
      role: "worker",
      prompt: "p",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...(overrides.affinity === undefined ? {} : { budget: { affinity: overrides.affinity } }),
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

function profile(labels?: Record<string, string>): RuntimeProfile {
  return {
    name: "p",
    platform: "claude-code",
    runtimeCommand: "claude",
    ...(labels === undefined ? {} : { labels }),
  };
}

describe("TaskAffinityScore", () => {
  const score = new TaskAffinityScore();

  test("returns 100 when every requested label matches", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium", region: "us" } })),
      profile({ tier: "premium", region: "us" }),
    );
    expect(value).toBe(100);
  });

  test("returns 50 when half the requested labels match", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium", region: "us" } })),
      profile({ tier: "premium", region: "eu" }),
    );
    expect(value).toBe(50);
  });

  test("returns 0 when no requested labels match", async () => {
    const value = await score.score(
      ctxWith(task({ affinity: { tier: "premium" } })),
      profile({ tier: "free" }),
    );
    expect(value).toBe(0);
  });

  test("returns neutral 50 when no affinity requested and no runtime hint", async () => {
    const value = await score.score(ctxWith(task({ runtime: "" })), profile());
    expect(value).toBe(50);
  });

  test("derives default affinity from task.spec.runtime when budget.affinity absent", async () => {
    const match = await score.score(ctxWith(task({ runtime: "claude" })), profile({ runtime: "claude" }));
    const miss = await score.score(ctxWith(task({ runtime: "claude" })), profile({ runtime: "codex" }));
    expect(match).toBe(100);
    expect(miss).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/task-affinity.test.ts`
Expected: FAIL — plugin missing.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/task-affinity.ts`:

```ts
import type { SchedulerContext, ScorePlugin } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

const NEUTRAL_SCORE = 50;

export class TaskAffinityScore implements ScorePlugin {
  readonly name = "TaskAffinity";

  async score(ctx: SchedulerContext, profile: RuntimeProfile): Promise<number> {
    const requested = resolveRequestedLabels(ctx);
    const keys = Object.keys(requested);
    if (keys.length === 0) return NEUTRAL_SCORE;

    const labels = profile.labels ?? {};
    let matched = 0;
    for (const key of keys) {
      if (labels[key] === requested[key]) matched += 1;
    }
    return Math.round((100 * matched) / keys.length);
  }
}

function resolveRequestedLabels(ctx: SchedulerContext): Readonly<Record<string, string>> {
  const fromBudget = readAffinityFromBudget(ctx.task.spec.budget);
  if (fromBudget !== undefined && Object.keys(fromBudget).length > 0) return fromBudget;

  const runtime = ctx.task.spec.runtime;
  if (typeof runtime === "string" && runtime.length > 0) return { runtime };

  return {};
}

function readAffinityFromBudget(budget: unknown): Readonly<Record<string, string>> | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as { affinity?: unknown }).affinity;
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/task-affinity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/task-affinity.ts src/core/scheduler/plugins/task-affinity.test.ts
git commit -m "feat(scheduler): TaskAffinity score plugin (#300)"
```

---

## Task 12: AutoPermit

**Files:**
- Create: `src/core/scheduler/plugins/auto-permit.ts`
- Create: `src/core/scheduler/plugins/auto-permit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/auto-permit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTaskPhase } from "../../agent-task.js";
import type { AgentTaskView } from "../../agent-task.js";
import { AutoPermit } from "./auto-permit.js";

const task: AgentTaskView = {
  spec: {
    id: "t",
    worktree: "/tmp/w",
    runtime: "claude",
    role: "worker",
    prompt: "p",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
  },
  status: {
    id: "t",
    phase: AgentTaskPhase.PendingBind,
    contributions: [],
    conditions: [],
    observedGeneration: 0,
    lastTransitionAt: "2026-05-16T00:00:00.000Z",
    revision: 1,
  },
};

describe("AutoPermit", () => {
  test("always grants", async () => {
    const permit = new AutoPermit();
    const ctx = { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
    const verdict = await permit.permit(ctx, {
      name: "p",
      platform: "claude-code",
      runtimeCommand: "claude",
    });
    expect(verdict).toEqual({ status: "granted" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/auto-permit.test.ts`
Expected: FAIL — `AutoPermit` not exported.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/auto-permit.ts`:

```ts
import type { PermitPlugin, PermitVerdict } from "../framework.js";

export class AutoPermit implements PermitPlugin {
  readonly name = "AutoPermit";

  async permit(): Promise<PermitVerdict> {
    return { status: "granted" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/auto-permit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/auto-permit.ts src/core/scheduler/plugins/auto-permit.test.ts
git commit -m "feat(scheduler): AutoPermit plugin (#300)"
```

---

## Task 13: UserConfirmPermit (shape + in-memory store)

**Files:**
- Create: `src/core/scheduler/plugins/user-confirm-permit.ts`
- Create: `src/core/scheduler/plugins/user-confirm-permit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/user-confirm-permit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTaskPhase } from "../../agent-task.js";
import type { AgentTaskView } from "../../agent-task.js";
import type { SchedulerContext } from "../framework.js";
import {
  InMemoryPermitDecisionStore,
  UserConfirmPermit,
} from "./user-confirm-permit.js";

function ctx(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

const task: AgentTaskView = {
  spec: {
    id: "t",
    worktree: "/tmp/w",
    runtime: "claude",
    role: "worker",
    prompt: "p",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
  },
  status: {
    id: "t",
    phase: AgentTaskPhase.PendingBind,
    contributions: [],
    conditions: [],
    observedGeneration: 0,
    lastTransitionAt: "2026-05-16T00:00:00.000Z",
    revision: 1,
  },
};

const profile = { name: "p", platform: "claude-code", runtimeCommand: "claude" } as const;

describe("UserConfirmPermit", () => {
  test("returns wait when no decision present", async () => {
    const store = new InMemoryPermitDecisionStore();
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(task), profile);
    expect(verdict).toEqual({
      status: "wait",
      reason: "awaiting-user-confirmation",
      message: "no decision recorded for task 't' / profile 'p' / generation 1",
    });
  });

  test("returns granted when decision approved", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({ taskId: "t", profileName: "p", generation: 1, approved: true });
    const permit = new UserConfirmPermit({ store });
    expect(await permit.permit(ctx(task), profile)).toEqual({ status: "granted" });
  });

  test("returns denied with stored reason when decision rejected", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({
      taskId: "t",
      profileName: "p",
      generation: 1,
      approved: false,
      reason: "too-expensive",
    });
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(task), profile);
    expect(verdict).toEqual({ status: "denied", reason: "too-expensive" });
  });

  test("decisions for older generations do not apply to newer task generations", async () => {
    const store = new InMemoryPermitDecisionStore();
    await store.record({ taskId: "t", profileName: "p", generation: 1, approved: true });
    const newer: AgentTaskView = {
      spec: { ...task.spec, generation: 2 },
      status: task.status,
    };
    const permit = new UserConfirmPermit({ store });
    const verdict = await permit.permit(ctx(newer), profile);
    expect(verdict.status).toBe("wait");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/user-confirm-permit.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the plugin + in-memory store**

Create `src/core/scheduler/plugins/user-confirm-permit.ts`:

```ts
import type { PermitPlugin, PermitVerdict, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export interface PermitDecision {
  readonly approved: boolean;
  readonly reason?: string | undefined;
}

export interface PermitDecisionLookup {
  readonly taskId: string;
  readonly profileName: string;
  readonly generation: number;
}

export interface PermitDecisionRecord extends PermitDecisionLookup, PermitDecision {}

export interface PermitDecisionStore {
  lookup(query: PermitDecisionLookup): Promise<PermitDecision | undefined>;
}

export class InMemoryPermitDecisionStore implements PermitDecisionStore {
  private readonly map = new Map<string, PermitDecision>();

  async record(record: PermitDecisionRecord): Promise<void> {
    const { approved } = record;
    const decision: PermitDecision = record.reason === undefined ? { approved } : { approved, reason: record.reason };
    this.map.set(keyOf(record), decision);
  }

  async lookup(query: PermitDecisionLookup): Promise<PermitDecision | undefined> {
    return this.map.get(keyOf(query));
  }
}

export interface UserConfirmPermitOptions {
  readonly store: PermitDecisionStore;
}

export class UserConfirmPermit implements PermitPlugin {
  readonly name = "UserConfirmPermit";
  private readonly store: PermitDecisionStore;

  constructor(options: UserConfirmPermitOptions) {
    this.store = options.store;
  }

  async permit(ctx: SchedulerContext, profile: RuntimeProfile): Promise<PermitVerdict> {
    const decision = await this.store.lookup({
      taskId: ctx.task.spec.id,
      profileName: profile.name,
      generation: ctx.task.spec.generation,
    });
    if (decision === undefined) {
      return {
        status: "wait",
        reason: "awaiting-user-confirmation",
        message: `no decision recorded for task '${ctx.task.spec.id}' / profile '${profile.name}' / generation ${ctx.task.spec.generation}`,
      };
    }
    if (decision.approved) return { status: "granted" };
    return decision.reason === undefined
      ? { status: "denied", reason: "user-denied" }
      : { status: "denied", reason: decision.reason };
  }
}

function keyOf(query: PermitDecisionLookup): string {
  return `${query.taskId}::${query.profileName}::${query.generation}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/user-confirm-permit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/user-confirm-permit.ts src/core/scheduler/plugins/user-confirm-permit.test.ts
git commit -m "feat(scheduler): UserConfirmPermit shape + in-memory store (#300)"
```

---

## Task 14: DefaultBind plugin

**Files:**
- Create: `src/core/scheduler/plugins/default-bind.ts`
- Create: `src/core/scheduler/plugins/default-bind.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/default-bind.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentRuntime, AgentSession } from "../../agent-runtime.js";
import { AgentTaskPhase } from "../../agent-task.js";
import type { AgentTaskView } from "../../agent-task.js";
import type { AgentSessionEntity } from "../../entity.js";
import type { SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";
import { DefaultBindPlugin } from "./default-bind.js";

class FakeRuntime implements AgentRuntime {
  spawnCalls: Array<{ role: string; config: AgentConfig }> = [];
  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, config });
    return { id: "s-1", role, status: "running", platform: config.platform, model: config.model };
  }
  async send(): Promise<never> {
    throw new Error("unused");
  }
  async close(): Promise<void> {}
  onIdle(): void {}
  async listSessions(): Promise<readonly AgentSession[]> {
    return [];
  }
  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function ctx(task: AgentTaskView): SchedulerContext {
  return { task, profiles: [], store: { listAgentTaskEntities: async () => [] }, now: () => 0 };
}

function taskWith(spec: Partial<AgentTaskView["spec"]>): AgentTaskView {
  return {
    spec: {
      id: "t",
      worktree: "/tmp/w",
      runtime: "codex",
      role: "worker",
      prompt: "do work",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-05-16T00:00:00.000Z",
      ...spec,
    },
    status: {
      id: "t",
      phase: AgentTaskPhase.PendingBind,
      contributions: [],
      conditions: [],
      observedGeneration: 0,
      lastTransitionAt: "2026-05-16T00:00:00.000Z",
      revision: 1,
    },
  };
}

const profile: RuntimeProfile = {
  name: "claude-opus",
  platform: "claude-code",
  runtimeCommand: "claude",
  model: "claude-opus-4-7",
};

describe("DefaultBindPlugin", () => {
  test("profile fields override task.spec.runtime when spawning", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(ctx(taskWith({ runtime: "codex" })), profile);
    const call = runtime.spawnCalls[0];
    expect(call?.config.command).toBe("claude");
    expect(call?.config.platform).toBe("claude-code");
    expect(call?.config.model).toBe("claude-opus-4-7");
  });

  test("falls back to task budget.model when profile.model undefined", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(
      ctx(taskWith({ budget: { model: "claude-haiku" } })),
      { ...profile, model: undefined },
    );
    expect(runtime.spawnCalls[0]?.config.model).toBe("claude-haiku");
  });

  test("injects GROVE_AGENT_TASK_* env vars", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    await plugin.bind(ctx(taskWith({ id: "task-42", generation: 7 })), profile);
    const env = runtime.spawnCalls[0]?.config.env ?? {};
    expect(env.GROVE_AGENT_TASK_ID).toBe("task-42");
    expect(env.GROVE_AGENT_TASK_GENERATION).toBe("7");
    expect(env.GROVE_AGENT_TASK_RUNTIME).toBe("claude");
  });

  test("returns session id from runtime.spawn", async () => {
    const runtime = new FakeRuntime();
    const plugin = new DefaultBindPlugin({ runtime });
    const result = await plugin.bind(ctx(taskWith({})), profile);
    expect(result.session.id).toBe("s-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/default-bind.test.ts`
Expected: FAIL — `DefaultBindPlugin` not exported.

- [ ] **Step 3: Implement the plugin**

Create `src/core/scheduler/plugins/default-bind.ts`:

```ts
import type { AgentConfig, AgentRuntime } from "../../agent-runtime.js";
import type { BindPlugin, BindResult, SchedulerContext } from "../framework.js";
import type { RuntimeProfile } from "../profile.js";

export interface DefaultBindPluginOptions {
  readonly runtime: Pick<AgentRuntime, "spawn">;
}

export class DefaultBindPlugin implements BindPlugin {
  readonly name = "DefaultBind";
  private readonly runtime: Pick<AgentRuntime, "spawn">;

  constructor(options: DefaultBindPluginOptions) {
    this.runtime = options.runtime;
  }

  async bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<BindResult> {
    const model = profile.model ?? readBudgetString(ctx.task.spec.budget, "model");
    const config: AgentConfig = {
      role: ctx.task.spec.role,
      command: profile.runtimeCommand,
      cwd: ctx.task.spec.worktree,
      goal: ctx.task.spec.prompt,
      prompt: ctx.task.spec.prompt,
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
}

function readBudgetString(budget: unknown, key: string): string | undefined {
  if (budget === null || typeof budget !== "object") return undefined;
  const value = (budget as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/default-bind.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/default-bind.ts src/core/scheduler/plugins/default-bind.test.ts
git commit -m "feat(scheduler): DefaultBind plugin (#300)"
```

---

## Task 15: Built-in plugin registry

**Files:**
- Create: `src/core/scheduler/plugins/index.ts`
- Create: `src/core/scheduler/plugins/index.test.ts`

The registry exports plugin factories keyed by the names used in config (`RuntimeCapability`, `BudgetRemaining`, etc.).

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/plugins/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../../agent-runtime.js";
import type { AgentSessionEntity } from "../../entity.js";
import {
  BUILTIN_FILTER_FACTORIES,
  BUILTIN_SCORE_FACTORIES,
  BUILTIN_PERMIT_FACTORIES,
  BUILTIN_BIND_FACTORIES,
  builtinPluginNames,
} from "./index.js";

function fakeRuntime(): AgentRuntime {
  return {
    spawn: async () => ({ id: "s", role: "r", status: "running" }),
    send: async () => {
      throw new Error("unused");
    },
    close: async () => {},
    onIdle: () => {},
    listSessions: async () => [],
    listSessionEntities: async () => [] as readonly AgentSessionEntity[],
    isAvailable: async () => true,
  };
}

describe("builtin plugin registry", () => {
  test("filter factories include the three default filters", () => {
    expect(Object.keys(BUILTIN_FILTER_FACTORIES).sort()).toEqual([
      "BudgetRemaining",
      "RuntimeCapability",
      "WorktreeExclusivity",
    ]);
  });

  test("score factories include TaskAffinity", () => {
    expect(Object.keys(BUILTIN_SCORE_FACTORIES)).toContain("TaskAffinity");
  });

  test("permit factories include AutoPermit and UserConfirmPermit", () => {
    expect(Object.keys(BUILTIN_PERMIT_FACTORIES).sort()).toEqual(["AutoPermit", "UserConfirmPermit"]);
  });

  test("bind factories include DefaultBind", () => {
    expect(Object.keys(BUILTIN_BIND_FACTORIES)).toEqual(["DefaultBind"]);
  });

  test("builtinPluginNames lists every plugin", () => {
    expect(builtinPluginNames()).toEqual(
      expect.arrayContaining([
        "RuntimeCapability",
        "BudgetRemaining",
        "WorktreeExclusivity",
        "TaskAffinity",
        "AutoPermit",
        "UserConfirmPermit",
        "DefaultBind",
      ]),
    );
  });

  test("factories produce instances with the expected name", () => {
    const filter = BUILTIN_FILTER_FACTORIES.RuntimeCapability({});
    const score = BUILTIN_SCORE_FACTORIES.TaskAffinity({});
    const permit = BUILTIN_PERMIT_FACTORIES.AutoPermit({});
    const bind = BUILTIN_BIND_FACTORIES.DefaultBind({ runtime: fakeRuntime() });
    expect(filter.name).toBe("RuntimeCapability");
    expect(score.name).toBe("TaskAffinity");
    expect(permit.name).toBe("AutoPermit");
    expect(bind.name).toBe("DefaultBind");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/plugins/index.test.ts`
Expected: FAIL — registry not exported.

- [ ] **Step 3: Implement the registry**

Create `src/core/scheduler/plugins/index.ts`:

```ts
import type { AgentRuntime } from "../../agent-runtime.js";
import type { BindPlugin, FilterPlugin, PermitPlugin, ScorePlugin } from "../framework.js";
import { AutoPermit } from "./auto-permit.js";
import { BudgetRemainingFilter, type BudgetLedger } from "./budget-remaining.js";
import { DefaultBindPlugin } from "./default-bind.js";
import { RuntimeCapabilityFilter } from "./runtime-capability.js";
import { TaskAffinityScore } from "./task-affinity.js";
import {
  InMemoryPermitDecisionStore,
  type PermitDecisionStore,
  UserConfirmPermit,
} from "./user-confirm-permit.js";
import { WorktreeExclusivityFilter } from "./worktree-exclusivity.js";

export interface FilterFactoryArgs {
  readonly ledger?: BudgetLedger | undefined;
}

export interface ScoreFactoryArgs {
  readonly weight?: number | undefined;
}

export interface PermitFactoryArgs {
  readonly permitDecisionStore?: PermitDecisionStore | undefined;
}

export interface BindFactoryArgs {
  readonly runtime: AgentRuntime;
}

export const BUILTIN_FILTER_FACTORIES: Readonly<
  Record<string, (args: FilterFactoryArgs) => FilterPlugin>
> = Object.freeze({
  RuntimeCapability: () => new RuntimeCapabilityFilter(),
  BudgetRemaining: (args) =>
    new BudgetRemainingFilter(args.ledger === undefined ? {} : { ledger: args.ledger }),
  WorktreeExclusivity: () => new WorktreeExclusivityFilter(),
});

export const BUILTIN_SCORE_FACTORIES: Readonly<
  Record<string, (args: ScoreFactoryArgs) => ScorePlugin>
> = Object.freeze({
  TaskAffinity: () => new TaskAffinityScore(),
});

export const BUILTIN_PERMIT_FACTORIES: Readonly<
  Record<string, (args: PermitFactoryArgs) => PermitPlugin>
> = Object.freeze({
  AutoPermit: () => new AutoPermit(),
  UserConfirmPermit: (args) =>
    new UserConfirmPermit({ store: args.permitDecisionStore ?? new InMemoryPermitDecisionStore() }),
});

export const BUILTIN_BIND_FACTORIES: Readonly<
  Record<string, (args: BindFactoryArgs) => BindPlugin>
> = Object.freeze({
  DefaultBind: (args) => new DefaultBindPlugin({ runtime: args.runtime }),
});

export function builtinPluginNames(): readonly string[] {
  return [
    ...Object.keys(BUILTIN_FILTER_FACTORIES),
    ...Object.keys(BUILTIN_SCORE_FACTORIES),
    ...Object.keys(BUILTIN_PERMIT_FACTORIES),
    ...Object.keys(BUILTIN_BIND_FACTORIES),
  ];
}

export {
  AutoPermit,
  BudgetRemainingFilter,
  DefaultBindPlugin,
  InMemoryPermitDecisionStore,
  RuntimeCapabilityFilter,
  TaskAffinityScore,
  UserConfirmPermit,
  WorktreeExclusivityFilter,
};
export type { BudgetLedger, PermitDecisionStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/plugins/index.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/plugins/index.ts src/core/scheduler/plugins/index.test.ts
git commit -m "feat(scheduler): builtin plugin registry (#300)"
```

---

## Task 16: `SchedulerConfig` zod schema + `loadSchedulerConfig`

**Files:**
- Create: `src/core/scheduler/config.ts`
- Create: `src/core/scheduler/config.test.ts`

`loadSchedulerConfig` accepts the typed config and the runtime (needed by Bind factory). Returns `{ profiles, filters, scores, permits, bindPlugin }` ready for the `Scheduler` constructor.

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentSessionEntity } from "../entity.js";
import { loadSchedulerConfig, SchedulerConfigSchema } from "./config.js";

function fakeRuntime(): AgentRuntime {
  return {
    spawn: async () => ({ id: "s", role: "r", status: "running" }),
    send: async () => {
      throw new Error("unused");
    },
    close: async () => {},
    onIdle: () => {},
    listSessions: async () => [],
    listSessionEntities: async () => [] as readonly AgentSessionEntity[],
    isAvailable: async () => true,
  };
}

describe("SchedulerConfigSchema", () => {
  test("accepts a minimal config", () => {
    const parsed = SchedulerConfigSchema.parse({
      profiles: [
        { name: "p", platform: "claude-code", runtimeCommand: "claude" },
      ],
      pipeline: {
        filters: ["RuntimeCapability"],
        scores: [{ name: "TaskAffinity", weight: 1 }],
        permits: ["AutoPermit"],
        bind: "DefaultBind",
      },
    });
    expect(parsed.profiles).toHaveLength(1);
  });

  test("rejects negative score weight", () => {
    expect(() =>
      SchedulerConfigSchema.parse({
        profiles: [],
        pipeline: {
          filters: [],
          scores: [{ name: "TaskAffinity", weight: -1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      }),
    ).toThrow();
  });

  test("rejects missing platform", () => {
    expect(() =>
      SchedulerConfigSchema.parse({
        profiles: [{ name: "p", runtimeCommand: "claude" }],
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      }),
    ).toThrow();
  });
});

describe("loadSchedulerConfig", () => {
  test("resolves plugin names against the built-in registry", () => {
    const opts = loadSchedulerConfig(
      {
        profiles: [
          { name: "p", platform: "claude-code", runtimeCommand: "claude" },
        ],
        pipeline: {
          filters: ["RuntimeCapability", "BudgetRemaining", "WorktreeExclusivity"],
          scores: [{ name: "TaskAffinity", weight: 1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime: fakeRuntime() },
    );
    expect(opts.filters.map((f) => f.name)).toEqual([
      "RuntimeCapability",
      "BudgetRemaining",
      "WorktreeExclusivity",
    ]);
    expect(opts.scores).toHaveLength(1);
    expect(opts.scores[0]?.plugin.name).toBe("TaskAffinity");
    expect(opts.scores[0]?.weight).toBe(1);
    expect(opts.permits[0]?.name).toBe("AutoPermit");
    expect(opts.bindPlugin.name).toBe("DefaultBind");
    expect(opts.profiles).toHaveLength(1);
  });

  test("unknown plugin name yields a descriptive error listing known plugins", () => {
    expect(() =>
      loadSchedulerConfig(
        {
          profiles: [],
          pipeline: {
            filters: ["NotARealFilter"],
            scores: [],
            permits: ["AutoPermit"],
            bind: "DefaultBind",
          },
        },
        { runtime: fakeRuntime() },
      ),
    ).toThrow(/NotARealFilter.*known plugins/i);
  });

  test("default ledger is permissive", () => {
    const opts = loadSchedulerConfig(
      {
        profiles: [],
        pipeline: {
          filters: ["BudgetRemaining"],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime: fakeRuntime() },
    );
    expect(opts.filters[0]?.name).toBe("BudgetRemaining");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/scheduler/config.test.ts`
Expected: FAIL — `config.js` does not exist.

- [ ] **Step 3: Implement the schema + loader**

Create `src/core/scheduler/config.ts`:

```ts
import { z } from "zod";
import type { AgentRuntime } from "../agent-runtime.js";
import type { BindPlugin, FilterPlugin, PermitPlugin, ScorePlugin } from "./framework.js";
import {
  BUILTIN_BIND_FACTORIES,
  BUILTIN_FILTER_FACTORIES,
  BUILTIN_PERMIT_FACTORIES,
  BUILTIN_SCORE_FACTORIES,
  builtinPluginNames,
  type BudgetLedger,
  type PermitDecisionStore,
} from "./plugins/index.js";
import type { RuntimeProfile } from "./profile.js";
import type { ScorePluginEntry } from "./scheduler.js";

const PlatformSchema = z.enum(["claude-code", "codex", "gemini"]);

const RuntimeProfileBudgetSchema = z
  .object({
    maxCostUsd: z.number().nonnegative().optional(),
    maxTurns: z.number().int().nonnegative().optional(),
    allowedModels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const RuntimeProfileSchema = z
  .object({
    name: z.string().min(1).max(128),
    platform: PlatformSchema,
    runtimeCommand: z.string().min(1).max(128),
    model: z.string().min(1).max(128).optional(),
    supportedRoles: z.array(z.string().min(1).max(64)).optional(),
    budget: RuntimeProfileBudgetSchema.optional(),
    labels: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

const PipelineSchema = z
  .object({
    filters: z.array(z.string().min(1)).default([]),
    scores: z
      .array(
        z
          .object({
            name: z.string().min(1),
            weight: z.number().nonnegative().default(1),
          })
          .strict(),
      )
      .default([]),
    permits: z.array(z.string().min(1)).default(["AutoPermit"]),
    bind: z.string().min(1).default("DefaultBind"),
  })
  .strict();

export const SchedulerConfigSchema = z
  .object({
    profiles: z.array(RuntimeProfileSchema).default([]),
    pipeline: PipelineSchema.default({
      filters: [],
      scores: [],
      permits: ["AutoPermit"],
      bind: "DefaultBind",
    }),
  })
  .strict();

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

export interface LoadSchedulerConfigDeps {
  readonly runtime: AgentRuntime;
  readonly ledger?: BudgetLedger | undefined;
  readonly permitDecisionStore?: PermitDecisionStore | undefined;
}

export interface LoadedSchedulerConfig {
  readonly profiles: readonly RuntimeProfile[];
  readonly filters: readonly FilterPlugin[];
  readonly scores: readonly ScorePluginEntry[];
  readonly permits: readonly PermitPlugin[];
  readonly bindPlugin: BindPlugin;
}

export function loadSchedulerConfig(
  raw: unknown,
  deps: LoadSchedulerConfigDeps,
): LoadedSchedulerConfig {
  const config = SchedulerConfigSchema.parse(raw);

  const filters = config.pipeline.filters.map((name) => {
    const factory = BUILTIN_FILTER_FACTORIES[name];
    if (factory === undefined) throw unknownPluginError("filter", name);
    return factory(deps.ledger === undefined ? {} : { ledger: deps.ledger });
  });

  const scores: ScorePluginEntry[] = config.pipeline.scores.map((entry) => {
    const factory = BUILTIN_SCORE_FACTORIES[entry.name];
    if (factory === undefined) throw unknownPluginError("score", entry.name);
    return { plugin: factory({}), weight: entry.weight };
  });

  const permits = config.pipeline.permits.map((name) => {
    const factory = BUILTIN_PERMIT_FACTORIES[name];
    if (factory === undefined) throw unknownPluginError("permit", name);
    return factory(
      deps.permitDecisionStore === undefined
        ? {}
        : { permitDecisionStore: deps.permitDecisionStore },
    );
  });

  const bindFactory = BUILTIN_BIND_FACTORIES[config.pipeline.bind];
  if (bindFactory === undefined) throw unknownPluginError("bind", config.pipeline.bind);
  const bindPlugin = bindFactory({ runtime: deps.runtime });

  const profiles: readonly RuntimeProfile[] = config.profiles.map((profile) => ({
    name: profile.name,
    platform: profile.platform,
    runtimeCommand: profile.runtimeCommand,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.supportedRoles === undefined ? {} : { supportedRoles: profile.supportedRoles }),
    ...(profile.budget === undefined ? {} : { budget: profile.budget }),
    ...(profile.labels === undefined ? {} : { labels: profile.labels }),
  }));

  return { profiles, filters, scores, permits, bindPlugin };
}

function unknownPluginError(kind: string, name: string): Error {
  const known = builtinPluginNames().sort().join(", ");
  return new Error(
    `unknown scheduler ${kind} plugin '${name}'. Known plugins: ${known}.`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/scheduler/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/config.ts src/core/scheduler/config.test.ts
git commit -m "feat(scheduler): SchedulerConfig zod schema + loader (#300)"
```

---

## Task 17: `index.ts` re-exports + `src/core/index.ts` wiring

**Files:**
- Create: `src/core/scheduler/index.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Create the module index**

Create `src/core/scheduler/index.ts`:

```ts
export type {
  BindPlugin,
  BindResult,
  FilterPlugin,
  FilterRejection,
  FilterVerdict,
  PermitPlugin,
  PermitVerdict,
  ProfileRejection,
  SchedulerContext,
  SchedulingResult,
  ScorePlugin,
} from "./framework.js";
export { Scheduler } from "./scheduler.js";
export type { ScorePluginEntry, SchedulerOptions } from "./scheduler.js";
export type { RuntimeProfile, RuntimeProfileBudget } from "./profile.js";
export { synthesizeFallbackProfile } from "./profile.js";
export {
  loadSchedulerConfig,
  SchedulerConfigSchema,
  type LoadedSchedulerConfig,
  type LoadSchedulerConfigDeps,
  type SchedulerConfig,
} from "./config.js";
export {
  AutoPermit,
  BudgetRemainingFilter,
  builtinPluginNames,
  BUILTIN_BIND_FACTORIES,
  BUILTIN_FILTER_FACTORIES,
  BUILTIN_PERMIT_FACTORIES,
  BUILTIN_SCORE_FACTORIES,
  DefaultBindPlugin,
  InMemoryPermitDecisionStore,
  RuntimeCapabilityFilter,
  TaskAffinityScore,
  UserConfirmPermit,
  WorktreeExclusivityFilter,
  type BudgetLedger,
  type PermitDecisionStore,
} from "./plugins/index.js";
```

- [ ] **Step 2: Add re-export to `src/core/index.ts`**

Find the existing re-export block in `src/core/index.ts` and add this line near other module re-exports (alphabetical order):

```ts
export * as scheduler from "./scheduler/index.js";
```

If you cannot tell where to slot it, append the line at the end of the existing `export *` lines.

- [ ] **Step 3: Run a smoke import test**

Create `src/core/scheduler/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  Scheduler,
  SchedulerConfigSchema,
  loadSchedulerConfig,
  synthesizeFallbackProfile,
} from "./index.js";

describe("scheduler module re-exports", () => {
  test("Scheduler class is exported", () => {
    expect(typeof Scheduler).toBe("function");
  });
  test("SchedulerConfigSchema is exported", () => {
    expect(typeof SchedulerConfigSchema.parse).toBe("function");
  });
  test("loadSchedulerConfig is exported", () => {
    expect(typeof loadSchedulerConfig).toBe("function");
  });
  test("synthesizeFallbackProfile is exported", () => {
    expect(typeof synthesizeFallbackProfile).toBe("function");
  });
});
```

Run: `bun test src/core/scheduler/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Verify the whole scheduler module compiles**

Run: `bun test src/core/scheduler/`
Expected: every test in `src/core/scheduler/**` passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/scheduler/index.ts src/core/scheduler/index.test.ts src/core/index.ts
git commit -m "feat(scheduler): module re-exports + core index wiring (#300)"
```

---

## Task 18: Wire `Scheduler` into `TaskController.reconcilePendingBind`

**Files:**
- Modify: `src/core/task-controller.ts`
- Modify: `src/core/task-controller.test.ts`

- [ ] **Step 1: Add failing controller integration tests**

Append to `src/core/task-controller.test.ts` (after the existing `describe(...)` blocks):

```ts
import { Scheduler } from "./scheduler/scheduler.js";
import type { BindPlugin, FilterPlugin, PermitPlugin } from "./scheduler/framework.js";
import type { RuntimeProfile } from "./scheduler/profile.js";

function profile(name = "primary"): RuntimeProfile {
  return { name, platform: "claude-code", runtimeCommand: "claude" };
}

function alwaysAdmit(name = "admit"): FilterPlugin {
  return { name, filter: async () => ({ admit: true }) };
}

function alwaysReject(reason: string): FilterPlugin {
  return { name: "reject", filter: async () => ({ admit: false, reason }) };
}

function autoPermit(): PermitPlugin {
  return { name: "auto", permit: async () => ({ status: "granted" }) };
}

function denyPermit(reason: string): PermitPlugin {
  return { name: "deny", permit: async () => ({ status: "denied", reason }) };
}

function waitPermit(reason: string): PermitPlugin {
  return { name: "wait", permit: async () => ({ status: "wait", reason }) };
}

function recordingBind(): BindPlugin & { calls: number } {
  const plugin = {
    name: "rec",
    calls: 0,
    async bind() {
      plugin.calls += 1;
      return { session: { id: "boundsess", role: "worker", status: "running" } as AgentSession };
    },
  };
  return plugin;
}

describe("TaskController + Scheduler integration", () => {
  test("bound decision transitions PendingBind → Running with sessionId", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const bindPlugin = recordingBind();
    const scheduler = new Scheduler({
      profiles: [profile()],
      filters: [alwaysAdmit()],
      scores: [],
      permits: [autoPermit()],
      bindPlugin,
      store: { listAgentTaskEntities: store.listAgentTaskEntities },
      now: () => FIXED_NOW_MS,
    });
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      scheduler,
      now: () => FIXED_NOW_MS,
    });

    await controller.reconcileTask("task-1");

    expect(bindPlugin.calls).toBe(1);
    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Running);
    expect(patch.sessionId).toBe("boundsess");
    expect(condition(patch.conditions, "Bound")?.status).toBe("True");
    expect(condition(patch.conditions, "Running")?.status).toBe("True");
  });

  test("unschedulable result keeps PendingBind and sets Unschedulable condition", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const scheduler = new Scheduler({
      profiles: [profile()],
      filters: [alwaysReject("filter-x")],
      scores: [],
      permits: [autoPermit()],
      bindPlugin: recordingBind(),
      store: { listAgentTaskEntities: store.listAgentTaskEntities },
      now: () => FIXED_NOW_MS,
    });
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      scheduler,
      now: () => FIXED_NOW_MS,
    });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBeUndefined();
    expect(condition(patch.conditions, "Unschedulable")?.status).toBe("True");
    expect(condition(patch.conditions, "Unschedulable")?.message).toContain("filter-x");
  });

  test("wait result keeps PendingBind and sets PermitRequired condition", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const scheduler = new Scheduler({
      profiles: [profile()],
      filters: [alwaysAdmit()],
      scores: [],
      permits: [waitPermit("awaiting-user")],
      bindPlugin: recordingBind(),
      store: { listAgentTaskEntities: store.listAgentTaskEntities },
      now: () => FIXED_NOW_MS,
    });
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      scheduler,
      now: () => FIXED_NOW_MS,
    });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBeUndefined();
    expect(condition(patch.conditions, "PermitRequired")?.reason).toBe("awaiting-user");
  });

  test("denied result transitions to Failed", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const scheduler = new Scheduler({
      profiles: [profile()],
      filters: [alwaysAdmit()],
      scores: [],
      permits: [denyPermit("not-allowed")],
      bindPlugin: recordingBind(),
      store: { listAgentTaskEntities: store.listAgentTaskEntities },
      now: () => FIXED_NOW_MS,
    });
    const controller = new TaskController({
      taskStore: store,
      runtime: new FakeRuntime(),
      scheduler,
      now: () => FIXED_NOW_MS,
    });

    await controller.reconcileTask("task-1");

    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Failed);
    expect(condition(patch.conditions, "Failed")?.reason).toBe("not-allowed");
  });

  test("controller without scheduler still uses direct binder path (back-compat)", async () => {
    const store = new FakeTaskStore();
    store.seed(taskView({ phase: AgentTaskPhase.PendingBind, observedGeneration: 1 }));
    const binder = new FakeBinder();
    const controller = controllerFor(store, { binder });

    await controller.reconcileTask("task-1");

    expect(binder.calls).toHaveLength(1);
    const patch = onlyPatch(store).patch;
    expect(patch.phase).toBe(AgentTaskPhase.Running);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/task-controller.test.ts`
Expected: FAIL — `scheduler` not yet an option on `TaskController`.

- [ ] **Step 3: Add `scheduler?` to `TaskControllerOptions` and rewrite `reconcilePendingBind`**

In `src/core/task-controller.ts`:

(a) Add an import at the top of the file (after the existing imports):

```ts
import type { Scheduler } from "./scheduler/scheduler.js";
import type { SchedulingResult } from "./scheduler/framework.js";
```

(b) Add the option field. Inside `TaskControllerOptions`, append:

```ts
  readonly scheduler?: Scheduler | undefined;
```

(c) Add the private field + constructor assignment. In the class, alongside the other private fields, add:

```ts
  private readonly scheduler: Scheduler | undefined;
```

In the constructor, add (anywhere among the existing assignments):

```ts
    this.scheduler = options.scheduler;
```

(d) Replace `reconcilePendingBind` (currently lines 271-310) with the dispatching version:

```ts
  private async reconcilePendingBind(
    task: AgentTaskView,
  ): Promise<ReconciliationResult | undefined> {
    if (task.status.sessionId !== undefined) {
      return this.reconcileRunning(task);
    }

    if (this.scheduler === undefined) {
      return this.directBindPendingBind(task);
    }

    const decision = await this.scheduler.schedule(task);
    return this.applySchedulingDecision(task, decision);
  }

  private async directBindPendingBind(
    task: AgentTaskView,
  ): Promise<ReconciliationResult | undefined> {
    const { session } = await this.binder.bind({ task });
    const nowIso = this.nowIso();
    const conditions = upsertCondition(
      upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.Bound,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "session-bound",
        message: "",
      }),
      {
        type: AgentTaskConditionType.Running,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "session-running",
        message: "",
      },
    );

    return {
      patch: {
        phase: AgentTaskPhase.Running,
        sessionId: session.id,
        observedGeneration: task.spec.generation,
        conditions,
        lastTransitionAt: nowIso,
      },
      transition: transition(task, AgentTaskPhase.Running, "session-bound"),
      sessionToCloseOnPatchFailure: session,
    };
  }

  private applySchedulingDecision(
    task: AgentTaskView,
    decision: SchedulingResult,
  ): ReconciliationResult | undefined {
    const nowIso = this.nowIso();

    if (decision.kind === "bound") {
      const conditions = upsertCondition(
        upsertCondition(task.status.conditions, {
          type: AgentTaskConditionType.Bound,
          status: "True",
          observedGeneration: task.spec.generation,
          lastTransitionTime: nowIso,
          reason: "session-bound",
          message: "",
        }),
        {
          type: AgentTaskConditionType.Running,
          status: "True",
          observedGeneration: task.spec.generation,
          lastTransitionTime: nowIso,
          reason: "session-running",
          message: "",
        },
      );
      return {
        patch: {
          phase: AgentTaskPhase.Running,
          sessionId: decision.session.id,
          observedGeneration: task.spec.generation,
          conditions,
          lastTransitionAt: nowIso,
        },
        transition: transition(task, AgentTaskPhase.Running, "session-bound"),
        sessionToCloseOnPatchFailure: decision.session,
      };
    }

    if (decision.kind === "unschedulable") {
      const reasons = decision.rejections
        .flatMap((entry) =>
          entry.rejections.map((r) => `${entry.profile.name}/${r.plugin}:${r.reason}`),
        )
        .slice(0, 3);
      const message = reasons.length === 0 ? "no candidate profiles" : reasons.join("; ");
      const conditions = upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.Unschedulable,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: "no-candidate",
        message,
      });
      return {
        patch: {
          observedGeneration: task.spec.generation,
          conditions,
        },
        transition: transition(task, AgentTaskPhase.PendingBind, "unschedulable"),
      };
    }

    if (decision.kind === "wait") {
      const conditions = upsertCondition(task.status.conditions, {
        type: AgentTaskConditionType.PermitRequired,
        status: "True",
        observedGeneration: task.spec.generation,
        lastTransitionTime: nowIso,
        reason: decision.reason,
        message: decision.message ?? `permit '${decision.plugin}' is waiting`,
      });
      return {
        patch: {
          observedGeneration: task.spec.generation,
          conditions,
        },
        transition: transition(task, AgentTaskPhase.PendingBind, "permit-wait"),
      };
    }

    // decision.kind === "denied"
    const conditions = upsertCondition(task.status.conditions, {
      type: AgentTaskConditionType.Failed,
      status: "True",
      observedGeneration: task.spec.generation,
      lastTransitionTime: nowIso,
      reason: decision.reason,
      message: decision.message ?? `permit '${decision.plugin}' denied`,
    });
    return {
      patch: {
        phase: AgentTaskPhase.Failed,
        observedGeneration: task.spec.generation,
        conditions,
        lastTransitionAt: nowIso,
      },
      transition: transition(task, AgentTaskPhase.Failed, decision.reason),
    };
  }
```

- [ ] **Step 4: Run controller tests to verify they pass**

Run: `bun test src/core/task-controller.test.ts`
Expected: PASS — all existing tests + 5 new scheduler-integration tests.

- [ ] **Step 5: Run the full core test directory to catch regressions**

Run: `bun test src/core/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/task-controller.ts src/core/task-controller.test.ts
git commit -m "feat(scheduler): wire Scheduler into TaskController.reconcilePendingBind (#300)"
```

---

## Task 19: Acceptance test — config-only reweight changes winner

**Files:**
- Create: `src/core/scheduler/acceptance-config-reweight.test.ts`

This proves the acceptance criterion: *"new filter/score plugin added via config (no code change)"*. Two configs differ only in the `pipeline.scores` list (built-in plugins, no new TS); the same task produces a different winning profile.

- [ ] **Step 1: Write the failing test**

Create `src/core/scheduler/acceptance-config-reweight.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentRuntime, AgentSession } from "../agent-runtime.js";
import type { AgentTaskView } from "../agent-task.js";
import { AgentTaskPhase } from "../agent-task.js";
import type { AgentSessionEntity } from "../entity.js";
import { loadSchedulerConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";

class RecordingRuntime implements AgentRuntime {
  spawnCalls: Array<{ role: string; command: string; model: string | undefined }> = [];
  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, command: config.command, model: config.model });
    return { id: "s", role, status: "running" };
  }
  async send(): Promise<never> {
    throw new Error("unused");
  }
  async close(): Promise<void> {}
  onIdle(): void {}
  async listSessions(): Promise<readonly AgentSession[]> {
    return [];
  }
  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const task: AgentTaskView = {
  spec: {
    id: "t",
    worktree: "/tmp/w",
    runtime: "",
    role: "worker",
    prompt: "p",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
    budget: { affinity: { tier: "premium" } },
  },
  status: {
    id: "t",
    phase: AgentTaskPhase.PendingBind,
    contributions: [],
    conditions: [],
    observedGeneration: 0,
    lastTransitionAt: "2026-05-16T00:00:00.000Z",
    revision: 1,
  },
};

const profiles = [
  { name: "free-tier", platform: "claude-code", runtimeCommand: "claude", labels: { tier: "free" } },
  {
    name: "premium-tier",
    platform: "claude-code",
    runtimeCommand: "claude",
    labels: { tier: "premium" },
  },
];

describe("acceptance: config-only reweight changes winner", () => {
  test("with TaskAffinity enabled, premium-tier wins on premium affinity", async () => {
    const runtime = new RecordingRuntime();
    const loaded = loadSchedulerConfig(
      {
        profiles,
        pipeline: {
          filters: [],
          scores: [{ name: "TaskAffinity", weight: 1 }],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime },
    );
    const scheduler = new Scheduler({
      profiles: loaded.profiles,
      filters: loaded.filters,
      scores: loaded.scores,
      permits: loaded.permits,
      bindPlugin: loaded.bindPlugin,
      store: { listAgentTaskEntities: async () => [] },
      now: () => 0,
    });

    const result = await scheduler.schedule(task);

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("premium-tier");
  });

  test("with TaskAffinity removed, declaration order wins (free-tier first)", async () => {
    const runtime = new RecordingRuntime();
    const loaded = loadSchedulerConfig(
      {
        profiles,
        pipeline: {
          filters: [],
          scores: [],
          permits: ["AutoPermit"],
          bind: "DefaultBind",
        },
      },
      { runtime },
    );
    const scheduler = new Scheduler({
      profiles: loaded.profiles,
      filters: loaded.filters,
      scores: loaded.scores,
      permits: loaded.permits,
      bindPlugin: loaded.bindPlugin,
      store: { listAgentTaskEntities: async () => [] },
      now: () => 0,
    });

    const result = await scheduler.schedule(task);

    expect(result.kind).toBe("bound");
    if (result.kind === "bound") expect(result.profile.name).toBe("free-tier");
  });
});
```

- [ ] **Step 2: Run test to verify both pass**

Run: `bun test src/core/scheduler/acceptance-config-reweight.test.ts`
Expected: PASS (2 tests).

If the second test fails because Scheduler shortcuts the one-admitted path before reaching `pickWinner` — that's intentional (only one profile case), but here there are two. Confirm both profiles are passed.

- [ ] **Step 3: Run the whole scheduler test directory + task-controller**

Run: `bun test src/core/scheduler/ src/core/task-controller.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/scheduler/acceptance-config-reweight.test.ts
git commit -m "test(scheduler): acceptance — config-only reweight changes winner (#300)"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `bun test`
Expected: PASS (entire suite green).

- [ ] **Run any biome/lint hooks that the repo uses**

Run: `bun run check 2>/dev/null || bunx biome check src/core/scheduler src/core/task-controller.ts src/core/agent-task.ts`
Expected: no lint errors. Fix anything reported (typically import order or unused imports). If you make changes, commit with `chore(scheduler): lint fixes (#300)`.

- [ ] **Verify acceptance criteria from spec**

Confirm each of the issue's acceptance items maps to a test that just passed:
- Plugin interface documented — spec + framework.ts JSDoc.
- New filter/score plugin added via config — `acceptance-config-reweight.test.ts`.
- Default plugins cover runtime-capability + budget + affinity — `runtime-capability.test.ts`, `budget-remaining.test.ts`, `task-affinity.test.ts`.

---

## Out of scope (deferred to follow-up issues)

- `HistoricalSuccessRate` and `LoadBalancing` score plugins.
- Persistent `PermitDecisionStore` + TUI wiring for `UserConfirmPermit`.
- Global `BudgetLedger` implementation backed by credits / bounty data.
- Two-phase reservation, CAS on status, transition graph (#305).
- Removing the `TaskBinder` interface once #305 forces the plugin path.
- Per-plugin `errorPolicy: "tolerate"`. The spec describes this; #300 ships strict-default only (plugin throws bubble up to the controller's existing retry loop). Tolerate mode lands with a follow-up issue if the need arises.
