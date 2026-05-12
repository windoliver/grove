# Claim Reconciliation Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build dark core infrastructure for Kubernetes-style claim reconciliation: a keyed work queue plus a status-only claim controller that can be wired into watch events later.

**Architecture:** Add `KeyedWorkQueue` as a dependency-free controller queue with dirty-set dedupe, in-flight protection, per-key exponential backoff, and a global token bucket. Add `ClaimReconciliationController` that only depends on `getClaimView`, `patchClaimStatus`, and `listEntities`, always re-reads the current claim view, and writes only status patches. Export the new core types without starting the controller from server runtime.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, ESM imports with `.js` extensions, Biome formatting.

---

## File Structure

Create:

- `src/core/workqueue.ts` — keyed queue used by controllers.
- `src/core/workqueue.test.ts` — queue TDD coverage.
- `src/core/claim-controller.ts` — claim reconciliation controller and condition helpers.
- `src/core/claim-controller.test.ts` — controller TDD coverage with an in-memory fake store.
- `docs/superpowers/plans/2026-05-09-claim-reconciliation-controller.md` — this plan.

Modify:

- `src/core/index.ts` — public exports for queue and controller types/classes.

Do not modify:

- `src/server/**` — this ships dark and is not started by grove-server.
- `src/core/reconciler.ts` — existing sweep reconciler remains intact.
- `src/local/sqlite-store.ts` — #270 already provides the required split-store methods.

---

### Task 1: Keyed Work Queue

**Files:**
- Create: `src/core/workqueue.test.ts`
- Create: `src/core/workqueue.ts`

- [ ] **Step 1: Write the failing queue tests**

Create `src/core/workqueue.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { KeyedWorkQueue, QueueClosedError, type DefaultTimerHandle } from "./workqueue.js";

interface FakeTimerHandle {
  readonly id: number;
}

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { readonly at: number; readonly fn: () => void }>();

  readonly now = (): number => this.nowMs;

  readonly setTimer = (fn: () => void, delayMs: number): FakeTimerHandle => {
    const handle = { id: this.nextId };
    this.nextId += 1;
    this.timers.set(handle.id, { at: this.nowMs + delayMs, fn });
    return handle;
  };

  readonly clearTimer = (handle: FakeTimerHandle): void => {
    this.timers.delete(handle.id);
  };

  advance(ms: number): void {
    this.nowMs += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.fn();
    }
  }

  get timerCount(): number {
    return this.timers.size;
  }
}

function makeQueue(clock: FakeClock): KeyedWorkQueue<FakeTimerHandle> {
  return new KeyedWorkQueue<FakeTimerHandle>({
    baseDelayMs: 5,
    maxDelayMs: 40,
    globalRatePerSec: 1,
    globalBurst: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

describe("KeyedWorkQueue", () => {
  test("dedupes duplicate pending keys", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    queue.enqueue("claim-1");
    queue.enqueue("claim-1");

    expect(queue.size()).toBe(1);
    expect(queue.pendingKeys()).toEqual(["claim-1"]);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    expect(queue.size()).toBe(0);
  });

  test("re-enqueues once when a key becomes dirty while in flight", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    const first = await queue.take();
    expect(first).toEqual({ key: "claim-1", attempt: 0 });

    queue.enqueue("claim-1");
    queue.enqueue("claim-1");
    expect(queue.size()).toBe(0);

    queue.acknowledge("claim-1");
    expect(queue.pendingKeys()).toEqual(["claim-1"]);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
  });

  test("retries with capped exponential per-key backoff", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    queue.retry("claim-1");

    expect(queue.size()).toBe(0);
    expect(clock.timerCount).toBe(1);
    clock.advance(4);
    expect(queue.size()).toBe(0);
    clock.advance(1);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 1 });

    queue.retry("claim-1");
    clock.advance(10);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 2 });

    queue.retry("claim-1");
    clock.advance(20);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 3 });

    queue.retry("claim-1");
    clock.advance(40);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 4 });
  });

  test("acknowledge clears retry state after success", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    await queue.take();
    queue.retry("claim-1");
    clock.advance(5);
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 1 });

    queue.acknowledge("claim-1");
    queue.enqueue("claim-1");
    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
  });

  test("limits dispatch through the global token bucket", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    queue.enqueue("claim-2");
    queue.enqueue("claim-3");

    await expect(queue.take()).resolves.toEqual({ key: "claim-1", attempt: 0 });
    await expect(queue.take()).resolves.toEqual({ key: "claim-2", attempt: 0 });

    let resolved = false;
    const pending = queue.take().then((item) => {
      resolved = true;
      return item;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(1);
    await expect(pending).resolves.toEqual({ key: "claim-3", attempt: 0 });
  });

  test("close clears retry timers and rejects pending waiters", async () => {
    const clock = new FakeClock();
    const queue = makeQueue(clock);

    queue.enqueue("claim-1");
    await queue.take();
    queue.retry("claim-1");
    expect(clock.timerCount).toBe(1);

    const pending = queue.take();
    queue.close();

    expect(clock.timerCount).toBe(0);
    await expect(pending).rejects.toBeInstanceOf(QueueClosedError);
    expect(() => queue.enqueue("claim-2")).toThrow(QueueClosedError);
  });

  test("uses default timer types without generic parameters", () => {
    const queue = new KeyedWorkQueue<DefaultTimerHandle>();
    queue.close();
    expect(queue.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run queue tests to verify RED**

Run:

```bash
bun test src/core/workqueue.test.ts
```

Expected: FAIL because `src/core/workqueue.ts` does not exist.

- [ ] **Step 3: Implement the keyed work queue**

Create `src/core/workqueue.ts`:

```ts
export type DefaultTimerHandle = ReturnType<typeof setTimeout>;

export interface WorkQueueOptions<TTimer = DefaultTimerHandle> {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly globalRatePerSec?: number;
  readonly globalBurst?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, delayMs: number) => TTimer;
  readonly clearTimer?: (handle: TTimer) => void;
}

export interface WorkItemResult {
  readonly key: string;
  readonly attempt: number;
}

interface Waiter {
  readonly resolve: (item: WorkItemResult) => void;
  readonly reject: (err: Error) => void;
}

export class QueueClosedError extends Error {
  constructor() {
    super("work queue is closed");
    this.name = "QueueClosedError";
  }
}

const DEFAULT_BASE_DELAY_MS = 5;
const DEFAULT_MAX_DELAY_MS = 1_000_000;
const DEFAULT_GLOBAL_RATE_PER_SEC = 50;
const DEFAULT_GLOBAL_BURST = 300;

export class KeyedWorkQueue<TTimer = DefaultTimerHandle> {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly globalRatePerSec: number;
  private readonly globalBurst: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (handle: TTimer) => void;
  private readonly pending: string[] = [];
  private readonly pendingSet = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, TTimer>();
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private tokens: number;
  private lastRefillMs: number;
  private tokenTimer: TTimer | undefined;

  constructor(opts: WorkQueueOptions<TTimer> = {}) {
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.globalRatePerSec = opts.globalRatePerSec ?? DEFAULT_GLOBAL_RATE_PER_SEC;
    this.globalBurst = opts.globalBurst ?? DEFAULT_GLOBAL_BURST;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs) as TTimer);
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as DefaultTimerHandle));
    this.tokens = this.globalBurst;
    this.lastRefillMs = this.now();
  }

  enqueue(key: string): void {
    this.assertOpen();
    if (this.inFlight.has(key) || this.retryTimers.has(key)) {
      this.dirty.add(key);
      return;
    }
    this.enqueueReady(key);
  }

  acknowledge(key: string): void {
    this.inFlight.delete(key);
    this.attempts.delete(key);
    const hadDirty = this.dirty.delete(key);
    if (hadDirty) this.enqueueReady(key);
    this.drain();
  }

  retry(key: string): void {
    this.assertOpen();
    this.inFlight.delete(key);
    if (this.retryTimers.has(key)) return;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const delayMs = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    const handle = this.setTimer(() => {
      this.retryTimers.delete(key);
      this.enqueueReady(key);
    }, delayMs);
    this.retryTimers.set(key, handle);
  }

  take(): Promise<WorkItemResult> {
    this.assertOpen();
    return new Promise<WorkItemResult>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }

  size(): number {
    return this.pending.length;
  }

  pendingKeys(): readonly string[] {
    return [...this.pending];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.retryTimers.values()) this.clearTimer(handle);
    this.retryTimers.clear();
    if (this.tokenTimer !== undefined) {
      this.clearTimer(this.tokenTimer);
      this.tokenTimer = undefined;
    }
    const err = new QueueClosedError();
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.reject(err);
    }
  }

  private enqueueReady(key: string): void {
    if (this.pendingSet.has(key) || this.inFlight.has(key)) {
      this.dirty.add(key);
      return;
    }
    this.pendingSet.add(key);
    this.pending.push(key);
    this.drain();
  }

  private drain(): void {
    if (this.closed) return;
    this.refillTokens();
    while (this.waiters.length > 0 && this.pending.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift();
      const key = this.pending.shift();
      if (waiter === undefined || key === undefined) continue;
      this.pendingSet.delete(key);
      this.inFlight.add(key);
      this.tokens -= 1;
      waiter.resolve({ key, attempt: this.attempts.get(key) ?? 0 });
    }
    this.scheduleTokenRefillIfNeeded();
  }

  private refillTokens(): void {
    const current = this.now();
    const elapsedMs = Math.max(0, current - this.lastRefillMs);
    if (elapsedMs === 0) return;
    const refill = (elapsedMs / 1000) * this.globalRatePerSec;
    this.tokens = Math.min(this.globalBurst, this.tokens + refill);
    this.lastRefillMs = current;
  }

  private scheduleTokenRefillIfNeeded(): void {
    if (this.tokenTimer !== undefined) return;
    if (this.waiters.length === 0 || this.pending.length === 0 || this.tokens >= 1) return;
    const deficit = 1 - this.tokens;
    const delayMs = Math.max(1, Math.ceil((deficit / this.globalRatePerSec) * 1000));
    this.tokenTimer = this.setTimer(() => {
      this.tokenTimer = undefined;
      this.drain();
    }, delayMs);
  }

  private assertOpen(): void {
    if (this.closed) throw new QueueClosedError();
  }
}
```

- [ ] **Step 4: Run queue tests to verify GREEN**

Run:

```bash
bun test src/core/workqueue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/workqueue.ts src/core/workqueue.test.ts
git commit -m "feat(core): add keyed work queue"
```

---

### Task 2: Claim Reconciliation Status Transitions

**Files:**
- Create: `src/core/claim-controller.test.ts`
- Create: `src/core/claim-controller.ts`

- [ ] **Step 1: Write failing controller reconciliation tests**

Create `src/core/claim-controller.test.ts` with the initial status-transition coverage:

```ts
import { describe, expect, test } from "bun:test";
import { ClaimReconciliationController, type ClaimControllerStore } from "./claim-controller.js";
import { claimViewToEntity, type ClaimEntity, type Condition } from "./entity.js";
import { Finalizer } from "./lifecycle-metadata.js";
import { ClaimStatus, type AgentIdentity, type ClaimView } from "./models.js";
import type { ClaimStatusPatch } from "./store.js";

const FIXED_NOW_MS = Date.parse("2026-05-09T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-05-09T12:00:00.000Z";

const agent: AgentIdentity = {
  agentId: "agent-1",
  role: "coder",
  platform: "codex",
};

function makeView(overrides: {
  readonly id?: string;
  readonly phase?: ClaimStatus;
  readonly generation?: number;
  readonly observedGeneration?: number;
  readonly leaseExpiresAt?: string;
  readonly conditions?: readonly Condition[];
  readonly deletionTimestamp?: string;
  readonly finalizers?: readonly Finalizer[];
} = {}): ClaimView {
  const id = overrides.id ?? "claim-1";
  return {
    spec: {
      id,
      roleName: "coder",
      platform: "codex",
      assignee: agent,
      leaseDeadlineSec: 300,
      generation: overrides.generation ?? 1,
      targetRef: "target-1",
      agent,
      intentSummary: "work on target",
      createdAt: "2026-05-09T11:55:00.000Z",
      ...(overrides.deletionTimestamp === undefined
        ? {}
        : { deletionTimestamp: overrides.deletionTimestamp }),
      ...(overrides.finalizers === undefined ? {} : { finalizers: overrides.finalizers }),
    },
    status: {
      id,
      phase: overrides.phase ?? ClaimStatus.Active,
      observedGeneration: overrides.observedGeneration ?? 1,
      lastHeartbeatAt: "2026-05-09T11:56:00.000Z",
      leaseExpiresAt: overrides.leaseExpiresAt ?? "2026-05-09T12:05:00.000Z",
      conditions: overrides.conditions ?? [],
      lastTransitionAt: "2026-05-09T11:56:00.000Z",
      attemptCount: 0,
      revision: 1,
    },
  };
}

class FakeClaimControllerStore implements ClaimControllerStore {
  readonly views = new Map<string, ClaimView>();
  readonly patches: Array<{ readonly claimId: string; readonly patch: ClaimStatusPatch }> = [];
  specMutationCalls = 0;

  async getClaimView(claimId: string): Promise<ClaimView | undefined> {
    return this.views.get(claimId);
  }

  async patchClaimStatus(claimId: string, patch: ClaimStatusPatch): Promise<ClaimView> {
    const existing = this.views.get(claimId);
    if (existing === undefined) throw new Error(`missing claim ${claimId}`);
    this.patches.push({ claimId, patch });
    const next: ClaimView = {
      spec: existing.spec,
      status: {
        ...existing.status,
        ...(patch.phase === undefined ? {} : { phase: patch.phase }),
        ...(patch.observedGeneration === undefined
          ? {}
          : { observedGeneration: patch.observedGeneration }),
        ...(patch.agentSessionId === undefined ? {} : { agentSessionId: patch.agentSessionId }),
        ...(patch.lastHeartbeatAt === undefined
          ? {}
          : { lastHeartbeatAt: patch.lastHeartbeatAt }),
        ...(patch.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: patch.leaseExpiresAt }),
        ...(patch.currentContributionCid === undefined
          ? {}
          : { currentContributionCid: patch.currentContributionCid }),
        ...(patch.conditions === undefined ? {} : { conditions: patch.conditions }),
        ...(patch.lastTransitionAt === undefined
          ? {}
          : { lastTransitionAt: patch.lastTransitionAt }),
        revision: existing.status.revision + 1,
      },
    };
    this.views.set(claimId, next);
    return next;
  }

  async listEntities(): Promise<readonly ClaimEntity[]> {
    return [...this.views.values()].map((view) =>
      claimViewToEntity(view, () => FIXED_NOW_MS, "default"),
    );
  }

  async putClaimSpec(): Promise<ClaimView> {
    this.specMutationCalls += 1;
    throw new Error("putClaimSpec must not be called by the controller");
  }
}

function makeController(store: FakeClaimControllerStore): ClaimReconciliationController {
  return new ClaimReconciliationController({
    claimStore: store,
    now: () => FIXED_NOW_MS,
  });
}

function conditionByType(conditions: readonly Condition[], type: string): Condition | undefined {
  return conditions.find((condition) => condition.type === type);
}

describe("ClaimReconciliationController", () => {
  test("expires active claims whose lease deadline has passed", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set(
      "claim-1",
      makeView({ leaseExpiresAt: "2026-05-09T11:59:59.000Z" }),
    );
    const controller = makeController(store);

    const transition = await controller.reconcileClaim("claim-1");

    expect(transition).toEqual({
      claimId: "claim-1",
      fromPhase: ClaimStatus.Active,
      toPhase: ClaimStatus.Expired,
      reason: "lease-expired",
      observedGeneration: 1,
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0]?.patch.phase).toBe(ClaimStatus.Expired);
    expect(store.patches[0]?.patch.observedGeneration).toBe(1);
    expect(store.patches[0]?.patch.lastTransitionAt).toBe(FIXED_NOW_ISO);
    const conditions = store.patches[0]?.patch.conditions ?? [];
    expect(conditionByType(conditions, "Active")?.status).toBe("False");
    expect(conditionByType(conditions, "Expired")?.status).toBe("True");
    expect(conditionByType(conditions, "Expired")?.reason).toBe("lease-expired");
    expect(store.specMutationCalls).toBe(0);
  });

  test("catches observedGeneration up without changing phase", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set("claim-1", makeView({ generation: 7, observedGeneration: 3 }));
    const controller = makeController(store);

    const transition = await controller.reconcileClaim("claim-1");

    expect(transition).toEqual({
      claimId: "claim-1",
      fromPhase: ClaimStatus.Active,
      toPhase: ClaimStatus.Active,
      reason: "observed-generation-current",
      observedGeneration: 7,
    });
    expect(store.patches[0]?.patch.phase).toBeUndefined();
    expect(store.patches[0]?.patch.observedGeneration).toBe(7);
    expect(store.specMutationCalls).toBe(0);
  });

  test("does not move terminal claims back to active", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set(
      "claim-1",
      makeView({
        phase: ClaimStatus.Completed,
        generation: 3,
        observedGeneration: 1,
        leaseExpiresAt: "2026-05-09T11:00:00.000Z",
      }),
    );
    const controller = makeController(store);

    await controller.reconcileClaim("claim-1");

    expect(store.patches[0]?.patch.phase).toBeUndefined();
    expect(store.patches[0]?.patch.observedGeneration).toBe(3);
  });

  test("adds terminating condition only when deletion timestamp and finalizers are present", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set(
      "claim-1",
      makeView({
        deletionTimestamp: "2026-05-09T11:59:00.000Z",
        finalizers: [Finalizer.ReleaseSlots],
      }),
    );
    const controller = makeController(store);

    await controller.reconcileClaim("claim-1");

    const conditions = store.patches[0]?.patch.conditions ?? [];
    expect(conditionByType(conditions, "Terminating")?.status).toBe("True");
    expect(conditionByType(conditions, "Terminating")?.reason).toBe("deletion-requested");
  });

  test("preserves unknown condition types when updating lifecycle conditions", async () => {
    const store = new FakeClaimControllerStore();
    const externalCondition: Condition = {
      type: "ExternalControllerReady",
      status: "Unknown",
      observedGeneration: 1,
      lastTransitionTime: "2026-05-09T11:56:00.000Z",
      reason: "waiting",
      message: "external controller has not reported",
    };
    store.views.set(
      "claim-1",
      makeView({
        leaseExpiresAt: "2026-05-09T11:59:59.000Z",
        conditions: [externalCondition],
      }),
    );
    const controller = makeController(store);

    await controller.reconcileClaim("claim-1");

    const conditions = store.patches[0]?.patch.conditions ?? [];
    expect(conditionByType(conditions, "ExternalControllerReady")).toEqual(externalCondition);
    expect(conditionByType(conditions, "Expired")?.status).toBe("True");
  });

  test("enqueueFromEntity ignores payload details and reconcile re-reads current store state", async () => {
    const store = new FakeClaimControllerStore();
    const staleView = makeView({ id: "claim-1", leaseExpiresAt: "2026-05-09T12:05:00.000Z" });
    const currentView = makeView({
      id: "claim-1",
      leaseExpiresAt: "2026-05-09T11:59:59.000Z",
    });
    store.views.set("claim-1", currentView);
    const controller = makeController(store);

    controller.enqueueFromEntity(claimViewToEntity(staleView, () => FIXED_NOW_MS, "default"));
    await controller.reconcileClaim("claim-1");

    expect(store.patches[0]?.patch.phase).toBe(ClaimStatus.Expired);
  });

  test("missing claims are successful no-ops", async () => {
    const store = new FakeClaimControllerStore();
    const controller = makeController(store);

    await expect(controller.reconcileClaim("missing")).resolves.toBeUndefined();
    expect(store.patches).toHaveLength(0);
  });

  test("invalid lease timestamps reject so worker retry can handle the claim", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set("claim-1", makeView({ leaseExpiresAt: "not-a-date" }));
    const controller = makeController(store);

    await expect(controller.reconcileClaim("claim-1")).rejects.toThrow(
      "invalid leaseExpiresAt for claim claim-1",
    );
    expect(store.patches).toHaveLength(0);
  });

  test("resync enqueues every claim entity id", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set("claim-1", makeView({ id: "claim-1" }));
    store.views.set("claim-2", makeView({ id: "claim-2" }));
    const controller = makeController(store);

    await expect(controller.resync()).resolves.toBe(2);
  });
});
```

- [ ] **Step 2: Run controller tests to verify RED**

Run:

```bash
bun test src/core/claim-controller.test.ts
```

Expected: FAIL because `src/core/claim-controller.ts` does not exist.

- [ ] **Step 3: Implement status-only reconciliation**

Create `src/core/claim-controller.ts` with direct reconcile and queue enqueue support:

```ts
import type { ClaimEntity, Condition } from "./entity.js";
import { ClaimStatus, type ClaimStatus as ClaimStatusValue, type ClaimView } from "./models.js";
import type { ClaimStatusPatch, ClaimStore } from "./store.js";
import { KeyedWorkQueue } from "./workqueue.js";

export type ClaimControllerStore = Pick<
  ClaimStore,
  "getClaimView" | "patchClaimStatus" | "listEntities"
>;

export interface ClaimStatusTransition {
  readonly claimId: string;
  readonly fromPhase: ClaimStatusValue;
  readonly toPhase: ClaimStatusValue;
  readonly reason: string;
  readonly observedGeneration: number;
}

export interface ClaimReconciliationControllerOptions {
  readonly claimStore: ClaimControllerStore;
  readonly resyncIntervalMs?: number;
  readonly workerCount?: number;
  readonly queue?: KeyedWorkQueue;
  readonly now?: () => number;
  readonly onError?: (error: unknown, claimId: string) => void;
  readonly onTransition?: (transition: ClaimStatusTransition) => void;
}

interface MutableClaimStatusPatch {
  phase?: ClaimStatusValue;
  observedGeneration?: number;
  conditions?: readonly Condition[];
  lastTransitionAt?: string;
}

interface ComputedPatch {
  readonly patch: ClaimStatusPatch;
  readonly transition: ClaimStatusTransition;
}

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_COUNT = 1;

export class ClaimReconciliationController {
  private readonly claimStore: ClaimControllerStore;
  private readonly queue: KeyedWorkQueue;
  private readonly now: () => number;
  private readonly onError: ((error: unknown, claimId: string) => void) | undefined;
  private readonly onTransition:
    | ((transition: ClaimStatusTransition) => void)
    | undefined;
  private readonly resyncIntervalMs: number;
  private readonly workerCount: number;

  constructor(opts: ClaimReconciliationControllerOptions) {
    this.claimStore = opts.claimStore;
    this.queue = opts.queue ?? new KeyedWorkQueue();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
    this.onTransition = opts.onTransition;
    this.resyncIntervalMs = opts.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = opts.workerCount ?? DEFAULT_WORKER_COUNT;
  }

  enqueue(claimId: string): void {
    this.queue.enqueue(claimId);
  }

  enqueueFromEntity(entity: ClaimEntity): void {
    this.enqueue(entity.id);
  }

  async resync(): Promise<number> {
    const entities = await this.claimStore.listEntities();
    for (const entity of entities) this.enqueue(entity.id);
    return entities.length;
  }

  async reconcileClaim(claimId: string): Promise<ClaimStatusTransition | undefined> {
    const view = await this.claimStore.getClaimView(claimId);
    if (view === undefined) return undefined;

    const computed = computeClaimStatusPatch(view, this.now());
    if (computed === undefined) return undefined;

    await this.claimStore.patchClaimStatus(claimId, computed.patch);
    this.onTransition?.(computed.transition);
    return computed.transition;
  }

  start(): void {
    void this.workerCount;
    void this.resyncIntervalMs;
  }

  async stop(): Promise<void> {
    this.queue.close();
  }
}

function computeClaimStatusPatch(view: ClaimView, nowMs: number): ComputedPatch | undefined {
  const nowIso = new Date(nowMs).toISOString();
  const fromPhase = view.status.phase;
  let toPhase = fromPhase;
  let reason = "observed-generation-current";
  let changed = false;
  let conditions = view.status.conditions;
  const patch: MutableClaimStatusPatch = {};

  const leaseExpiresAtMs = Date.parse(view.status.leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresAtMs)) {
    throw new Error(`invalid leaseExpiresAt for claim ${view.spec.id}: ${view.status.leaseExpiresAt}`);
  }

  if (view.status.observedGeneration !== view.spec.generation) {
    patch.observedGeneration = view.spec.generation;
    changed = true;
    conditions = upsertCondition(
      conditions,
      makeCondition({
        type: "ObservedGenerationCurrent",
        status: "True",
        observedGeneration: view.spec.generation,
        lastTransitionTime: nowIso,
        reason: "reconciled",
        message: `status observed spec generation ${view.spec.generation}`,
      }),
    );
  }

  if (fromPhase === ClaimStatus.Active && leaseExpiresAtMs <= nowMs) {
    toPhase = ClaimStatus.Expired;
    reason = "lease-expired";
    patch.phase = ClaimStatus.Expired;
    patch.observedGeneration = view.spec.generation;
    patch.lastTransitionAt = nowIso;
    changed = true;
    conditions = upsertCondition(
      conditions,
      makeCondition({
        type: "Active",
        status: "False",
        observedGeneration: view.spec.generation,
        lastTransitionTime: nowIso,
        reason: "lease-expired",
        message: `claim lease expired at ${view.status.leaseExpiresAt}`,
      }),
    );
    conditions = upsertCondition(
      conditions,
      makeCondition({
        type: "Expired",
        status: "True",
        observedGeneration: view.spec.generation,
        lastTransitionTime: nowIso,
        reason: "lease-expired",
        message: `claim lease expired at ${view.status.leaseExpiresAt}`,
      }),
    );
  }

  const hasDeletionTimestamp = view.spec.deletionTimestamp !== undefined;
  const hasFinalizers = (view.spec.finalizers?.length ?? 0) > 0;
  if (hasDeletionTimestamp && hasFinalizers) {
    conditions = upsertCondition(
      conditions,
      makeCondition({
        type: "Terminating",
        status: "True",
        observedGeneration: view.spec.generation,
        lastTransitionTime: nowIso,
        reason: "deletion-requested",
        message: "claim deletion is waiting on finalizers",
      }),
    );
  }

  if (!conditionsEqual(conditions, view.status.conditions)) {
    patch.conditions = conditions;
    changed = true;
  }

  if (!changed) return undefined;

  return {
    patch: toClaimStatusPatch(patch),
    transition: {
      claimId: view.spec.id,
      fromPhase,
      toPhase,
      reason,
      observedGeneration: patch.observedGeneration ?? view.status.observedGeneration,
    },
  };
}

function toClaimStatusPatch(patch: MutableClaimStatusPatch): ClaimStatusPatch {
  return {
    ...(patch.phase === undefined ? {} : { phase: patch.phase }),
    ...(patch.observedGeneration === undefined
      ? {}
      : { observedGeneration: patch.observedGeneration }),
    ...(patch.conditions === undefined ? {} : { conditions: patch.conditions }),
    ...(patch.lastTransitionAt === undefined ? {} : { lastTransitionAt: patch.lastTransitionAt }),
  };
}

function makeCondition(condition: Condition): Condition {
  return condition;
}

function upsertCondition(conditions: readonly Condition[], next: Condition): readonly Condition[] {
  const existing = conditions.find((condition) => condition.type === next.type);
  const stableNext =
    existing !== undefined &&
    existing.status === next.status &&
    existing.reason === next.reason &&
    existing.message === next.message
      ? { ...next, lastTransitionTime: existing.lastTransitionTime }
      : next;
  const replaced = conditions.map((condition) =>
    condition.type === stableNext.type ? stableNext : condition,
  );
  return replaced.some((condition) => condition.type === stableNext.type)
    ? replaced
    : [...conditions, stableNext];
}

function conditionsEqual(left: readonly Condition[], right: readonly Condition[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run controller tests to verify GREEN**

Run:

```bash
bun test src/core/claim-controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/claim-controller.ts src/core/claim-controller.test.ts
git commit -m "feat(core): add claim status reconciler"
```

---

### Task 3: Controller Worker Loop, Retry, and Stop Semantics

**Files:**
- Modify: `src/core/claim-controller.test.ts`
- Modify: `src/core/claim-controller.ts`

- [ ] **Step 1: Add failing worker lifecycle tests**

Append these tests inside the existing `describe("ClaimReconciliationController", () => { ... })` block in `src/core/claim-controller.test.ts`:

```ts
  test("start processes queued claims and invokes transition callback", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set(
      "claim-1",
      makeView({ leaseExpiresAt: "2026-05-09T11:59:59.000Z" }),
    );
    const transitions: unknown[] = [];
    const controller = new ClaimReconciliationController({
      claimStore: store,
      now: () => FIXED_NOW_MS,
      onTransition: (transition) => transitions.push(transition),
    });

    controller.enqueue("claim-1");
    controller.start();
    await waitFor(() => store.patches.length === 1);
    await controller.stop();

    expect(store.patches[0]?.patch.phase).toBe(ClaimStatus.Expired);
    expect(transitions).toHaveLength(1);
  });

  test("failed worker reconcile retries and re-reads fresh store state", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set("claim-1", makeView({ leaseExpiresAt: "not-a-date" }));
    const errors: unknown[] = [];
    const controller = new ClaimReconciliationController({
      claimStore: store,
      now: () => FIXED_NOW_MS,
      queue: new KeyedWorkQueue({ baseDelayMs: 1, maxDelayMs: 1 }),
      onError: (error) => errors.push(error),
    });

    controller.enqueue("claim-1");
    controller.start();
    await waitFor(() => errors.length === 1);

    store.views.set(
      "claim-1",
      makeView({ leaseExpiresAt: "2026-05-09T11:59:59.000Z" }),
    );
    await waitFor(() => store.patches.length === 1);
    await controller.stop();

    expect(store.patches[0]?.patch.phase).toBe(ClaimStatus.Expired);
  });

  test("stop cancels workers and prevents later queued processing", async () => {
    const store = new FakeClaimControllerStore();
    store.views.set(
      "claim-1",
      makeView({ leaseExpiresAt: "2026-05-09T11:59:59.000Z" }),
    );
    const controller = makeController(store);

    controller.start();
    await controller.stop();
    expect(() => controller.enqueue("claim-1")).toThrow("work queue is closed");
    await sleep(5);
    expect(store.patches).toHaveLength(0);
  });
```

Add these imports near the top of the same file:

```ts
import { KeyedWorkQueue } from "./workqueue.js";
```

Add these helpers near the bottom of the same file:

```ts
async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) throw new Error("condition was not met in time");
    await sleep(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Run controller tests to verify RED**

Run:

```bash
bun test src/core/claim-controller.test.ts
```

Expected: FAIL because `start()` is currently a no-op and worker retry is not implemented.

- [ ] **Step 3: Implement worker lifecycle in `ClaimReconciliationController`**

In `src/core/claim-controller.ts`, add these private fields to `ClaimReconciliationController`:

```ts
  private running = false;
  private stopRequested = false;
  private workers: Promise<void>[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
```

Update the queue import at the top of `src/core/claim-controller.ts`:

```ts
import { KeyedWorkQueue, type WorkItemResult } from "./workqueue.js";
```

Replace `start()` and `stop()` with:

```ts
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    for (let i = 0; i < this.workerCount; i += 1) {
      this.workers.push(this.workerLoop());
    }
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => {
        this.onError?.(error, "__resync__");
      });
    }, this.resyncIntervalMs);
    this.resyncTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running && this.stopRequested) return;
    this.stopRequested = true;
    if (this.resyncTimer !== undefined) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    this.queue.close();
    const workers = this.workers;
    this.workers = [];
    await Promise.all(workers);
    this.running = false;
  }
```

Add this private worker method inside the class:

```ts
  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let item: WorkItemResult;
      try {
        item = await this.queue.take();
      } catch (err) {
        if (this.stopRequested) return;
        throw err;
      }

      try {
        await this.reconcileClaim(item.key);
        this.queue.acknowledge(item.key);
      } catch (error) {
        this.onError?.(error, item.key);
        if (!this.stopRequested) this.queue.retry(item.key);
      }
    }
  }
```

- [ ] **Step 4: Run controller tests to verify GREEN**

Run:

```bash
bun test src/core/claim-controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/core/claim-controller.ts src/core/claim-controller.test.ts
git commit -m "feat(core): run claim reconciliation workers"
```

---

### Task 4: Public Core Exports

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add export expectations to the typecheck surface**

No separate test file is needed. `bun run typecheck` will fail if exported type names are wrong after importers use them. Modify only exports in this task.

- [ ] **Step 2: Export queue and controller APIs**

In `src/core/index.ts`, add this block after the existing claim-logic exports:

```ts
export type {
  ClaimControllerStore,
  ClaimReconciliationControllerOptions,
  ClaimStatusTransition,
} from "./claim-controller.js";
export { ClaimReconciliationController } from "./claim-controller.js";
```

Add this block near other store/utility exports:

```ts
export type {
  DefaultTimerHandle,
  WorkItemResult,
  WorkQueueOptions,
} from "./workqueue.js";
export { KeyedWorkQueue, QueueClosedError } from "./workqueue.js";
```

Extend the existing `models.js` export block so it includes split claim records:

```ts
  type ClaimSpecRecord,
  type ClaimStatusRecord,
  type ClaimView,
```

Extend the existing `store.js` export block so it includes:

```ts
  ClaimQuery,
  ClaimStatusPatch,
```

- [ ] **Step 3: Run typecheck to verify exports**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/core/index.ts
git commit -m "feat(core): export claim controller APIs"
```

---

### Task 5: Focused and Regression Verification

**Files:**
- No source edits unless verification exposes a real issue.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/core/workqueue.test.ts src/core/claim-controller.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing reconciliation and claim-store regression tests**

Run:

```bash
bun test src/core/reconciler.test.ts src/core/claim-store.conformance.ts src/local/reconciler.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit verification fixes if any were required**

If verification required code changes, commit only those files:

```bash
git add src/core/workqueue.ts src/core/workqueue.test.ts src/core/claim-controller.ts src/core/claim-controller.test.ts src/core/index.ts
git commit -m "fix(core): stabilize claim controller verification"
```

If no files changed during verification, skip this commit.

---

## Self-Review Checklist

- Spec coverage:
  - Dark core infrastructure: Tasks 1-4, with no server files modified.
  - Dirty-set dedupe: Task 1 tests and implementation.
  - Per-key exponential backoff: Task 1 tests and implementation.
  - Global token bucket: Task 1 test and implementation.
  - Status-only writes: Task 2 fake store exposes only status write methods to the controller.
  - Re-read store on reconcile: Task 2 `enqueueFromEntity` stale-payload test.
  - Periodic resync seam: Task 2 `resync()` test and Task 3 timer.
  - Retry on failure: Task 3 worker retry test.
  - No runtime server wiring: File structure explicitly excludes `src/server/**`.

- Type consistency:
  - Queue class is `KeyedWorkQueue`.
  - Controller class is `ClaimReconciliationController`.
  - Store dependency type is `ClaimControllerStore`.
  - Transition type is `ClaimStatusTransition`.
  - Status patch type is the existing `ClaimStatusPatch`.

- Verification:
  - Targeted tests first.
  - Existing reconciler and claim-store tests next.
  - `bun run typecheck` and `bun run check` last.
