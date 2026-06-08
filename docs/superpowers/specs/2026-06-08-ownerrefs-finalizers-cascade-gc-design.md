# Design: OwnerRefs + Finalizers + Cascade GC (#306)

**Issue**: [#306](https://github.com/windoliver/grove/issues/306) — D5 of Epic D (#285, Orchestration: Controllers + Scheduler + GC)
**Depends on**: #287 (Entity envelope, CLOSED), #299 (Task controller, CLOSED)
**Reference**: `kubernetes/pkg/controller/garbagecollector/garbagecollector.go`
**Date**: 2026-06-08

## Goal

A Kubernetes-style garbage collector for Grove's entity hierarchy: owner references
link parents to children, finalizers gate hard deletion until preconditions are met,
and a cascade policy (`Foreground` / `Background` / `Orphan`) decides what happens to
children when an owner is deleted.

## Scope

This issue builds the **GC mechanism** and proves it end-to-end on the entity types
that already exist (`AgentTask`, `AgentSession`), plus a minimal `TaskGroup` owner.

### In scope (real, tested)

1. `OwnerRef` extension: `controller?: boolean` flag + new kinds `taskGroup` / `agentTask`.
2. Finalizer + propagation-finalizer + `CascadePolicy` constants.
3. `owner-graph.ts` — pure cascade/reap decision core (no I/O).
4. `garbage-collector.ts` — reconcile loop + segregated `GcStore` interface.
5. In-memory `GcStore` implementation + conformance covering all acceptance criteria.
6. `AgentTask` real-store spec-lifecycle mutators (Sqlite) + an `AgentTaskGcStore` adapter,
   with an integration test proving `pending-review` blocks reap and cascade marks real rows.
7. Minimal `TaskGroup` model + in-memory store as the top-level owner.

### Deferred to follow-up issues (mechanism ready, drops in trivially)

- `MergeTask` entity + store + `grove.dev/pending-merge` finalizer.
- `TaskGroup` persistence in SQLite / Nexus.
- Live server-side GC activation in `serve.ts`.
- TUI surfacing of the `Terminating` condition.

The finalizer-blocking mechanism is fully generic. The acceptance line "MergeTask with
`pending-merge` finalizer cannot be deleted until finalizer removed" is proven by the
identical `AgentTask` + `pending-review` path; `MergeTask` is then one constant + one
finalizer assignment away.

## Background — current state

- **Entity envelope** (`src/core/entity.ts`) already carries `metadata.ownerRefs`,
  `metadata.finalizers`, `metadata.deletionTimestamp`.
- **`OwnerRef`** (`src/core/lifecycle-metadata.ts`) is today `{ kind: "session" | "claim", id, uid }`
  — no `controller` flag, no task kinds.
- **`claim-controller.ts`** already reconciles `deletionTimestamp` + finalizers into a
  `Terminating` condition. This is the idiom the GC loop mirrors.
- **`SqliteAgentTaskStore`** (`src/local/sqlite-store.ts`): the `agent_task_spec` table
  already has `owner_ref_json`, `finalizers_json`, `deletion_timestamp` columns, and
  `agent_task_status` has `FOREIGN KEY (id) REFERENCES agent_task_spec(id) ON DELETE CASCADE`.
  So lifecycle mutators + a reap need **no schema migration**.
- AgentTask's only concrete store is server-side `SqliteAgentTaskStore` (TUI/CLI reach it
  over HTTP routes), so the GC is a **server-side controller**, exactly like `task-controller`.
- No `TaskGroup` or `MergeTask` concept exists anywhere yet.

## Architecture

Faithful to the Kubernetes GC split: a **GC controller** that walks owner references and
propagates deletion per cascade policy, and **finalizers** that block hard deletion until
the responsible party clears its precondition. Cascade policy is encoded as a propagation
finalizer placed on the *owner* at delete time (k8s records `foregroundDeletion` / `orphan`
the same way), so the policy survives restarts and is reconstructable from store state.

### A. Data model — `src/core/lifecycle-metadata.ts`

```ts
export type OwnerKind = "session" | "claim" | "taskGroup" | "agentTask";
export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  readonly controller?: boolean | undefined;   // k8s controller:true — the managing owner
}

export const KindFinalizer = {
  PendingReview: "grove.dev/pending-review",   // on AgentTask
  PendingMerge:  "grove.dev/pending-merge",    // on MergeTask (defined now, applied in follow-up)
} as const;

export const PropagationFinalizer = {           // placed on the OWNER at delete time
  Foreground: "grove.dev/foreground-deletion",
  Orphan:     "grove.dev/orphan",
} as const;

export type CascadePolicy = "Foreground" | "Background" | "Orphan";
```

- `ownerRefsEqual` stays UID-based — the `controller` flag is metadata, not identity.
- New finalizers use the `grove.dev/` prefix per the issue. Existing `grove.io/*` session
  finalizers are untouched (documented divergence; not unified in this issue).
- Simplification vs k8s: every `controller` ownerRef is treated as blocking under
  Foreground (k8s gates on a per-ref `blockOwnerDeletion`). The flag can be added later
  without changing the plan shape.

### B. Pure core — `src/core/owner-graph.ts`

No async, no store access — pure functions over snapshots, so cascade logic is
adversarially unit-testable in isolation.

```ts
interface GcNode {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  readonly ownerRefs: readonly OwnerRef[];
  readonly finalizers: readonly string[];
  readonly deletionTimestamp?: string | undefined;
}

interface GcRef { readonly kind: OwnerKind; readonly id: string; }

type GcAction =
  | { readonly kind: "delete-child";    readonly ref: GcRef }                         // set child.deletionTimestamp
  | { readonly kind: "orphan-child";    readonly ref: GcRef; readonly ownerUid: string } // strip controller ownerRef
  | { readonly kind: "remove-finalizer"; readonly ref: GcRef; readonly finalizer: string } // drop owner propagation finalizer
  | { readonly kind: "reap";            readonly ref: GcRef };                         // hard-delete (finalizers empty)

// Derived from which propagation finalizer the owner carries.
function policyOf(owner: GcNode): CascadePolicy;

// One idempotent reconcile step for an owner that has a deletionTimestamp.
function planOwnerDeletion(owner: GcNode, children: readonly GcNode[]): readonly GcAction[];

// GC backstop: a child whose controller owner UID no longer exists.
function planDanglingChild(child: GcNode, ownerExists: boolean): readonly GcAction[];
```

Policy semantics:

- **Foreground**: emit `delete-child` for every blocking child not yet marked. Owner stays
  `Terminating`. Once all blocking children are gone, emit `remove-finalizer(Foreground)`,
  then (finalizers empty) `reap(owner)`.
- **Background**: `reap(owner)` immediately (no blocking propagation finalizer present);
  children are deleted asynchronously by their own dangling-child reconciles.
- **Orphan**: emit `orphan-child` for each child still carrying the owner's controller ref.
  Once none remain, `remove-finalizer(Orphan)`, then `reap(owner)`.

`reap` is **only** emitted when `deletionTimestamp` is set **and** `finalizers` is empty —
so `pending-review` / `pending-merge` block it regardless of cascade progress. All plans are
idempotent: re-running against a converged snapshot yields `[]`.

### C. GC loop — `src/core/garbage-collector.ts`

Same skeleton as `task-controller` / `claim-controller`: `KeyedWorkQueue`, `resync()`,
`workerLoop`, CAS writes via `withIfMatch`, `onError` / `onTransition` hooks,
`resyncIntervalMs` / `workerCount` validation. GC depends on a **segregated** interface,
not the full `AgentTaskStore`:

```ts
interface GcStore {
  listPendingDeletion(): Promise<readonly GcNode[]>;          // deletionTimestamp set
  listOwnedBy(ownerUid: string): Promise<readonly GcNode[]>;
  getNode(ref: GcRef): Promise<GcNode | undefined>;
  setDeletionTimestamp(ref: GcRef, ts: string, opts?: CasOpts): Promise<void>;
  removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts): Promise<void>;
  removeFinalizer(ref: GcRef, finalizer: string, opts?: CasOpts): Promise<void>;
  reap(ref: GcRef, opts?: CasOpts): Promise<void>;            // asserts finalizers empty
}
```

`reconcileNode(ref)`:
1. Read the node; if missing, done.
2. If it has a `deletionTimestamp`: read children via `listOwnedBy(uid)`, run
   `planOwnerDeletion`, execute each action through CAS.
3. Else if it is a child whose controller owner is gone: run `planDanglingChild` → delete.
4. Set/refresh a `Terminating` condition (reusing the claim-controller condition shape)
   where applicable.

`resync()` enqueues every pending-deletion node plus children of pending-deletion owners, so
a controller killed mid-cascade converges on the next resync.

### D. Store integration

- **AgentTask (real):** add to `AgentTaskStore` + `SqliteAgentTaskStore`:
  `setAgentTaskDeletion`, `removeAgentTaskFinalizer`, `removeAgentTaskOwnerRef`,
  `reapAgentTask` (hard-delete the spec row; status drops via the existing FK cascade).
  No schema migration. `src/core/agent-task-gc-store.ts` adapts these to `GcStore`.
- **TaskGroup (minimal):** `src/core/task-group.ts` — a `TaskGroup` type +
  in-memory store holding `{ id, uid, finalizers, deletionTimestamp }`, enough to own
  AgentTasks and be deleted. A combined `GcStore` spans TaskGroup (owner) + AgentTask (children).

### E. Error handling & concurrency

- Every mutating action is a CAS write (`withIfMatch`); on RV mismatch the work item is
  retried (same `KeyedWorkQueue.retry` path as the existing controllers).
- A vanished node mid-cascade is a no-op (idempotent plans tolerate partial progress).
- `reap` re-asserts finalizers-empty at the store layer; a concurrent finalizer add
  between plan and execute fails CAS and re-reconciles rather than deleting a still-gated row.
- `onError` swallows callback throws (mirrors existing controllers).

### F. Testing

- `owner-graph.test.ts` — pure: all three cascade policies; dangling-ref detection; reap
  gating by finalizer; 3-level `TaskGroup → AgentTask → AgentSession`; idempotency
  (converged snapshot → `[]`).
- `garbage-collector.test.ts` — loop over in-memory `GcStore`:
  - **Delete TaskGroup → children cascade** (Foreground marks-then-reaps; Background reaps
    owner first then children; **Orphan preserves children and strips the controller ownerRef**).
  - **Finalizer blocks reap** until removed (`pending-review`).
  - **Kill mid-cascade → converges** on next `resync()`.
  - **CAS-conflict retry**.
- AgentTask integration over the real `SqliteAgentTaskStore`: `pending-review` blocks
  `reapAgentTask`; cascade marks real rows; reap drops spec + status (FK cascade).

### G. Wiring & files

**New:** `src/core/owner-graph.ts` (+test), `src/core/garbage-collector.ts` (+test),
`src/core/task-group.ts`, `src/core/agent-task-gc-store.ts` (+test),
`src/server/garbage-collector-wiring.ts` (+test, mirrors `task-controller-wiring.ts`).

**Edited:** `src/core/lifecycle-metadata.ts`, `src/core/store.ts`, `src/local/sqlite-store.ts`,
`src/core/index.ts`.

Live `serve.ts` activation is deferred together with TaskGroup persistence.

## Acceptance criteria mapping

| Acceptance (issue #306) | Covered by |
| --- | --- |
| Delete TaskGroup → children cascade | D + E (garbage-collector.test: Foreground/Background) |
| MergeTask `pending-merge` finalizer blocks deletion until removed | Generic finalizer gate proven via AgentTask `pending-review` (E); `MergeTask`/`pending-merge` = documented follow-up |
| Orphan mode preserves children on parent delete | owner-graph + garbage-collector.test (Orphan path) |

## Out of scope / follow-ups

- `MergeTask` entity, store, and `grove.dev/pending-merge` wiring.
- `TaskGroup` persistence (SQLite/Nexus) and live server-side GC activation.
- Per-ref `blockOwnerDeletion` granularity (all controller refs block under Foreground for now).
- TUI rendering of `Terminating`.
- Unifying the legacy `grove.io/*` session finalizer prefix with `grove.dev/*`.
