# Slow-Start Batching Primitive (#307) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, pure `slowStartBatch` primitive that spawns N children in geometrically growing batches (1→2→4→8), halts on the first batch failure, and classifies failures into halt vs throttle-with-backoff.

**Architecture:** One cohesive module `src/core/slow-start-batch.ts` exporting the runner, a `BatchStrategy` config type (canonical home for `spec.batchStrategy`) with validation, a bounded-backoff helper, an injectable failure classifier, and a `grove_spawn_batch_size` metric observer. No live wiring — the fan-out driver that calls this is owned by later issues (#306/#336/#337/#358).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `bun:test`, biome, tsc. Extends the existing `GroveError` hierarchy (`src/core/errors.ts`) and reuses `AdmissionRejectError` (`src/core/admission/errors.ts`).

**Spec:** `docs/superpowers/specs/2026-06-08-307-slow-start-batching-design.md`

---

## File Structure

- **Create** `src/core/slow-start-batch.ts` — all types, validation, classifier, backoff helper, and the runner. Single file because `BatchStrategy` is the configuration for `slowStartBatch`; they are tightly coupled and small.
- **Create** `src/core/slow-start-batch.test.ts` — unit tests (`bun:test`), grown task-by-task.
- **Modify** `src/core/index.ts` — re-export the public surface (final task).

## Conventions for every task

- Tests: `import { describe, expect, test } from "bun:test";` and import from `"./slow-start-batch.js"` (ESM `.js` specifier even though the source is `.ts`).
- Run a single test file: `bun test src/core/slow-start-batch.test.ts`
- Commit with `git commit --no-verify` (worktree pre-commit biome hangs on full-repo; we lint targeted instead).
- Format/lint a single file: `biome check --write src/core/slow-start-batch.ts`

---

### Task 1: BatchStrategy config + validation

**Files:**
- Create: `src/core/slow-start-batch.ts`
- Test: `src/core/slow-start-batch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/slow-start-batch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeBatchStrategy } from "./slow-start-batch.js";

describe("normalizeBatchStrategy", () => {
  test("applies defaults for empty input", () => {
    const s = normalizeBatchStrategy();
    expect(s.initialBatchSize).toBe(1);
    expect(s.multiplier).toBe(2);
    expect(s.maxBatchSize).toBe(Number.POSITIVE_INFINITY);
    expect(s.backoff).toEqual({ baseMs: 1000, multiplier: 2, maxMs: 30_000 });
  });

  test("passes through provided values", () => {
    const s = normalizeBatchStrategy({
      initialBatchSize: 2,
      multiplier: 3,
      maxBatchSize: 16,
      backoff: { baseMs: 500, multiplier: 4, maxMs: 5000 },
    });
    expect(s.initialBatchSize).toBe(2);
    expect(s.multiplier).toBe(3);
    expect(s.maxBatchSize).toBe(16);
    expect(s.backoff).toEqual({ baseMs: 500, multiplier: 4, maxMs: 5000 });
  });

  test("rejects invalid input with RangeError", () => {
    expect(() => normalizeBatchStrategy({ initialBatchSize: 0 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ initialBatchSize: 1.5 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ multiplier: 0.5 })).toThrow(RangeError);
    expect(() => normalizeBatchStrategy({ maxBatchSize: 4, initialBatchSize: 8 })).toThrow(
      RangeError,
    );
    expect(() => normalizeBatchStrategy({ backoff: { maxMs: 100, baseMs: 1000 } })).toThrow(
      RangeError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: FAIL — `Cannot find module './slow-start-batch.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/slow-start-batch.ts`:

```ts
import { AdmissionRejectError } from "./admission/errors.js";
import { GroveError } from "./errors.js";

export interface BackoffStrategy {
  readonly baseMs?: number;
  readonly multiplier?: number;
  readonly maxMs?: number;
}

export interface BatchStrategy {
  readonly initialBatchSize?: number;
  readonly multiplier?: number;
  readonly maxBatchSize?: number;
  readonly backoff?: BackoffStrategy;
}

export interface NormalizedBatchStrategy {
  readonly initialBatchSize: number;
  readonly multiplier: number;
  readonly maxBatchSize: number; // Number.POSITIVE_INFINITY when unbounded
  readonly backoff: Required<BackoffStrategy>;
}

const DEFAULT_INITIAL_BATCH_SIZE = 1;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function normalizeBatchStrategy(input?: BatchStrategy): NormalizedBatchStrategy {
  const initialBatchSize = input?.initialBatchSize ?? DEFAULT_INITIAL_BATCH_SIZE;
  const multiplier = input?.multiplier ?? DEFAULT_MULTIPLIER;
  const maxBatchSize = input?.maxBatchSize ?? Number.POSITIVE_INFINITY;
  const baseMs = input?.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMultiplier = input?.backoff?.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const maxMs = input?.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;

  requirePositiveInt(initialBatchSize, "initialBatchSize");
  requireFiniteMin(multiplier, 1, "multiplier");
  if (maxBatchSize !== Number.POSITIVE_INFINITY) {
    requirePositiveInt(maxBatchSize, "maxBatchSize");
    if (maxBatchSize < initialBatchSize) {
      throw new RangeError(
        `maxBatchSize (${maxBatchSize}) must be >= initialBatchSize (${initialBatchSize})`,
      );
    }
  }
  requirePositiveInt(baseMs, "backoff.baseMs");
  requireFiniteMin(backoffMultiplier, 1, "backoff.multiplier");
  requirePositiveInt(maxMs, "backoff.maxMs");
  if (maxMs < baseMs) {
    throw new RangeError(`backoff.maxMs (${maxMs}) must be >= backoff.baseMs (${baseMs})`);
  }

  return {
    initialBatchSize,
    multiplier,
    maxBatchSize,
    backoff: { baseMs, multiplier: backoffMultiplier, maxMs },
  };
}

function requirePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1 (got ${value})`);
  }
}

function requireFiniteMin(value: number, min: number, name: string): void {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min} (got ${value})`);
  }
}
```

> Note: `AdmissionRejectError` / `GroveError` are imported now to keep import order stable; they are used in Task 3. Biome may warn about unused imports until then — if it does, add the imports in Task 3 instead and remove them here.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts
git commit --no-verify -m "feat(orchestration): #307 BatchStrategy config + validation"
```

---

### Task 2: Bounded backoff helper

**Files:**
- Modify: `src/core/slow-start-batch.ts`
- Test: `src/core/slow-start-batch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/slow-start-batch.test.ts`:

```ts
import { computeBackoffMs } from "./slow-start-batch.js";

describe("computeBackoffMs", () => {
  const backoff = { baseMs: 1000, multiplier: 2, maxMs: 30_000 } as const;

  test("attempt 0 returns baseMs", () => {
    expect(computeBackoffMs(0, backoff)).toBe(1000);
  });

  test("grows geometrically", () => {
    expect(computeBackoffMs(1, backoff)).toBe(2000);
    expect(computeBackoffMs(2, backoff)).toBe(4000);
    expect(computeBackoffMs(3, backoff)).toBe(8000);
  });

  test("clamps to maxMs", () => {
    expect(computeBackoffMs(10, backoff)).toBe(30_000);
  });

  test("guards non-positive / non-finite attempts to baseMs", () => {
    expect(computeBackoffMs(-5, backoff)).toBe(1000);
    expect(computeBackoffMs(Number.NaN, backoff)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: FAIL — `computeBackoffMs is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/slow-start-batch.ts`:

```ts
export function computeBackoffMs(attempt: number, backoff: Required<BackoffStrategy>): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = backoff.baseMs * backoff.multiplier ** n;
  return Math.min(raw, backoff.maxMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts
git commit --no-verify -m "feat(orchestration): #307 bounded exponential backoff helper"
```

---

### Task 3: Failure classification

**Files:**
- Modify: `src/core/slow-start-batch.ts`
- Test: `src/core/slow-start-batch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/slow-start-batch.test.ts`:

```ts
import { AdmissionRejectError } from "./admission/errors.js";
import { RuntimeUnavailableError, defaultFailureClassifier } from "./slow-start-batch.js";

describe("defaultFailureClassifier", () => {
  test("classifies AdmissionRejectError as admission", () => {
    const err = new AdmissionRejectError({
      ruleName: "max-fanout",
      ruleType: "concurrency",
      reason: "capacity exhausted",
    });
    expect(defaultFailureClassifier(err)).toBe("admission");
  });

  test("classifies RuntimeUnavailableError as backpressure", () => {
    expect(defaultFailureClassifier(new RuntimeUnavailableError("runtime down"))).toBe(
      "backpressure",
    );
  });

  test("classifies anything else as task", () => {
    expect(defaultFailureClassifier(new Error("bad prompt"))).toBe("task");
    expect(defaultFailureClassifier("oops")).toBe("task");
  });

  test("RuntimeUnavailableError carries a reason", () => {
    const err = new RuntimeUnavailableError("runtime down", { reason: "provider-pressure" });
    expect(err.reason).toBe("provider-pressure");
    expect(err).toBeInstanceOf(Error);
  });
});
```

> The `ruleType: "concurrency"` value must be a member of `NormalizedAdmissionRule["type"]`. If `bun test` reports a type error on that literal, open `src/core/admission/types.ts`, pick any valid member of that union, and use it — the classifier only checks `instanceof`, not the rule type.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: FAIL — `RuntimeUnavailableError` / `defaultFailureClassifier` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/slow-start-batch.ts`:

```ts
export type FailureClass = "task" | "backpressure" | "admission";

export class RuntimeUnavailableError extends GroveError {
  readonly reason: string;

  constructor(message: string, options?: { reason?: string }) {
    super(message);
    this.name = "RuntimeUnavailableError";
    this.reason = options?.reason ?? message;
  }
}

export interface ClassifiedFailure {
  readonly index: number; // index into the input items array
  readonly batchIndex: number; // 0-based batch the item was in
  readonly class: FailureClass;
  readonly reason: string;
  readonly error: unknown;
}

export type FailureClassifier = (error: unknown) => FailureClass;

export const defaultFailureClassifier: FailureClassifier = (error) => {
  if (error instanceof AdmissionRejectError) return "admission";
  if (error instanceof RuntimeUnavailableError) return "backpressure";
  return "task";
};

function failureReason(error: unknown): string {
  if (error instanceof AdmissionRejectError) return error.reason;
  if (error instanceof RuntimeUnavailableError) return error.reason;
  if (error instanceof Error) return error.message;
  return String(error);
}
```

> `failureReason` is unused until Task 4. If biome flags it, proceed — Task 4 consumes it. (Do not delete it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS (Tasks 1–3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts
git commit --no-verify -m "feat(orchestration): #307 failure classification + RuntimeUnavailableError"
```

---

### Task 4: slowStartBatch runner — success paths + metric

**Files:**
- Modify: `src/core/slow-start-batch.ts`
- Test: `src/core/slow-start-batch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/slow-start-batch.test.ts`:

```ts
import {
  type SpawnBatchMetric,
  normalizeBatchStrategy as norm,
  slowStartBatch,
} from "./slow-start-batch.js";

describe("slowStartBatch — success", () => {
  test("doubling sequence 1,2,4,8 over 15 items", async () => {
    const batches: number[][] = [];
    let current: number[] = [];
    const calls: number[] = [];
    // Record which items landed in which batch by observing onSpawnBatch boundaries.
    const items = Array.from({ length: 15 }, (_, i) => i);
    const sizes: number[] = [];
    const result = await slowStartBatch(
      items,
      async (item) => {
        calls.push(item);
        current.push(item);
      },
      norm(),
      {
        onSpawnBatch: (m: SpawnBatchMetric) => {
          sizes.push(m.batchSize);
          batches.push(current);
          current = [];
        },
      },
    );
    expect(sizes).toEqual([1, 2, 4, 8]);
    expect(result.outcome).toBe("completed");
    expect(result.succeeded).toBe(15);
    expect(result.attempted).toBe(15);
    expect(result.failures).toEqual([]);
    expect(calls.sort((a, b) => a - b)).toEqual(items);
  });

  test("empty input completes with no spawn/metric calls", async () => {
    let spawned = 0;
    let metrics = 0;
    const result = await slowStartBatch(
      [],
      async () => {
        spawned += 1;
      },
      norm(),
      { onSpawnBatch: () => { metrics += 1; } },
    );
    expect(result.outcome).toBe("completed");
    expect(result.attempted).toBe(0);
    expect(spawned).toBe(0);
    expect(metrics).toBe(0);
  });

  test("maxBatchSize caps growth: cap 3 over 15 items", async () => {
    const sizes: number[] = [];
    await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async () => {},
      norm({ maxBatchSize: 3 }),
      { onSpawnBatch: (m) => sizes.push(m.batchSize) },
    );
    expect(sizes).toEqual([1, 2, 3, 3, 3, 3]);
  });

  test("metric reports succeeded/failed and forwards taskGroupId", async () => {
    const seen: SpawnBatchMetric[] = [];
    await slowStartBatch(
      [1, 2],
      async () => {},
      norm({ initialBatchSize: 2 }),
      { taskGroupId: "tg-1", onSpawnBatch: (m) => seen.push(m) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      taskGroupId: "tg-1",
      batchIndex: 0,
      batchSize: 2,
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: FAIL — `slowStartBatch` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/slow-start-batch.ts`:

```ts
export interface SpawnBatchMetric {
  readonly taskGroupId?: string | undefined;
  readonly batchIndex: number;
  readonly batchSize: number; // == grove_spawn_batch_size
  readonly attempted: number; // items dispatched this batch (== batchSize)
  readonly succeeded: number;
  readonly failed: number;
}

export type SpawnBatchObserver = (metric: SpawnBatchMetric) => void;

export interface SlowStartHooks {
  readonly onSpawnBatch?: SpawnBatchObserver | undefined;
  readonly classify?: FailureClassifier | undefined;
  readonly taskGroupId?: string | undefined;
}

export type SlowStartOutcome = "completed" | "halted" | "throttled";

export interface SlowStartResult {
  readonly outcome: SlowStartOutcome;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failures: readonly ClassifiedFailure[];
  readonly retryAfterMs?: number | undefined;
}

export async function slowStartBatch<T>(
  items: readonly T[],
  spawn: (item: T, batchIndex: number) => Promise<void>,
  strategy: NormalizedBatchStrategy,
  hooks?: SlowStartHooks,
): Promise<SlowStartResult> {
  const classify = hooks?.classify ?? defaultFailureClassifier;
  let attempted = 0;
  let succeeded = 0;
  let offset = 0;
  let batchIndex = 0;
  let size = Math.min(strategy.initialBatchSize, items.length - offset);

  while (size > 0) {
    const batch = items.slice(offset, offset + size);
    const settled = await Promise.allSettled(
      // async wrapper converts a synchronous throw into a rejection
      batch.map(async (item) => spawn(item, batchIndex)),
    );
    attempted += size;

    const failures: ClassifiedFailure[] = [];
    let batchSucceeded = 0;
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        batchSucceeded += 1;
      } else {
        failures.push({
          index: offset + i,
          batchIndex,
          class: classify(res.reason),
          reason: failureReason(res.reason),
          error: res.reason,
        });
      }
    });
    succeeded += batchSucceeded;

    hooks?.onSpawnBatch?.({
      taskGroupId: hooks.taskGroupId,
      batchIndex,
      batchSize: size,
      attempted: size,
      succeeded: batchSucceeded,
      failed: failures.length,
    });

    if (failures.length > 0) {
      const anyTerminal = failures.some((f) => f.class === "task" || f.class === "admission");
      if (anyTerminal) {
        return { outcome: "halted", attempted, succeeded, failures };
      }
      return {
        outcome: "throttled",
        attempted,
        succeeded,
        failures,
        retryAfterMs: computeBackoffMs(0, strategy.backoff),
      };
    }

    offset += size;
    batchIndex += 1;
    const remaining = items.length - offset;
    size = Math.min(Math.floor(size * strategy.multiplier), strategy.maxBatchSize, remaining);
  }

  return { outcome: "completed", attempted, succeeded, failures: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS (Tasks 1–4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts
git commit --no-verify -m "feat(orchestration): #307 slowStartBatch runner + grove_spawn_batch_size metric"
```

---

### Task 5: slowStartBatch runner — failure paths

**Files:**
- Modify: `src/core/slow-start-batch.test.ts` (tests only; runner already complete)

- [ ] **Step 1: Write the failing test**

Append to `src/core/slow-start-batch.test.ts`:

```ts
describe("slowStartBatch — failure handling", () => {
  test("task failure in batch 1 halts; later batches never fire", async () => {
    const spawned: number[] = [];
    const result = await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async (item) => {
        spawned.push(item);
        if (item === 0) throw new Error("bad prompt");
      },
      norm(),
    );
    expect(result.outcome).toBe("halted");
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(spawned).toEqual([0]); // only batch 1 (size 1) ran
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ index: 0, batchIndex: 0, class: "task" });
  });

  test("RuntimeUnavailable in batch 1 throttles with backoff; no batch 2", async () => {
    const spawned: number[] = [];
    const result = await slowStartBatch(
      Array.from({ length: 15 }, (_, i) => i),
      async (item) => {
        spawned.push(item);
        if (item === 0) throw new RuntimeUnavailableError("runtime down");
      },
      norm(),
    );
    expect(result.outcome).toBe("throttled");
    expect(result.retryAfterMs).toBe(1000); // computeBackoffMs(0) === baseMs
    expect(spawned).toEqual([0]);
    expect(result.failures[0]).toMatchObject({ class: "backpressure" });
  });

  test("AdmissionReject halts and surfaces the actionable reason", async () => {
    const result = await slowStartBatch(
      [0],
      async () => {
        throw new AdmissionRejectError({
          ruleName: "max-fanout",
          ruleType: "concurrency",
          reason: "capacity exhausted",
        });
      },
      norm(),
    );
    expect(result.outcome).toBe("halted");
    expect(result.failures[0]).toMatchObject({ class: "admission", reason: "capacity exhausted" });
  });

  test("terminal wins on a mixed batch (backpressure + task)", async () => {
    const result = await slowStartBatch(
      [0, 1],
      async (item) => {
        if (item === 0) throw new RuntimeUnavailableError("runtime down");
        if (item === 1) throw new Error("bad prompt");
      },
      norm({ initialBatchSize: 2 }),
    );
    expect(result.outcome).toBe("halted"); // not throttled
    expect(result.failures).toHaveLength(2);
  });

  test("custom classifier overrides the default", async () => {
    const result = await slowStartBatch(
      [0],
      async () => {
        throw new Error("treat-me-as-backpressure");
      },
      norm(),
      { classify: () => "backpressure" },
    );
    expect(result.outcome).toBe("throttled");
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS — the runner from Task 4 already implements these paths. (This task is the failure-path test contract; if any test fails, fix the runner in `slow-start-batch.ts`, not the test.)

- [ ] **Step 3: Commit**

```bash
git add src/core/slow-start-batch.test.ts src/core/slow-start-batch.ts
git commit --no-verify -m "test(orchestration): #307 slowStartBatch halt/throttle/terminal-wins coverage"
```

---

### Task 6: Public exports + full verification

**Files:**
- Modify: `src/core/index.ts`
- Verify: whole-project typecheck, targeted lint, module tests

- [ ] **Step 1: Add the barrel exports**

In `src/core/index.ts`, add (near the other `./task-controller.js` / `./agent-task.js` exports, following the existing split between value exports and `export type`):

```ts
export {
  computeBackoffMs,
  defaultFailureClassifier,
  normalizeBatchStrategy,
  RuntimeUnavailableError,
  slowStartBatch,
} from "./slow-start-batch.js";
export type {
  BackoffStrategy,
  BatchStrategy,
  ClassifiedFailure,
  FailureClass,
  FailureClassifier,
  NormalizedBatchStrategy,
  SlowStartHooks,
  SlowStartOutcome,
  SlowStartResult,
  SpawnBatchMetric,
  SpawnBatchObserver,
} from "./slow-start-batch.js";
```

- [ ] **Step 2: Typecheck the whole project**

Run: `tsc --noEmit`
Expected: exit 0, no errors. (If `RuntimeUnavailableError` is reported as both a value and type export collision, keep it only in the value-export block above — it is a class.)

- [ ] **Step 3: Lint the touched files (targeted — do NOT run full-repo biome in a worktree)**

Run: `biome check --write src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts src/core/index.ts`
Expected: no remaining diagnostics (auto-fixes import ordering).

- [ ] **Step 4: Run the module tests once more**

Run: `bun test src/core/slow-start-batch.test.ts`
Expected: PASS — all tests across Tasks 1–5.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/slow-start-batch.ts src/core/slow-start-batch.test.ts
git commit --no-verify -m "feat(orchestration): #307 export slow-start batching primitive from core barrel"
```

---

## Self-Review

**Spec coverage:**
- `slowStartBatch` geometric runner + halt-on-first-batch-failure → Tasks 4, 5. ✓
- `BatchStrategy` / `normalizeBatchStrategy` (`spec.batchStrategy` home) → Task 1. ✓
- `computeBackoffMs` bounded backoff → Task 2. ✓
- Failure taxonomy `task|backpressure|admission` + injectable classifier + `RuntimeUnavailableError` → Tasks 3, 5. ✓
- `grove_spawn_batch_size` via `onSpawnBatch` observer → Task 4. ✓
- Acceptance: failure in first batch stops later batches → Task 5 test 1. ✓
- Acceptance: `RuntimeUnavailable` → throttled, no batch 2 → Task 5 test 2. ✓
- Acceptance: admission terminal → halt + reason → Task 5 test 3. ✓
- Out of scope (no TaskGroup entity, no live wiring, no exporter) → honored; only `src/core/slow-start-batch.ts` + barrel export touched. ✓

**Placeholder scan:** No TBD/TODO; every step has concrete code or an exact command. ✓

**Type consistency:** `NormalizedBatchStrategy.backoff` is `Required<BackoffStrategy>`, matching `computeBackoffMs`'s second param. `SlowStartResult.retryAfterMs` set only on `throttled`. `ClassifiedFailure` shape identical across definition (Task 3) and usage (Task 4). Metric field names (`batchSize`/`attempted`/`succeeded`/`failed`/`taskGroupId`/`batchIndex`) identical across Task 4 definition and Task 4/5 assertions. ✓
