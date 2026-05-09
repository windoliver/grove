# Claim Reconciliation Controller

**Issue:** [#268](https://github.com/windoliver/grove/issues/268)
**Depends on:** [#270](https://github.com/windoliver/grove/issues/270) claim spec/status split, [#271](https://github.com/windoliver/grove/issues/271) owner refs and finalizers
**Date:** 2026-05-09

---

## Goal

Add Kubernetes-style, level-triggered claim reconciliation as core infrastructure. The controller reads the current merged claim view, computes observed lifecycle transitions, and writes only the claim status subresource. It ships dark: available to tests and future runtime wiring, but not started automatically by grove-server in this change.

## Context

`origin/main` already has the split storage from #270:

- `ClaimStore.putClaimSpec(spec)` writes user-owned desired state and controls spec generation.
- `ClaimStore.getClaimView(claimId)` reads the merged `{ spec, status }` view.
- `ClaimStore.patchClaimStatus(claimId, patch)` writes controller-owned status fields.
- `ClaimStore.listEntities(query)` exposes claims through the Entity/watch shape.
- HTTP routes already reject spec fields on `PATCH /api/claims/:id/status` and require a controller token.

The existing `DefaultReconciler` is still sweep-oriented. It expires stale leases, deduplicates active claims, cleans terminal claims, and flags orphan workspaces. It is useful compatibility infrastructure, but it is not the #268 controller pattern: it has no keyed dirty set, no per-item retry state, no event-driven enqueue boundary, and no periodic resync queue.

## Non-Goals

- Do not start the controller automatically from `server/serve.ts` or `server/app.ts`.
- Do not introduce an operator framework, codegen, or generic CRD machinery.
- Do not replace existing claim APIs, CLI behavior, or legacy `Claim` snapshots.
- Do not mutate claim spec from the controller.
- Do not remove `DefaultReconciler`; it remains as sweep compatibility until runtime wiring can migrate safely.
- Do not implement platform adapters for spawning or killing sessions in this change. The controller prepares the status-write loop that adapters can plug into later.

## Architecture

```
Watch / direct event / resync tick
        |
        v
claimId-only enqueue
        |
        v
ClaimWorkQueue
  - dirty set dedupe
  - in-flight guard
  - per-key exponential backoff
  - global token bucket
        |
        v
ClaimReconciliationController.reconcileClaim(claimId)
        |
        v
ClaimStore.getClaimView(claimId)
        |
        v
compute status-only transition
        |
        v
ClaimStore.patchClaimStatus(claimId, patch)
```

The important boundary is the enqueue payload. Events enqueue only `claimId`; the reconciler never consumes event payloads. Every reconcile pass re-reads from `ClaimStore.getClaimView()` so duplicate, stale, or out-of-order events converge on the current state.

## Components

### `src/core/workqueue.ts`

Create a small keyed queue for controller work.

Public types:

```ts
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface WorkQueueOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly globalRatePerSec?: number;
  readonly globalBurst?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

export interface WorkItemResult {
  readonly key: string;
  readonly attempt: number;
}

export class KeyedWorkQueue {
  constructor(opts?: WorkQueueOptions)
  enqueue(key: string): void
  acknowledge(key: string): void
  retry(key: string): void
  take(): Promise<WorkItemResult>
  size(): number
  pendingKeys(): readonly string[]
  close(): void
}
```

Behavior:

- `enqueue(key)` adds the key to an in-memory dirty set. If the key is already pending or in flight, it marks the key dirty without adding a duplicate queue item.
- `take()` resolves with one key when available and marks it in flight.
- `acknowledge(key)` clears in-flight and retry state. If the key was marked dirty while in flight, it is re-enqueued once.
- `retry(key)` clears in-flight and schedules the key after exponential backoff. Defaults are `baseDelayMs = 5` and `maxDelayMs = 1_000_000`, matching the issue comment's 5ms to 1000s shape.
- Global pacing is implemented as an in-memory token bucket. Defaults are `globalRatePerSec = 50` and `globalBurst = 300`, matching the issue comment's suggested cap.
- `close()` rejects or drains pending `take()` waiters and cancels timers.

The queue is intentionally core-local and dependency-free. It matches the Kubernetes shape from the issue comment without introducing `p-queue` as a runtime dependency.

### `src/core/claim-controller.ts`

Create the controller as a composed core service.

Public types:

```ts
export interface ClaimReconciliationControllerOptions {
  readonly claimStore: ClaimStore;
  readonly resyncIntervalMs?: number;
  readonly workerCount?: number;
  readonly queue?: KeyedWorkQueue;
  readonly now?: () => number;
  readonly onError?: (error: unknown, claimId: string) => void;
  readonly onTransition?: (transition: ClaimStatusTransition) => void;
}

export interface ClaimStatusTransition {
  readonly claimId: string;
  readonly fromPhase: ClaimStatus;
  readonly toPhase: ClaimStatus;
  readonly reason: string;
  readonly observedGeneration: number;
}

export class ClaimReconciliationController {
  constructor(opts: ClaimReconciliationControllerOptions)
  enqueue(claimId: string): void
  enqueueFromEntity(entity: ClaimEntity): void
  resync(): Promise<number>
  reconcileClaim(claimId: string): Promise<ClaimStatusTransition | undefined>
  start(): void
  stop(): Promise<void>
}
```

Behavior:

- `enqueue(claimId)` is the informer/event boundary.
- `enqueueFromEntity(entity)` extracts `entity.id` and calls `enqueue`; it ignores the rest of the event payload.
- `resync()` calls `claimStore.listEntities()` and enqueues every claim id. The default resync interval is `30_000` ms, matching the issue comment.
- `reconcileClaim(claimId)` reads `claimStore.getClaimView(claimId)`. If the claim no longer exists, it returns `undefined`.
- The controller only calls `patchClaimStatus`; it never calls `putClaimSpec`, `createClaim`, `claimOrRenew`, `heartbeat`, `release`, or `complete`.
- `start()` starts worker loops and the resync timer. Because this feature ships dark, production code does not call it yet.
- `stop()` aborts workers, cancels the resync timer, closes the queue, and waits for in-flight workers to settle.

### Status Transitions

The first controller pass stays conservative and handles transitions that can be computed from split claim state alone:

1. **Observed generation catch-up**
   - If `status.observedGeneration !== spec.generation`, patch `observedGeneration` to `spec.generation`.
   - Preserve phase unless another transition applies in the same pass.

2. **Lease expiration**
   - If `status.phase === "active"` and `Date.parse(status.leaseExpiresAt) <= now()`, patch:
     - `phase: "expired"`
     - `observedGeneration: spec.generation`
     - `lastTransitionAt: nowIso`
     - `conditions`: include `Active=False` and `Expired=True` with reason `lease-expired`
   - This makes lease expiry a status reconciliation instead of relying only on an imperative sweep.

3. **Deletion/finalizer awareness**
   - If `spec.deletionTimestamp` is set and finalizers are still present, add or update a `Terminating=True` condition without deleting the row.
   - If `spec.deletionTimestamp` is absent, ensure the controller does not invent a terminating state.

4. **Terminal stability**
   - `released`, `expired`, and `completed` phases are terminal for this controller pass. The controller may catch up `observedGeneration` or conditions, but it does not move terminal claims back to active.

The controller does not infer `Succeeded`, `Failed`, or platform session state yet because Grove's current public `ClaimStatus` is `active | released | expired | completed`. Platform-backed session phases can be introduced later as additive split-status fields or a broader status enum migration.

### Conditions

Condition writes use the existing `Condition` shape from `src/core/entity.ts`. The controller owns only the status subresource condition array for claim lifecycle conditions it writes:

- `ObservedGenerationCurrent`
- `Active`
- `Expired`
- `Terminating`

Each condition uses:

- `observedGeneration: spec.generation`
- `lastTransitionTime: nowIso` when the condition's status changes
- existing `lastTransitionTime` when the condition remains unchanged
- `reason` as a stable machine string such as `reconciled`, `lease-expired`, or `deletion-requested`
- `message` as a short human-readable detail

The condition merge is type-specific: updating `Expired` must not delete unrelated future condition types written by other controllers.

### Event Integration

This design does not wire the controller into server startup. It does define the integration seam:

- Claim watch events call `controller.enqueueFromEntity(entity)`.
- Direct claim writes may call `controller.enqueue(claimId)` after `watchHub.recordWrite`.
- The controller's periodic resync covers missed watch events and process restarts.

When runtime wiring is added later, it should use existing `WatchHub` / `LocalWatchClient` / `Informer` infrastructure rather than a parallel event bus.

## Error Handling

- A failed reconcile calls `queue.retry(claimId)` and invokes `onError(error, claimId)` if provided.
- Backoff is per claim id and resets only after a successful reconcile.
- Missing claims are treated as successful no-ops; they are acknowledged, not retried.
- Invalid timestamps are reported through `onError` and retried with backoff, because silently treating malformed status as active could hide data corruption.
- `patchClaimStatus` conflicts are retried by re-reading on the next pass. The controller does not reuse stale views after a failed write.

## Testing

Add focused Bun tests:

- `src/core/workqueue.test.ts`
  - dedupes duplicate pending keys
  - re-enqueues once when a key becomes dirty while in flight
  - retries with exponential per-key backoff
  - limits dispatch through the global token bucket
  - clears retry state on acknowledge
  - closes timers and waiters

- `src/core/claim-controller.test.ts`
  - `enqueueFromEntity` ignores payload fields and reconciles by re-reading the store
  - expired active claim is patched through `patchClaimStatus`
  - terminal claim is not moved back to active
  - observed generation catches up without spec mutation
  - resync enqueues every claim entity
  - failed reconcile retries and later succeeds from a fresh store read
  - controller never calls spec mutation methods in the fake store

Run targeted tests with:

```bash
bun test src/core/workqueue.test.ts src/core/claim-controller.test.ts
```

Then run broader checks:

```bash
bun run typecheck
bun test src/core/reconciler.test.ts src/core/claim-store.conformance.ts src/local/reconciler.test.ts
```

## Rollout

1. Land dark core infrastructure and tests.
2. Add server wiring in a follow-up issue once the runtime owner decides whether the controller should run in local server mode, MCP HTTP mode, or both.
3. Migrate parts of `DefaultReconciler` into controller strategies only after server wiring proves stable.

## Risks

- **Duplicate lifecycle systems:** `DefaultReconciler` and the new controller can both expire stale claims if both are wired later. Runtime wiring must choose one owner for lease-expiry writes or make the operations idempotent by design.
- **Condition ownership collisions:** Future controllers may write claim conditions. The merge helper must preserve unknown condition types.
- **Queue lifecycle leaks:** Timers and pending workers must stop cleanly in tests and server shutdown. The controller exposes `stop()` and the queue exposes `close()` to make this explicit.
- **Status enum mismatch:** The issue sketch mentions `Pending`, `Running`, `Succeeded`, `Failed`, and `Orphaned`, but Grove currently exposes `active`, `released`, `expired`, and `completed`. This design keeps the current enum and adds controller behavior around it instead of forcing a public wire-format migration into #268.
