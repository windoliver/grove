# D6: Slow-start batching for fan-out spawns — Design

**Issue**: #307 (Epic D — Orchestration, parent #285)
**Depends on**: #299 (Task controller, closed)
**Reference**: `kubernetes/pkg/controller/replicaset/replica_set.go` `slowStartBatch`
**Date**: 2026-06-08

## Problem

When a parent fans out N parallel children, spawning all N at once amplifies
transient failures into spawn storms: a bad prompt, an unavailable runtime, or
an admission rejection hits all N before anyone notices. Kubernetes solves this
in the ReplicaSet controller with `slowStartBatch` — create children in
geometrically growing batches (1 → 2 → 4 → 8 …), halting the moment a batch sees
a failure, so a systemic problem stops after the first small batch instead of
after N.

Grove needs the same primitive for agent fan-out, plus a failure taxonomy:
not every failure should halt. A task/prompt failure is the spawner's fault and
should halt and wait for a human. A runtime/backpressure failure is transient
and should pause-and-requeue with bounded backoff. An admission rejection is
terminal and should halt with an actionable reason.

## Scope

A **standalone, pure primitive** — no new entity, no live wiring. This matches
how the rest of Epic D landed (`#297` spec/status split, `#299` task controller):
each issue ships a focused, unit-tested module plus a design doc. The fan-out
*driver* that calls this primitive is owned by later issues (`#306` ownerRefs +
cascade GC, `#358` plan/shard/merge, `#336` runtime preflight admission gate,
`#337` backpressure conditions + queue-depth metrics).

### In scope
- `slowStartBatch` — the geometric-batch runner with halt-on-first-failure.
- `BatchStrategy` config type (canonical home for `spec.batchStrategy`) +
  `normalizeBatchStrategy` validation + `computeBackoffMs` bounded-backoff helper.
- Failure classification: `task` | `backpressure` | `admission` with an
  injectable classifier and a sensible default.
- `grove_spawn_batch_size` metric surfaced via an `onSpawnBatch` observer
  callback (the codebase has no Prometheus/OTEL registry; emission mirrors
  `TaskController`'s existing `onTransition`/`onError` callback pattern).
- Full unit-test coverage.

### Explicitly out of scope (YAGNI / deferred to owning issues)
- No `TaskGroup` entity (spec/status/store/controller).
- No `OwnerKind: "task"` extension or cascade-GC changes (#306).
- No live spawn-path edits to `TaskController` or `SessionOrchestrator`.
- No real metrics exporter / `/metrics` endpoint (#337).
- No requeue/backoff *scheduling* loop — the primitive returns the
  classification + backoff hint; the future controller does the requeuing.

## Module layout

Single cohesive module, since `BatchStrategy` is the configuration for
`slowStartBatch` and the two are tightly coupled:

- `src/core/slow-start-batch.ts` — algorithm, types, classifier, helpers, errors.
- `src/core/slow-start-batch.test.ts` — unit tests.
- Re-export public surface from `src/core/index.ts`.

## Public surface

```ts
// ---- configuration (canonical home for spec.batchStrategy) ----
export interface BatchStrategy {
  readonly initialBatchSize?: number;   // default 1
  readonly multiplier?: number;         // default 2
  readonly maxBatchSize?: number;       // default unbounded (capped by remaining)
  readonly backoff?: BackoffStrategy;
}
export interface BackoffStrategy {
  readonly baseMs?: number;             // default 1000
  readonly multiplier?: number;         // default 2
  readonly maxMs?: number;              // default 30000
}
export interface NormalizedBatchStrategy {
  readonly initialBatchSize: number;
  readonly multiplier: number;
  readonly maxBatchSize: number;        // Number.POSITIVE_INFINITY when unbounded
  readonly backoff: Required<BackoffStrategy>;
}

// Applies defaults; throws RangeError on invalid input
// (matching validateResyncIntervalMs / validateWorkerCount style).
export function normalizeBatchStrategy(input?: BatchStrategy): NormalizedBatchStrategy;

// Bounded exponential backoff for the Nth requeue attempt (attempt >= 0).
// computeBackoffMs(0) === baseMs; grows × multiplier, clamped to maxMs.
export function computeBackoffMs(attempt: number, backoff: Required<BackoffStrategy>): number;

// ---- failure classification ----
export type FailureClass = "task" | "backpressure" | "admission";
//  task         → halted    (report, wait for user)
//  backpressure → throttled (pause + requeue with bounded backoff)
//  admission    → halted    (terminal; surface actionable reason)

export interface ClassifiedFailure {
  readonly index: number;            // index into the input items array
  readonly batchIndex: number;       // which batch (0-based) the item was in
  readonly class: FailureClass;
  readonly reason: string;           // actionable message (esp. admission)
  readonly error: unknown;           // original thrown value
}

export type FailureClassifier = (error: unknown) => FailureClass;

// Recoverable runtime/backpressure signal. Callers throw this from `spawn`
// to mark a failure as transient. (AdmissionRejectError from
// src/core/admission/errors.ts is recognized as "admission".)
export class RuntimeUnavailableError extends GroveError {
  constructor(message: string, options?: { reason?: string });
}

// Default classifier:
//   AdmissionRejectError      -> "admission"
//   RuntimeUnavailableError   -> "backpressure"
//   anything else             -> "task"
export const defaultFailureClassifier: FailureClassifier;

// ---- metric observer ----
export interface SpawnBatchMetric {
  readonly taskGroupId?: string;     // satisfies "per TaskGroup" (caller-supplied)
  readonly batchIndex: number;       // 0-based
  readonly batchSize: number;        // == grove_spawn_batch_size
  readonly attempted: number;        // == batchSize (items dispatched this batch)
  readonly succeeded: number;
  readonly failed: number;
}
export type SpawnBatchObserver = (metric: SpawnBatchMetric) => void;

// ---- the runner ----
export interface SlowStartHooks {
  readonly onSpawnBatch?: SpawnBatchObserver | undefined;
  readonly classify?: FailureClassifier | undefined;   // default: defaultFailureClassifier
  readonly taskGroupId?: string | undefined;           // forwarded into the metric
}

export type SlowStartOutcome = "completed" | "halted" | "throttled";

export interface SlowStartResult {
  readonly outcome: SlowStartOutcome;
  readonly attempted: number;        // total items dispatched across all batches run
  readonly succeeded: number;        // total successful spawns
  readonly failures: readonly ClassifiedFailure[];  // [] when completed
  readonly retryAfterMs?: number;    // present iff outcome === "throttled"
}

export async function slowStartBatch<T>(
  items: readonly T[],
  spawn: (item: T, batchIndex: number) => Promise<void>,
  strategy: NormalizedBatchStrategy,
  hooks?: SlowStartHooks,
): Promise<SlowStartResult>;
```

## Algorithm

```
remaining = items
batchIndex = 0
size = min(initialBatchSize, remaining.length)
while size > 0:
    batch = next `size` items
    results = await Promise.allSettled(batch.map((it, i) => spawn(it, batchIndex)))
    succeeded = count fulfilled
    failures  = rejected → classify(error) → ClassifiedFailure
    onSpawnBatch({ taskGroupId, batchIndex, batchSize: size,
                   attempted: size, succeeded, failed: failures.length })
    if failures non-empty:
        if any failure.class in {task, admission}:   # terminal wins
            return { outcome: "halted", failures, attempted, succeeded }
        else:                                         # all backpressure
            return { outcome: "throttled", failures, attempted, succeeded,
                     retryAfterMs: computeBackoffMs(0, backoff) }
    remaining -= batch
    batchIndex += 1
    size = min(size * multiplier, maxBatchSize, remaining.length)
return { outcome: "completed", failures: [], attempted, succeeded }
```

Notes:
- The doubling stops short on the last partial batch (`min(..., remaining.length)`),
  exactly like k8s — e.g. 15 items → batches of 1, 2, 4, 8.
- `attempted`/`succeeded` accumulate only over batches that actually ran; batches
  after a halt/throttle never dispatch (acceptance #1).
- `retryAfterMs` uses `attempt = 0` here because the primitive is single-shot.
  The requeuing controller owns the attempt counter and calls `computeBackoffMs`
  with the live attempt number on each requeue to get the escalating delay.
- `spawn` rejections are the only failure signal; the runner never throws for a
  spawn failure (it classifies and returns). It *does* propagate a programming
  error thrown synchronously by a hook, unchanged.

## Failure-classification rationale

Injectable classifier (not hard-coded `instanceof`) so:
- The primitive stays decoupled from concrete error types beyond the default.
- The future controller can supply a richer taxonomy (e.g. distinguishing
  provider-pressure from local-capacity backpressure) without forking the runner.

The default recognizes the two error types that already mean something in the
codebase or that this module introduces:
- `AdmissionRejectError` (existing, `src/core/admission/errors.ts`) → `admission`
  (terminal; its `reason` is surfaced into `ClassifiedFailure.reason`).
- `RuntimeUnavailableError` (new, exported here) → `backpressure`.
- Everything else → `task` (halt; the conservative default — an unknown failure
  is treated as the spawner's fault, not silently retried).

## Acceptance mapping

| Acceptance criterion | Covered by |
| --- | --- |
| Inject failure in first batch → subsequent batches don't fire | `task` failure in batch 1 → `halted`, only 1 item attempted |
| Metric `grove_spawn_batch_size` exposed per TaskGroup | `onSpawnBatch` emits `batchSize` + `taskGroupId` each batch |
| Configurable via spec | `BatchStrategy` type + `normalizeBatchStrategy` (canonical `spec.batchStrategy` home) |
| (comment) `RuntimeUnavailable` in batch-1 → no batch-2, recoverable throttled state, resumes on recovery | `backpressure` → `throttled` + `retryAfterMs`; batch 2 never dispatched; caller requeues |
| (comment) Admission reject (terminal) → halt + actionable reason | `admission` → `halted`; `ClassifiedFailure.reason` carries the rule reason |

## Testing

`src/core/slow-start-batch.test.ts`:

- **Doubling sequence**: 15 items, fake `spawn` records the item set per
  `batchIndex` → assert batch sizes `[1, 2, 4, 8]` and full coverage on success.
- **Halt on batch-1 task failure**: `spawn` throws plain error for one item in
  batch 1 → `outcome: "halted"`, `attempted === 1`, no further `spawn` calls.
- **Backpressure throttle**: `spawn` throws `RuntimeUnavailableError` in batch 1
  → `outcome: "throttled"`, `retryAfterMs === baseMs`, batch 2 never dispatched.
- **Admission halt**: `spawn` throws `AdmissionRejectError` → `outcome: "halted"`,
  failure `class === "admission"`, `reason` surfaced.
- **Terminal wins on mixed batch**: one `RuntimeUnavailableError` + one plain
  error in the same batch → `outcome: "halted"` (not throttled).
- **Metric emission**: `onSpawnBatch` called once per batch with correct
  `batchSize`/`succeeded`/`failed`; `taskGroupId` forwarded.
- **`normalizeBatchStrategy`**: defaults applied for empty input; `RangeError`
  for `initialBatchSize < 1`, non-integer sizes, `multiplier < 1`,
  `maxBatchSize < initialBatchSize`, negative backoff fields.
- **`maxBatchSize` cap**: growth clamped (e.g. cap 3 over 15 items → `[1,2,3,3,3,3]`).
- **`computeBackoffMs`**: `attempt 0 === baseMs`; geometric growth; clamped to
  `maxMs`; `attempt` guarded against negatives.
- **Empty input**: `items: []` → `outcome: "completed"`, no `spawn`/metric calls.

## Risks / open questions

- **`grove_*` naming**: no metrics registry exists yet, so the name lives only in
  the `SpawnBatchMetric` doc contract until `#337` binds it to an exporter. The
  callback shape is chosen so `#337` can map it directly.
- **Backoff statefulness**: bounded exponential backoff across requeues requires
  an attempt counter the primitive cannot hold (it is single-shot). Resolved by
  exposing `computeBackoffMs(attempt, …)` for the controller to drive.
