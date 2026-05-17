# Scheduler Framework Design (D3, #300)

## Summary

Issue #300 introduces a Kubernetes-scheduler-style plugin pipeline that selects a runtime profile for each `AgentTask` before bind. The pipeline runs four stages — Filter, Score, Permit, Bind — over a configurable set of candidate `RuntimeProfile` records. The scheduler lives in a new `src/core/scheduler/` module and is injected into `TaskController`. When set, `reconcilePendingBind` delegates profile selection to the scheduler instead of calling the binder directly. When unset, the controller preserves today's single-runtime direct-bind path.

This PR ships the framework, the default plugin set required by the acceptance criteria (`RuntimeCapability`, `BudgetRemaining`, `WorktreeExclusivity` filters; `TaskAffinity` score; `AutoPermit` permit; `DefaultBind` bind), and the config seam that lets new plugins be enabled by editing config rather than code. A reservation-token field on the scheduler's result type is reserved for #305 but always `undefined` here.

## Goals

- Add `Scheduler` class that runs the Filter→Score→Permit→Bind pipeline over a list of candidate `RuntimeProfile` records and returns a typed `SchedulingResult`.
- Define plugin interfaces (`FilterPlugin`, `ScorePlugin`, `PermitPlugin`, `BindPlugin`) that are easy to implement, test in isolation, and register through config.
- Wire `TaskController.reconcilePendingBind` to the scheduler when an instance is injected, mapping each result variant to a status patch.
- Ship the four acceptance plugins plus `AutoPermit` and `DefaultBind` so out-of-the-box behavior matches today's controller for single-runtime configs.
- Surface scheduling outcomes as `AgentTask` conditions (`Unschedulable`, `PermitRequired`) so the TUI can render them without new IPC.
- Load profiles and pipeline configuration from the existing config system; validate with zod.
- Reserve a `reservationToken?` field on `SchedulingResult.bound` so #305 can wrap the call without changing the scheduler signature.

## Non-Goals

- Two-phase reservation, CAS on status, transition-graph enforcement: all #305.
- `HistoricalSuccessRate` and `LoadBalancing` score plugins. Interfaces support them; implementations land in a follow-up issue.
- TUI wiring for `UserConfirmPermit`. The plugin's shape ships behind an in-memory decision store; the persistent store and TUI prompts are a follow-up.
- Global cost/turn ledger for `BudgetRemaining`. The filter takes a `BudgetLedger` interface with a permissive no-op default; real ledger lands later (likely alongside Nexus credits work).
- Multi-runtime registry. Profiles are config records; all profiles back through the single injected `AgentRuntime` for now. A runtime registry can be added without changing the scheduler API.
- TUI permit prompt end-to-end test.

## Current State

`TaskController.reconcilePendingBind` (`src/core/task-controller.ts`) calls `DefaultTaskBinder.bind(task)` directly, which builds an `AgentConfig` from `task.spec` and calls `runtime.spawn`. There is no concept of candidate selection — the task's `spec.runtime` string is passed straight through. `TaskBinder` is a single-method interface (`bind(request) -> {session}`).

`AgentTask` carries `spec.runtime`, `spec.role`, `spec.budget?`, `spec.dependsOn`, and `status.phase` (`Pending` | `PendingBind` | `Running` | `AwaitingReview` | `Succeeded` | `Failed`). Conditions are appended via `upsertCondition`; the current set is `Admitted | Scheduled | Bound | Running | AwaitingReview | Succeeded | Failed | Blocked`.

`AgentRuntime` is a single interface (`spawn`, `send`, `close`, `onIdle`, `listSessions`, `listSessionEntities`, `isAvailable`). There is no runtime pool. `task.spec.runtime` is the string mapped to `AgentConfig.command`.

Config (`src/core/config.ts`) uses zod schemas and a file-loaded record. There is no `scheduler` section today.

## Architecture

### Module layout — `src/core/scheduler/`

- `framework.ts` — plugin interfaces (`FilterPlugin`, `ScorePlugin`, `PermitPlugin`, `BindPlugin`), `SchedulerContext`, `SchedulingResult`, verdict types.
- `scheduler.ts` — `Scheduler` class. Owns the pipeline and the plugin instances. Pure: reads task + profiles + store, returns a result. Does not write.
- `profile.ts` — `RuntimeProfile` type and a `synthesizeFallbackProfile(task)` helper invoked per scheduling call when no profiles are configured.
- `config.ts` — `SchedulerConfig` zod schema, `loadSchedulerConfig(config)` adapter, plugin-name → impl resolution with an explicit registry of built-in plugins.
- `plugins/runtime-capability.ts`
- `plugins/budget-remaining.ts`
- `plugins/worktree-exclusivity.ts`
- `plugins/task-affinity.ts`
- `plugins/auto-permit.ts`
- `plugins/user-confirm-permit.ts`
- `plugins/default-bind.ts`
- `plugins/index.ts` — built-in plugin registry consumed by `config.ts`.
- `index.ts` — public re-exports.

### Integration seam

`TaskControllerOptions` gains:

```ts
readonly scheduler?: Scheduler | undefined;
```

`reconcilePendingBind` becomes:

```ts
if (task.status.sessionId !== undefined) return this.reconcileRunning(task);
if (this.scheduler === undefined) return this.directBind(task);  // today's path
const decision = await this.scheduler.schedule(task);
return this.applyDecision(task, decision);
```

`directBind` is today's bind logic (kept for back-compat and for tests that do not wire a scheduler). `applyDecision` maps every `SchedulingResult` variant to a `ReconciliationResult`.

## Plugin Interfaces (`framework.ts`)

```ts
export interface SchedulerContext {
  readonly task: AgentTaskView;
  readonly profiles: readonly RuntimeProfile[];
  readonly store: Pick<AgentTaskStore, "listAgentTaskEntities">;
  readonly now: () => number;
}

export interface FilterPlugin {
  readonly name: string;
  filter(ctx: SchedulerContext, profile: RuntimeProfile): Promise<FilterVerdict>;
}
export type FilterVerdict =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string; readonly message?: string };

export interface ScorePlugin {
  readonly name: string;
  score(ctx: SchedulerContext, profile: RuntimeProfile): Promise<number>;  // 0–100
}

export interface PermitPlugin {
  readonly name: string;
  permit(ctx: SchedulerContext, profile: RuntimeProfile): Promise<PermitVerdict>;
}
export type PermitVerdict =
  | { readonly status: "granted" }
  | { readonly status: "denied"; readonly reason: string; readonly message?: string }
  | { readonly status: "wait";   readonly reason: string; readonly message?: string };

export interface BindPlugin {
  readonly name: string;
  bind(ctx: SchedulerContext, profile: RuntimeProfile): Promise<TaskBindResult>;
}
```

`FilterVerdict.reason` and `PermitVerdict.reason` use stable kebab-case identifiers (`runtime-mismatch`, `budget-exceeds-profile`, `worktree-busy`, `awaiting-user-confirmation`, …). Reasons surface in conditions and tests assert on them.

## Pipeline Execution (`scheduler.ts`)

```ts
class Scheduler {
  async schedule(task: AgentTaskView): Promise<SchedulingResult> {
    const ctx = this.buildContext(task);

    // 1. Filter
    const filtered = await Promise.all(ctx.profiles.map(async (profile) => {
      const rejections: FilterRejection[] = [];
      for (const plugin of this.filters) {
        const v = await this.runFilter(plugin, ctx, profile);
        if (!v.admit) rejections.push({ plugin: plugin.name, reason: v.reason, message: v.message });
      }
      return { profile, rejections };
    }));
    const admitted = filtered.filter((c) => c.rejections.length === 0).map((c) => c.profile);
    if (admitted.length === 0) return { kind: "unschedulable", rejections: filtered };

    // 2. Score (highest wins, stable order breaks ties)
    const scored = await Promise.all(admitted.map(async (profile) => ({
      profile,
      score: await this.scoreProfile(ctx, profile),
    })));
    scored.sort((a, b) => b.score - a.score || configOrderIndex(a.profile) - configOrderIndex(b.profile));
    const winner = scored[0]!.profile;

    // 3. Permit (first non-granted wins)
    for (const plugin of this.permits) {
      const v = await plugin.permit(ctx, winner);
      if (v.status === "denied") return { kind: "denied", plugin: plugin.name, reason: v.reason, message: v.message };
      if (v.status === "wait")   return { kind: "wait",   plugin: plugin.name, reason: v.reason, message: v.message, profile: winner };
    }

    // 4. Bind
    const { session } = await this.bindPlugin.bind(ctx, winner);
    return { kind: "bound", profile: winner, session, reservationToken: undefined };
  }
}
```

### Result variants

```ts
export type SchedulingResult =
  | { kind: "bound";          profile: RuntimeProfile; session: AgentSession; reservationToken?: string | undefined }
  | { kind: "unschedulable";  rejections: ReadonlyArray<{ profile: RuntimeProfile; rejections: readonly FilterRejection[] }> }
  | { kind: "wait";           plugin: string; reason: string; message?: string; profile: RuntimeProfile }
  | { kind: "denied";         plugin: string; reason: string; message?: string };
```

### Plugin error policy

`runFilter` (and the score/permit equivalents) wrap plugin calls. If a plugin throws and its config entry sets `errorPolicy: "tolerate"`, the verdict is treated as `{ admit: false, reason: "plugin-error", message: <err> }`. Default policy (`"strict"`) re-throws; the controller's existing retry loop covers it. Mirrors k8s scheduler behavior.

### Single-pass guarantee

One `schedule()` call performs at most one bind attempt. The scheduler does not loop on its own. Reservation/retry are external concerns owned by the controller (today) and the reservation layer (in #305).

## Runtime Profile + Config (`profile.ts`, `config.ts`)

```ts
export interface RuntimeProfile {
  readonly name: string;
  readonly platform: AgentPlatformType;             // "claude-code" | "codex" | "gemini"
  readonly runtimeCommand: string;                  // AgentConfig.command
  readonly model?: string | undefined;
  readonly supportedRoles?: readonly string[] | undefined;  // undefined = any
  readonly budget?: {
    readonly maxCostUsd?: number;
    readonly maxTurns?: number;
    readonly allowedModels?: readonly string[];
  };
  readonly labels?: Readonly<Record<string, string>>;
}
```

Config shape:

```yaml
scheduler:
  profiles:
    - name: claude-opus-default
      platform: claude-code
      runtimeCommand: claude
      model: claude-opus-4-7
      supportedRoles: [implementer, reviewer]
      budget: { maxCostUsd: 10, maxTurns: 50 }
      labels: { tier: premium }
    - name: codex-default
      platform: codex
      runtimeCommand: codex
      supportedRoles: [implementer]

  pipeline:
    filters: [RuntimeCapability, BudgetRemaining, WorktreeExclusivity]
    scores:
      - { name: TaskAffinity, weight: 100 }
    permits: [AutoPermit]
    bind:    DefaultBind
```

Plugin-name resolution: `config.ts` keeps a `BUILTIN_PLUGINS` record mapping the name strings used in config to factory functions. Unknown names yield a loader error listing the known names — never silent fallthrough.

### Empty / missing config

When `scheduler.profiles` is empty or absent, `loadSchedulerConfig` returns the default pipeline and an empty profile list. The `Scheduler` then calls `synthesizeFallbackProfile(task)` per scheduling call to derive a single profile from `task.spec.runtime`. This preserves single-runtime behavior for tests and existing deployments that do not yet set a `scheduler:` block.

### `task.spec.runtime` semantics

Stays a string. When set, `RuntimeCapability` rejects profiles where `profile.runtimeCommand !== task.spec.runtime`, preserving pin-to-runtime semantics. When empty, the scheduler picks among all eligible profiles.

## Controller Integration (`task-controller.ts`)

`applyDecision(task, decision)` mapping table:

| `decision.kind` | Resulting patch | Phase transition | Notes |
|---|---|---|---|
| `bound` | `phase=Running`, `sessionId`, `Bound`+`Running` conditions, `lastTransitionAt` | `PendingBind → Running` | Identical to today's success patch. `sessionToCloseOnPatchFailure` set so a failed status write still closes the runtime session. |
| `unschedulable` | `Scheduled=False`, `Unschedulable=True` condition (reasons joined, capped at first 3 entries; `observedGeneration` advanced) | none (stays `PendingBind`) | Resync retries; cheap because filters are fast. |
| `wait` | `PermitRequired=True` condition (plugin + reason + message) | none (stays `PendingBind`) | Resync re-enters scheduler; `AutoPermit` always grants so this path only fires for `UserConfirmPermit` etc. |
| `denied` | `Failed=True` condition with denied reason; `phase=Failed` | `PendingBind → Failed` | Terminal. |

### New condition types

Add to `AgentTaskConditionType`:

- `Unschedulable`
- `PermitRequired`

Existing `Scheduled`, `Bound`, `Running`, `Failed` are reused.

### Back-compat path

If `scheduler` is not provided, `reconcilePendingBind` keeps today's `directBind` branch, which calls `this.binder.bind(task)`. Every existing test continues to pass without modification.

### Reservation seam for #305

`SchedulingResult.bound.reservationToken` is always `undefined` in this PR. #305 will:

1. Before calling `scheduler.schedule`, mint a token and write `status.reservation = { token, expiresAt }`.
2. Pass the token into a wrapper around `schedule` that validates it on bind and clears it on commit.
3. Add a `reconcilePendingBindReservation` step that scans for expired reservations and rolls back.

None of this requires changing the `Scheduler` API. `TaskBinder` interface is removed once #305 lands and the plugin path becomes the only path.

## Default Plugins

### Filters

**`RuntimeCapability`** (`plugins/runtime-capability.ts`)

- Reject when `task.spec.runtime` is set and `profile.runtimeCommand !== task.spec.runtime`. Reason: `runtime-mismatch`.
- Reject when `profile.supportedRoles` is defined and does not include `task.spec.role`. Reason: `role-unsupported`.
- Reject when `task.spec.budget?.model` is set, `profile.budget?.allowedModels` is defined, and the requested model is not in the allowlist. Reason: `model-not-allowed`.

**`BudgetRemaining`** (`plugins/budget-remaining.ts`)

- Reject when `task.spec.budget?.maxCostUsd` exceeds `profile.budget?.maxCostUsd`. Reason: `budget-exceeds-profile`.
- Reject when `task.spec.maxTurns` exceeds `profile.budget?.maxTurns`. Reason: `turns-exceeds-profile`.
- Constructor takes an optional `BudgetLedger` interface (`hasRemaining(profile, task): Promise<boolean>`); default impl always returns `true`.

**`WorktreeExclusivity`** (`plugins/worktree-exclusivity.ts`)

- Reads `store.listAgentTaskEntities()` once per call (memoized in `SchedulerContext`).
- Reject every profile when another `AgentTask` with `status.phase === "Running"` shares `task.spec.worktree`. Reason: `worktree-busy`, message: `running task: <id>`.
- The pipeline still applies this per-profile (uniform reject); a small optimization caches the verdict for the rest of the loop.

### Score

**`TaskAffinity`** (`plugins/task-affinity.ts`)

- Requested labels come from `task.spec.budget?.affinity` (new optional `Record<string, string>` field on the task budget object) or default to `{ runtime: task.spec.runtime }` when `runtime` is set.
- Score = `round(100 * matched / requested)`. No labels requested → neutral `50`.
- Exact-match on values; no fuzzy matching.

### Permit

**`AutoPermit`** (`plugins/auto-permit.ts`) — always returns `{ status: "granted" }`. Default.

**`UserConfirmPermit`** (`plugins/user-confirm-permit.ts`) — shape only:

- Constructor takes a `PermitDecisionStore` interface with `lookup(taskId, profileName, generation): Promise<{ approved: boolean; reason?: string } | undefined>`.
- No decision → `{ status: "wait", reason: "awaiting-user-confirmation" }`.
- Approved → `granted`. Denied → `denied` with stored reason.
- Default `PermitDecisionStore` is an in-memory map for unit tests. Persistent store + TUI wiring are a follow-up.

### Bind

**`DefaultBind`** (`plugins/default-bind.ts`)

- Builds `AgentConfig` from `profile` (taking precedence) merged with `task.spec` (for prompt, cwd, env, role).
- Specifically: `command` ← `profile.runtimeCommand`; `platform` ← `profile.platform`; `model` ← `profile.model ?? task.spec.budget?.model`.
- Calls `runtime.spawn(task.spec.role, config)` and returns `{ session }`.

## Deferred Items

Listed here so reviewers can confirm the interfaces leave room for them. Each becomes its own follow-up issue:

- `HistoricalSuccessRate` score plugin (derives from store's terminal `AgentTask` entities; in-memory aggregator updated on `onTransition`).
- `LoadBalancing` score plugin.
- `UserConfirmPermit` TUI wiring and persistent `PermitDecisionStore`.
- Global `BudgetLedger` implementation backed by credits/bounty data.

## Testing

### Plugin unit tests — `src/core/scheduler/plugins/*.test.ts`

- `runtime-capability.test.ts` — matrix of `task.spec.runtime` × `profile.runtimeCommand` × `supportedRoles`, with both pinned and unpinned task variants.
- `budget-remaining.test.ts` — cost and turn limits, model allowlist, permissive default ledger, custom ledger that returns `false`.
- `worktree-exclusivity.test.ts` — fixture store with Running on other worktree (admit), Running on same worktree (reject), Succeeded on same worktree (admit), Pending on same worktree (admit).
- `task-affinity.test.ts` — full match, partial match, zero match, no-requested-labels neutral case.
- `auto-permit.test.ts` — always granted.
- `user-confirm-permit.test.ts` — wait → granted → bound, wait → denied → failed, in-memory decision store fixture.
- `default-bind.test.ts` — profile precedence over spec, model fallback chain, env vars preserved.

### Pipeline tests — `src/core/scheduler/scheduler.test.ts`

- All filters pass → highest-scoring profile bound.
- Some filters reject → admitted set excludes them; `unschedulable` only when all profiles rejected.
- Scoring tie → earlier profile in config declaration order wins.
- Permit `wait` short-circuits before Bind.
- Permit `denied` short-circuits before Bind.
- Plugin throws under `errorPolicy: "strict"` → schedule throws.
- Plugin throws under `errorPolicy: "tolerate"` → treated as reject with `reason: plugin-error`.
- Empty profiles config → fallback profile synthesized from `task.spec.runtime`, scheduler still binds.

### Controller integration tests — extend `src/core/task-controller.test.ts`

- No scheduler injected → today's direct-bind path unchanged (back-compat).
- Scheduler injected + `bound` result → patch shape identical to today's success patch.
- `unschedulable` → stays `PendingBind`, `Unschedulable` condition set; next resync re-enters scheduler.
- `wait` → stays `PendingBind`, `PermitRequired` condition set; resync re-enters.
- `denied` → transitions to `Failed`, `Failed` condition with denied reason.
- Scheduler throws → `onError` fires, queue retries with backoff.
- Status patch fails after a `bound` decision → runtime session is closed (existing `sessionToCloseOnPatchFailure` path verified).

### Config tests — `src/core/scheduler/config.test.ts`

- Zod validation: missing platform, invalid plugin name, negative weight, missing required pipeline section.
- Plugin-name resolution: unknown name → loader error listing available plugins.
- Two configs differing only in `pipeline.scores` weights produce different winners for the same task (acceptance: "new filter/score plugin added via config, no code change").

## Acceptance Mapping

| Issue acceptance | Where verified |
|---|---|
| Plugin interface documented | This spec + JSDoc on `framework.ts`. |
| New filter/score plugin added via config (no code change) | `config.test.ts` reweight test using existing plugin code. |
| Default plugins cover runtime-capability + budget + affinity | `runtime-capability.test.ts`, `budget-remaining.test.ts`, `task-affinity.test.ts`. |

## Risks and Open Questions

- **Affinity field on spec.** Adding `affinity` to `task.spec.budget` is a soft schema change. Optional, defaulted; no migration needed. Alternative: separate `task.spec.affinity` top-level. Chose `budget.affinity` to avoid touching `AgentTaskSpec` shape beyond what's already optional. Revisit if scoring grows beyond affinity.
- **`WorktreeExclusivity` and parallel pipelines.** Memory note `feedback_e2e_use_nexus` flags Nexus store as source of truth. The filter reads `listAgentTaskEntities` which today resolves to the local/Nexus-backed `AgentTaskStore` — consistent with the controller's existing reads. No new wiring needed.
- **Removing `TaskBinder` later.** Once #305 lands, the only path is plugin-driven. Spec calls this out so reviewers know `TaskBinder` is a temporary interface, not a long-term abstraction.
- **Plugin error wrapping cost.** Each plugin call goes through a try/catch. Negligible perf; explicit so plugin authors get predictable behavior.
