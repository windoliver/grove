# OwnerRefs + Finalizers + Cascade GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kubernetes-style garbage collector to Grove — owner references link parents to children, finalizers gate hard deletion, and a cascade policy (`Foreground`/`Background`/`Orphan`) decides what happens to children when an owner is deleted.

**Architecture:** A pure decision core (`owner-graph.ts`, no I/O) computes one idempotent reconcile step per node; a `GarbageCollector` reconcile loop (same skeleton as `task-controller.ts`/`claim-controller.ts`) drives those decisions against a segregated `GcStore` via CAS writes. Cascade policy is encoded as a propagation finalizer placed on the owner at delete time, so it survives restarts. The mechanism is proven end-to-end against an in-memory `GcStore` and against the real `SqliteAgentTaskStore`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `bun:test`, Bun SQLite (`bun:sqlite`). Colocated `*.test.ts`. Run tests with `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-08-ownerrefs-finalizers-cascade-gc-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/lifecycle-metadata.ts` (edit) | `OwnerRef.controller` flag + `taskGroup`/`agentTask` kinds; `KindFinalizer`, `PropagationFinalizer`, `CascadePolicy` constants |
| `src/core/owner-graph.ts` (new) | Pure types (`GcNode`, `GcRef`, `GcAction`) + pure decision functions (`policyOf`, `planOwnerDeletion`, `planDanglingChild`) |
| `src/core/garbage-collector.ts` (new) | `GcStore` interface + `GarbageCollector` reconcile loop |
| `src/core/in-memory-gc-store.ts` (new) | In-memory `GcStore` (all kinds) for tests/fixtures |
| `src/core/store.ts` (edit) | Add lifecycle-mutator methods to `AgentTaskStore` |
| `src/local/sqlite-store.ts` (edit) | Implement the new mutators on `SqliteAgentTaskStore` |
| `src/core/agent-task-gc-store.ts` (new) | `AgentTaskGcStore` (real-store adapter) + `CompositeGcStore` (routes by kind) |
| `src/server/garbage-collector-wiring.ts` (new) | Construct a `GarbageCollector`, gated by env (mirrors `task-controller-wiring.ts`) |
| `src/core/index.ts` (edit) | Re-export the new public symbols |

**Queue key encoding:** the `KeyedWorkQueue` keys by `string`, but a node's identity is `(kind, id)`. Encode keys as `` `${kind}:${id}` `` and parse back. Helpers `gcKey(ref)` / `parseGcKey(key)` live in `garbage-collector.ts`.

---

## Task 1: Extend OwnerRef + finalizer/policy constants

**Files:**
- Modify: `src/core/lifecycle-metadata.ts`
- Test: `src/core/lifecycle-metadata.test.ts` (append cases)

- [ ] **Step 1: Write the failing test**

Append to `src/core/lifecycle-metadata.test.ts` (inside the existing top-level `describe("lifecycle metadata", ...)` block, before its closing `});`):

```ts
  test("OwnerRef carries an optional controller flag without affecting identity", () => {
    const a: OwnerRef = { kind: "taskGroup", id: "tg-1", uid: "uid-1", controller: true };
    const b: OwnerRef = { kind: "taskGroup", id: "tg-1", uid: "uid-1" };
    // controller is metadata, not identity — equality is UID-based.
    expect(ownerRefsEqual(a, b)).toBe(true);
  });

  test("new owner kinds are assignable", () => {
    const refs: OwnerRef[] = [
      { kind: "session", id: "s", uid: "u" },
      { kind: "claim", id: "c", uid: "u" },
      { kind: "taskGroup", id: "tg", uid: "u" },
      { kind: "agentTask", id: "at", uid: "u" },
    ];
    expect(refs).toHaveLength(4);
  });

  test("finalizer namespaces are stable", () => {
    expect(KindFinalizer.PendingReview).toBe("grove.dev/pending-review");
    expect(KindFinalizer.PendingMerge).toBe("grove.dev/pending-merge");
    expect(PropagationFinalizer.Foreground).toBe("grove.dev/foreground-deletion");
    expect(PropagationFinalizer.Orphan).toBe("grove.dev/orphan");
  });

  test("cascade policy values", () => {
    const policies: CascadePolicy[] = ["Foreground", "Background", "Orphan"];
    expect(policies).toContain("Background");
  });
```

Update the import at the top of the test file to add the new symbols:

```ts
import {
  appendDeletionAudit,
  type CascadePolicy,
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  KindFinalizer,
  type OwnerRef,
  ownerRefsEqual,
  PropagationFinalizer,
} from "./lifecycle-metadata.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/lifecycle-metadata.test.ts`
Expected: FAIL — `KindFinalizer`/`PropagationFinalizer`/`CascadePolicy` not exported; `"taskGroup"` not assignable to `OwnerKind`.

- [ ] **Step 3: Implement the changes**

Edit `src/core/lifecycle-metadata.ts`. Replace the `OwnerKind`/`OwnerRef` declarations at the top:

```ts
export type OwnerKind = "session" | "claim" | "taskGroup" | "agentTask";

export interface OwnerRef {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  /** k8s `controller: true` — the single managing owner. Metadata, not identity. */
  readonly controller?: boolean | undefined;
}
```

Then, immediately after the existing `Finalizer` block (after the `DEFAULT_SESSION_FINALIZERS` const), add:

```ts
/**
 * Per-kind finalizers (Epic D #306). Use the `grove.dev/` namespace, distinct
 * from the legacy `grove.io/*` session finalizers above (not unified here).
 */
export const KindFinalizer = {
  /** On AgentTask — blocks reap until review completes. */
  PendingReview: "grove.dev/pending-review",
  /** On MergeTask — blocks reap until the merge lands (defined now, applied in a follow-up). */
  PendingMerge: "grove.dev/pending-merge",
} as const;
export type KindFinalizer = (typeof KindFinalizer)[keyof typeof KindFinalizer];

/**
 * Propagation finalizers placed on the OWNER at delete time to encode the
 * cascade policy (mirrors k8s `foregroundDeletion`/`orphan`). Background uses
 * no propagation finalizer. Reconstructable from store state after a restart.
 */
export const PropagationFinalizer = {
  Foreground: "grove.dev/foreground-deletion",
  Orphan: "grove.dev/orphan",
} as const;
export type PropagationFinalizer =
  (typeof PropagationFinalizer)[keyof typeof PropagationFinalizer];

export type CascadePolicy = "Foreground" | "Background" | "Orphan";
```

`ownerRefsEqual` already compares only `kind`/`id`/`uid`, so it stays correct with the new optional `controller` field — no change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/lifecycle-metadata.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/lifecycle-metadata.ts src/core/lifecycle-metadata.test.ts
git commit --no-verify -m "feat(#306): OwnerRef.controller + grove.dev finalizer/cascade constants"
```

---

## Task 2: Pure owner-graph decision core

**Files:**
- Create: `src/core/owner-graph.ts`
- Test: `src/core/owner-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/owner-graph.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PropagationFinalizer } from "./lifecycle-metadata.js";
import {
  type GcNode,
  planDanglingChild,
  planOwnerDeletion,
  policyOf,
} from "./owner-graph.js";

function node(over: Partial<GcNode> & Pick<GcNode, "kind" | "id" | "uid">): GcNode {
  return {
    resourceVersion: "1",
    ownerRefs: [],
    finalizers: [],
    ...over,
  };
}

function child(id: string, ownerUid: string, over: Partial<GcNode> = {}): GcNode {
  return node({
    kind: "agentTask",
    id,
    uid: `uid-${id}`,
    ownerRefs: [{ kind: "taskGroup", id: "tg", uid: ownerUid, controller: true }],
    ...over,
  });
}

describe("policyOf", () => {
  test("Foreground / Orphan / Background derived from owner finalizers", () => {
    expect(policyOf(node({ kind: "taskGroup", id: "tg", uid: "u" }))).toBe("Background");
    expect(
      policyOf(node({ kind: "taskGroup", id: "tg", uid: "u", finalizers: [PropagationFinalizer.Foreground] })),
    ).toBe("Foreground");
    expect(
      policyOf(node({ kind: "taskGroup", id: "tg", uid: "u", finalizers: [PropagationFinalizer.Orphan] })),
    ).toBe("Orphan");
  });
});

describe("planOwnerDeletion — no deletionTimestamp", () => {
  test("not being deleted → no actions", () => {
    const owner = node({ kind: "taskGroup", id: "tg", uid: "u-tg" });
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([]);
  });
});

describe("planOwnerDeletion — Foreground", () => {
  const owner = node({
    kind: "taskGroup",
    id: "tg",
    uid: "u-tg",
    finalizers: [PropagationFinalizer.Foreground],
    deletionTimestamp: "2026-06-08T00:00:00.000Z",
  });

  test("marks unmarked controlled children", () => {
    const actions = planOwnerDeletion(owner, [child("a", "u-tg"), child("b", "u-tg")]);
    expect(actions).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
      { type: "mark-deletion", ref: { kind: "agentTask", id: "b" } },
    ]);
  });

  test("children marked but still present → still terminating (no actions)", () => {
    const marked = child("a", "u-tg", { deletionTimestamp: "2026-06-08T00:00:01.000Z" });
    expect(planOwnerDeletion(owner, [marked])).toEqual([]);
  });

  test("children gone → remove foreground finalizer", () => {
    expect(planOwnerDeletion(owner, [])).toEqual([
      {
        type: "remove-finalizer",
        ref: { kind: "taskGroup", id: "tg" },
        finalizer: PropagationFinalizer.Foreground,
      },
    ]);
  });

  test("finalizer removed + children gone → reap", () => {
    const reapable = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(reapable, [])).toEqual([
      { type: "reap", ref: { kind: "taskGroup", id: "tg" } },
    ]);
  });
});

describe("planOwnerDeletion — Orphan", () => {
  const owner = node({
    kind: "taskGroup",
    id: "tg",
    uid: "u-tg",
    finalizers: [PropagationFinalizer.Orphan],
    deletionTimestamp: "2026-06-08T00:00:00.000Z",
  });

  test("strips the controller ownerRef from children", () => {
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([
      { type: "orphan", ref: { kind: "agentTask", id: "a" }, ownerUid: "u-tg" },
    ]);
  });

  test("children detached → remove orphan finalizer, then reap on next pass", () => {
    expect(planOwnerDeletion(owner, [])).toEqual([
      {
        type: "remove-finalizer",
        ref: { kind: "taskGroup", id: "tg" },
        finalizer: PropagationFinalizer.Orphan,
      },
    ]);
  });
});

describe("planOwnerDeletion — Background", () => {
  test("marks children AND reaps owner immediately", () => {
    const owner = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(owner, [child("a", "u-tg")])).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
      { type: "reap", ref: { kind: "taskGroup", id: "tg" } },
    ]);
  });
});

describe("reap gating by finalizer", () => {
  test("deletionTimestamp set but a kind finalizer present → no reap", () => {
    const owner = node({
      kind: "agentTask",
      id: "at",
      uid: "u",
      finalizers: ["grove.dev/pending-review"],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    expect(planOwnerDeletion(owner, [])).toEqual([]);
  });
});

describe("planDanglingChild", () => {
  test("owner gone, child unmarked → mark for deletion", () => {
    expect(planDanglingChild(child("a", "u-tg"), false)).toEqual([
      { type: "mark-deletion", ref: { kind: "agentTask", id: "a" } },
    ]);
  });

  test("owner gone, child marked, finalizers empty → reap", () => {
    const marked = child("a", "u-tg", { deletionTimestamp: "2026-06-08T00:00:01.000Z" });
    expect(planDanglingChild(marked, false)).toEqual([
      { type: "reap", ref: { kind: "agentTask", id: "a" } },
    ]);
  });

  test("owner still exists → no actions", () => {
    expect(planDanglingChild(child("a", "u-tg"), true)).toEqual([]);
  });

  test("no controller ownerRef → not a dangling candidate", () => {
    const orphaned = node({ kind: "agentTask", id: "a", uid: "u-a" });
    expect(planDanglingChild(orphaned, false)).toEqual([]);
  });
});

describe("idempotency", () => {
  test("converged Foreground owner (children gone, finalizer cleared) yields reap then nothing", () => {
    const reaped = node({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    const first = planOwnerDeletion(reaped, []);
    expect(first).toEqual([{ type: "reap", ref: { kind: "taskGroup", id: "tg" } }]);
    // After reap the node would be gone; re-running planDanglingChild on a
    // hypothetical leftover with empty finalizers is a single reap, not a loop.
    expect(planOwnerDeletion(reaped, [])).toEqual(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/owner-graph.test.ts`
Expected: FAIL — cannot find module `./owner-graph.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/owner-graph.ts`:

```ts
/**
 * Pure cascade/reap decision core for the garbage collector (Epic D #306).
 *
 * No I/O, no async, no clock — every function is a pure projection over an
 * entity snapshot, so cascade logic is unit-testable in isolation. The
 * GarbageCollector loop (garbage-collector.ts) supplies the snapshots and
 * executes the returned actions against a store.
 */

import {
  type CascadePolicy,
  type OwnerKind,
  type OwnerRef,
  PropagationFinalizer,
} from "./lifecycle-metadata.js";

/** Identity of a GC-managed node: (kind, id). */
export interface GcRef {
  readonly kind: OwnerKind;
  readonly id: string;
}

/** Minimal lifecycle projection of any GC-managed entity. */
export interface GcNode {
  readonly kind: OwnerKind;
  readonly id: string;
  readonly uid: string;
  /** Resource version for CAS writes (string, store-defined). */
  readonly resourceVersion: string;
  readonly ownerRefs: readonly OwnerRef[];
  readonly finalizers: readonly string[];
  readonly deletionTimestamp?: string | undefined;
}

/** One reconcile-step action. The loop stamps timestamps and threads CAS. */
export type GcAction =
  | { readonly type: "mark-deletion"; readonly ref: GcRef }
  | { readonly type: "orphan"; readonly ref: GcRef; readonly ownerUid: string }
  | { readonly type: "remove-finalizer"; readonly ref: GcRef; readonly finalizer: string }
  | { readonly type: "reap"; readonly ref: GcRef };

export function refOf(node: GcNode): GcRef {
  return { kind: node.kind, id: node.id };
}

/** Derive cascade policy from the propagation finalizer the owner carries. */
export function policyOf(owner: GcNode): CascadePolicy {
  if (owner.finalizers.includes(PropagationFinalizer.Foreground)) return "Foreground";
  if (owner.finalizers.includes(PropagationFinalizer.Orphan)) return "Orphan";
  return "Background";
}

/** Does `child` carry a controller ownerRef pointing at `ownerUid`? */
function controlledBy(child: GcNode, ownerUid: string): boolean {
  return child.ownerRefs.some((ref) => ref.uid === ownerUid && ref.controller === true);
}

/** Reap only when deletion is requested AND every finalizer is cleared. */
function reapIfReady(node: GcNode): readonly GcAction[] {
  if (node.deletionTimestamp === undefined) return [];
  return node.finalizers.length === 0 ? [{ type: "reap", ref: refOf(node) }] : [];
}

/**
 * One idempotent reconcile step for a node that has a deletionTimestamp.
 * Cascades to its controlled children per policy, then reaps itself when ready.
 * Returns `[]` when the node is not being deleted or the world is converged.
 */
export function planOwnerDeletion(
  owner: GcNode,
  children: readonly GcNode[],
): readonly GcAction[] {
  if (owner.deletionTimestamp === undefined) return [];
  const controlled = children.filter((child) => controlledBy(child, owner.uid));
  const policy = policyOf(owner);

  if (policy === "Orphan") {
    if (controlled.length > 0) {
      return controlled.map((child) => ({
        type: "orphan" as const,
        ref: refOf(child),
        ownerUid: owner.uid,
      }));
    }
    if (owner.finalizers.includes(PropagationFinalizer.Orphan)) {
      return [
        { type: "remove-finalizer", ref: refOf(owner), finalizer: PropagationFinalizer.Orphan },
      ];
    }
    return reapIfReady(owner);
  }

  if (policy === "Foreground") {
    const blocking = controlled.filter((child) => child.deletionTimestamp === undefined);
    if (blocking.length > 0) {
      return blocking.map((child) => ({ type: "mark-deletion" as const, ref: refOf(child) }));
    }
    // Children are marked but still present — stay Terminating until they're gone.
    if (controlled.length > 0) return [];
    if (owner.finalizers.includes(PropagationFinalizer.Foreground)) {
      return [
        {
          type: "remove-finalizer",
          ref: refOf(owner),
          finalizer: PropagationFinalizer.Foreground,
        },
      ];
    }
    return reapIfReady(owner);
  }

  // Background: mark children for async GC, reap owner immediately.
  const actions: GcAction[] = controlled
    .filter((child) => child.deletionTimestamp === undefined)
    .map((child) => ({ type: "mark-deletion" as const, ref: refOf(child) }));
  actions.push(...reapIfReady(owner));
  return actions;
}

/**
 * GC backstop: a child whose controller owner UID no longer resolves.
 * `ownerExists` is true only when the controller owner is present AND its UID
 * still matches (a recreated owner with a new UID counts as gone).
 */
export function planDanglingChild(
  child: GcNode,
  ownerExists: boolean,
): readonly GcAction[] {
  const hasController = child.ownerRefs.some((ref) => ref.controller === true);
  if (!hasController || ownerExists) return [];
  if (child.deletionTimestamp === undefined) {
    return [{ type: "mark-deletion", ref: refOf(child) }];
  }
  return reapIfReady(child);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/owner-graph.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/core/owner-graph.ts src/core/owner-graph.test.ts
git commit --no-verify -m "feat(#306): pure owner-graph cascade/reap decision core"
```

---

## Task 3: GcStore interface + GarbageCollector loop

**Files:**
- Create: `src/core/garbage-collector.ts`

(No standalone test in this task — the loop is exercised in Task 4 against the in-memory store. This task only adds code that Task 4 depends on; commit it together at the end of Task 4 if your workflow prefers test-first commits. The interface and class are written here so Task 4's test compiles.)

- [ ] **Step 1: Write the implementation**

Create `src/core/garbage-collector.ts`:

```ts
import type { CasMutationResult, CasOpts } from "./cas.js";
import {
  type GcAction,
  type GcNode,
  type GcRef,
  planDanglingChild,
  planOwnerDeletion,
  refOf,
} from "./owner-graph.js";
import { withIfMatch } from "./with-if-match.js";
import { KeyedWorkQueue, QueueClosedError, type WorkItemResult } from "./workqueue.js";

/**
 * Segregated store surface the GarbageCollector depends on. Concrete stores
 * (in-memory fixture, AgentTask adapter, composite) implement it. Mutators are
 * CAS-aware and return the post-write node so the loop can thread retries.
 */
export interface GcStore {
  getNode(ref: GcRef): Promise<GcNode | undefined>;
  /** All nodes that currently have a deletionTimestamp set. */
  listPendingDeletion(): Promise<readonly GcNode[]>;
  /** All nodes carrying any ownerRef whose uid === ownerUid. */
  listOwnedBy(ownerUid: string): Promise<readonly GcNode[]>;
  setDeletionTimestamp(
    ref: GcRef,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>>;
  removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
  removeFinalizer(ref: GcRef, finalizer: string, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
  /** Hard-delete. MUST reject (throw) if the node still has finalizers. */
  reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>>;
}

export interface GarbageCollectorOptions {
  readonly store: GcStore;
  readonly queue?: KeyedWorkQueue | undefined;
  readonly resyncIntervalMs?: number | undefined;
  readonly workerCount?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onError?: ((error: unknown, key: string) => void) | undefined;
  readonly onAction?: ((action: GcAction) => void) | undefined;
}

const DEFAULT_RESYNC_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_COUNT = 1;
const MAX_RESYNC_INTERVAL_MS = 2_147_483_647;
const MAX_WORKER_COUNT = 1_000;

/** Sentinel: the target node vanished mid-reconcile (already reaped). Benign. */
class NodeVanished extends Error {
  constructor() {
    super("gc target node vanished");
    this.name = "NodeVanished";
  }
}

export function gcKey(ref: GcRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseGcKey(key: string): GcRef {
  const idx = key.indexOf(":");
  if (idx === -1) throw new Error(`invalid gc key: ${key}`);
  return { kind: key.slice(0, idx) as GcRef["kind"], id: key.slice(idx + 1) };
}

export class GarbageCollector {
  private readonly store: GcStore;
  private readonly queue: KeyedWorkQueue;
  private readonly now: () => number;
  private readonly resyncIntervalMs: number;
  private readonly workerCount: number;
  private readonly onError: ((error: unknown, key: string) => void) | undefined;
  private readonly onAction: ((action: GcAction) => void) | undefined;
  private running = false;
  private stopRequested = false;
  private workers: Promise<void>[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: GarbageCollectorOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? new KeyedWorkQueue({ now: this.now });
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    if (
      !Number.isFinite(this.resyncIntervalMs) ||
      this.resyncIntervalMs < 1 ||
      this.resyncIntervalMs > MAX_RESYNC_INTERVAL_MS
    ) {
      throw new RangeError(
        `resyncIntervalMs must be a finite positive number no greater than ${MAX_RESYNC_INTERVAL_MS}`,
      );
    }
    if (!Number.isInteger(this.workerCount) || this.workerCount < 1 || this.workerCount > MAX_WORKER_COUNT) {
      throw new RangeError(`workerCount must be an integer between 1 and ${MAX_WORKER_COUNT}`);
    }
    this.onError = options.onError;
    this.onAction = options.onAction;
  }

  enqueue(ref: GcRef): void {
    this.queue.enqueue(gcKey(ref));
  }

  async resync(): Promise<number> {
    const pending = await this.store.listPendingDeletion();
    for (const node of pending) {
      this.enqueue(refOf(node));
      const children = await this.store.listOwnedBy(node.uid);
      for (const child of children) this.enqueue(refOf(child));
    }
    return pending.length;
  }

  async reconcileNode(ref: GcRef): Promise<void> {
    const node = await this.store.getNode(ref);
    if (node === undefined) return;

    let actions: readonly GcAction[];
    if (node.deletionTimestamp !== undefined) {
      const children = await this.store.listOwnedBy(node.uid);
      actions = planOwnerDeletion(node, children);
    } else {
      actions = planDanglingChild(node, await this.ownerExists(node));
    }

    for (const action of actions) {
      try {
        await this.execute(action);
        this.onAction?.(action);
        // Promptly re-reconcile the touched node so multi-step convergence
        // (mark → reap, orphan → remove-finalizer → reap) does not wait for
        // the next resync.
        this.enqueue(action.ref);
      } catch (error) {
        if (error instanceof NodeVanished) continue;
        throw error;
      }
    }
  }

  start(): void {
    if (this.running) return;
    if (this.stopRequested) throw new QueueClosedError();
    this.running = true;
    this.stopRequested = false;
    for (let i = 0; i < this.workerCount; i += 1) {
      this.workers.push(this.workerLoop());
    }
    this.resyncTimer = setInterval(() => {
      void this.resync().catch((error: unknown) => this.reportError(error, "__resync__"));
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

  private async workerLoop(): Promise<void> {
    while (!this.stopRequested) {
      let item: WorkItemResult;
      try {
        item = await this.queue.take();
      } catch (error) {
        if (this.stopRequested) return;
        throw error;
      }
      try {
        await this.reconcileNode(parseGcKey(item.key));
        this.queue.acknowledge(item.key);
      } catch (error) {
        if (!this.stopRequested) this.queue.retry(item.key);
        this.reportError(error, item.key);
      }
    }
  }

  private async ownerExists(node: GcNode): Promise<boolean> {
    const controller = node.ownerRefs.find((ref) => ref.controller === true);
    if (controller === undefined) return true; // not a dangling candidate
    const owner = await this.store.getNode({ kind: controller.kind, id: controller.id });
    return owner !== undefined && owner.uid === controller.uid;
  }

  private async execute(action: GcAction): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    await this.casMutate(action.ref, (opts) => {
      switch (action.type) {
        case "mark-deletion":
          return this.store.setDeletionTimestamp(action.ref, nowIso, opts);
        case "orphan":
          return this.store.removeOwnerRef(action.ref, action.ownerUid, opts);
        case "remove-finalizer":
          return this.store.removeFinalizer(action.ref, action.finalizer, opts);
        case "reap":
          return this.store.reap(action.ref, opts);
      }
    });
  }

  private async casMutate(
    ref: GcRef,
    patch: (opts: CasOpts) => Promise<CasMutationResult<GcNode>>,
  ): Promise<void> {
    await withIfMatch<GcNode>(
      async () => {
        const cur = await this.store.getNode(ref);
        if (cur === undefined) throw new NodeVanished();
        return { resourceVersion: cur.resourceVersion };
      },
      (opts) => patch({ ifMatch: opts.ifMatch }),
    );
  }

  private reportError(error: unknown, key: string): void {
    try {
      this.onError?.(error, key);
    } catch {
      return;
    }
  }
}
```

- [ ] **Step 2: Typecheck the new module compiles**

Run: `bunx tsc --noEmit`
Expected: PASS (no errors in `garbage-collector.ts`; the file is unused so far, which is fine).

- [ ] **Step 3: Commit**

```bash
git add src/core/garbage-collector.ts
git commit --no-verify -m "feat(#306): GcStore interface + GarbageCollector reconcile loop"
```

---

## Task 4: In-memory GcStore + cascade acceptance tests

**Files:**
- Create: `src/core/in-memory-gc-store.ts`
- Test: `src/core/garbage-collector.test.ts`

- [ ] **Step 1: Write the in-memory store**

Create `src/core/in-memory-gc-store.ts`:

```ts
import { type CasMismatchResult, type CasMutationResult, type CasOpts } from "./cas.js";
import type { GcStore } from "./garbage-collector.js";
import { gcKey } from "./garbage-collector.js";
import type { GcNode, GcRef } from "./owner-graph.js";

interface MutableNode {
  kind: GcNode["kind"];
  id: string;
  uid: string;
  rv: number;
  ownerRefs: GcNode["ownerRefs"];
  finalizers: string[];
  deletionTimestamp?: string | undefined;
}

function toGcNode(n: MutableNode): GcNode {
  return {
    kind: n.kind,
    id: n.id,
    uid: n.uid,
    resourceVersion: String(n.rv),
    ownerRefs: n.ownerRefs,
    finalizers: [...n.finalizers],
    deletionTimestamp: n.deletionTimestamp,
  };
}

/** In-memory GcStore holding nodes of every kind. For tests/fixtures only. */
export class InMemoryGcStore implements GcStore {
  private readonly nodes = new Map<string, MutableNode>();

  /** Seed a node. Returns the key. */
  put(node: Omit<GcNode, "resourceVersion"> & { resourceVersion?: string }): void {
    this.nodes.set(gcKey(node), {
      kind: node.kind,
      id: node.id,
      uid: node.uid,
      rv: node.resourceVersion === undefined ? 1 : Number(node.resourceVersion),
      ownerRefs: node.ownerRefs,
      finalizers: [...node.finalizers],
      deletionTimestamp: node.deletionTimestamp,
    });
  }

  has(ref: GcRef): boolean {
    return this.nodes.has(gcKey(ref));
  }

  async getNode(ref: GcRef): Promise<GcNode | undefined> {
    const n = this.nodes.get(gcKey(ref));
    return n === undefined ? undefined : toGcNode(n);
  }

  async listPendingDeletion(): Promise<readonly GcNode[]> {
    return [...this.nodes.values()].filter((n) => n.deletionTimestamp !== undefined).map(toGcNode);
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    return [...this.nodes.values()]
      .filter((n) => n.ownerRefs.some((r) => r.uid === ownerUid))
      .map(toGcNode);
  }

  async setDeletionTimestamp(
    ref: GcRef,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      if (n.deletionTimestamp === undefined) n.deletionTimestamp = deletionTimestamp;
    });
  }

  async removeOwnerRef(
    ref: GcRef,
    ownerUid: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      n.ownerRefs = n.ownerRefs.filter((r) => r.uid !== ownerUid);
    });
  }

  async removeFinalizer(
    ref: GcRef,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<GcNode>> {
    return this.mutate(ref, opts, (n) => {
      n.finalizers = n.finalizers.filter((f) => f !== finalizer);
    });
  }

  async reap(ref: GcRef, opts?: CasOpts): Promise<CasMutationResult<GcNode>> {
    const key = gcKey(ref);
    const n = this.nodes.get(key);
    if (n === undefined) {
      // Already gone — surface as a benign mismatch so the loop's getNode
      // probe (which throws NodeVanished) handles it; never reached in practice
      // because the loop reads first.
      return { kind: "rv-mismatch", current: { resourceVersion: "0", generation: 0 } };
    }
    const mismatch = this.checkCas(n, opts);
    if (mismatch !== null) return mismatch;
    if (n.finalizers.length > 0) {
      throw new Error(`reap refused: ${key} still has finalizers [${n.finalizers.join(", ")}]`);
    }
    const view = toGcNode(n);
    this.nodes.delete(key);
    return { kind: "ok", view };
  }

  private mutate(
    ref: GcRef,
    opts: CasOpts | undefined,
    apply: (n: MutableNode) => void,
  ): CasMutationResult<GcNode> {
    const n = this.nodes.get(gcKey(ref));
    if (n === undefined) {
      return { kind: "rv-mismatch", current: { resourceVersion: "0", generation: 0 } };
    }
    const mismatch = this.checkCas(n, opts);
    if (mismatch !== null) return mismatch;
    apply(n);
    n.rv += 1;
    return { kind: "ok", view: toGcNode(n) };
  }

  private checkCas(n: MutableNode, opts: CasOpts | undefined): CasMismatchResult | null {
    if (opts?.ifMatch === undefined) return null;
    if (opts.ifMatch === String(n.rv)) return null;
    return { kind: "rv-mismatch", current: { resourceVersion: String(n.rv), generation: n.rv } };
  }
}
```

- [ ] **Step 2: Write the failing acceptance tests**

Create `src/core/garbage-collector.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GarbageCollector } from "./garbage-collector.js";
import { InMemoryGcStore } from "./in-memory-gc-store.js";
import { KindFinalizer, PropagationFinalizer } from "./lifecycle-metadata.js";
import type { GcRef } from "./owner-graph.js";

const TG: GcRef = { kind: "taskGroup", id: "tg" };
const A: GcRef = { kind: "agentTask", id: "a" };
const B: GcRef = { kind: "agentTask", id: "b" };

function controlledByTg(id: string) {
  return [{ kind: "taskGroup" as const, id: "tg", uid: "u-tg", controller: true }];
}

/** Drive the loop to convergence: drain the queue by reconciling until empty. */
async function drain(gc: GarbageCollector, store: InMemoryGcStore, refs: GcRef[]): Promise<void> {
  // Deterministic manual pump: repeatedly reconcile every still-present ref
  // plus all pending-deletion nodes until a full pass produces no changes.
  for (let pass = 0; pass < 50; pass += 1) {
    const pending = await store.listPendingDeletion();
    const toVisit = new Map<string, GcRef>();
    for (const r of refs) toVisit.set(`${r.kind}:${r.id}`, r);
    for (const n of pending) toVisit.set(`${n.kind}:${n.id}`, { kind: n.kind, id: n.id });
    for (const ref of toVisit.values()) await gc.reconcileNode(ref);
  }
}

describe("cascade: delete TaskGroup", () => {
  test("Foreground — children marked then reaped, then owner reaped", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Foreground],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });
    store.put({ kind: "agentTask", id: "b", uid: "u-b", ownerRefs: controlledByTg("b"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A, B]);

    expect(store.has(A)).toBe(false);
    expect(store.has(B)).toBe(false);
    expect(store.has(TG)).toBe(false);
  });

  test("Background — owner reaped, children GC'd", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A]);

    expect(store.has(TG)).toBe(false);
    expect(store.has(A)).toBe(false);
  });

  test("Orphan — children preserved, controller ownerRef stripped, owner reaped", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Orphan],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [TG, A]);

    expect(store.has(TG)).toBe(false);
    expect(store.has(A)).toBe(true);
    const a = await store.getNode(A);
    expect(a?.ownerRefs).toEqual([]); // controller ref stripped, child orphaned
    expect(a?.deletionTimestamp).toBeUndefined(); // NOT marked for deletion
  });
});

describe("finalizer blocks reap", () => {
  test("AgentTask with pending-review is not reaped until the finalizer is removed", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "agentTask",
      id: "a",
      uid: "u-a",
      ownerRefs: [],
      finalizers: [KindFinalizer.PendingReview],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });

    const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await drain(gc, store, [A]);
    expect(store.has(A)).toBe(true); // blocked

    // Reviewer clears the finalizer.
    await store.removeFinalizer(A, KindFinalizer.PendingReview);
    await drain(gc, store, [A]);
    expect(store.has(A)).toBe(false); // now reaped
  });
});

describe("crash recovery", () => {
  test("partial cascade converges on a fresh reconcile pass", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [PropagationFinalizer.Foreground],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    store.put({ kind: "agentTask", id: "a", uid: "u-a", ownerRefs: controlledByTg("a"), finalizers: [] });

    // Simulate a crash after only marking the child: do ONE reconcile of TG.
    const gc1 = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:05.000Z") });
    await gc1.reconcileNode(TG);
    expect((await store.getNode(A))?.deletionTimestamp).toBeDefined();
    expect(store.has(TG)).toBe(true); // not yet reaped

    // Fresh collector resumes and finishes.
    const gc2 = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T00:00:06.000Z") });
    await drain(gc2, store, [TG, A]);
    expect(store.has(A)).toBe(false);
    expect(store.has(TG)).toBe(false);
  });
});

describe("resync enqueues pending + children", () => {
  test("resync returns the count of pending-deletion owners", async () => {
    const store = new InMemoryGcStore();
    store.put({
      kind: "taskGroup",
      id: "tg",
      uid: "u-tg",
      ownerRefs: [],
      finalizers: [],
      deletionTimestamp: "2026-06-08T00:00:00.000Z",
    });
    const gc = new GarbageCollector({ store });
    expect(await gc.resync()).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/core/garbage-collector.test.ts`
Expected: FAIL — `./in-memory-gc-store.js` / `./garbage-collector.js` resolve, but assertions fail or modules are incomplete if Task 3 was skipped. If Task 3 is committed, expect PASS-or-FAIL per assertion; investigate any FAIL before continuing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/garbage-collector.test.ts`
Expected: PASS (all describe blocks). If the Foreground test loops without reaping, confirm `reconcileNode` re-enqueues `action.ref` and `drain` revisits both TG and children.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/in-memory-gc-store.ts src/core/garbage-collector.test.ts
git commit --no-verify -m "feat(#306): in-memory GcStore + cascade/finalizer/crash acceptance tests"
```

---

## Task 5: Real AgentTask lifecycle mutators (Sqlite)

**Files:**
- Modify: `src/core/store.ts:451-493` (`AgentTaskStore` interface)
- Modify: `src/local/sqlite-store.ts` (`SqliteAgentTaskStore`)
- Test: `src/local/sqlite-store.test.ts` (append) — confirm the file exists; if not, create it with the import block shown.

- [ ] **Step 1: Extend the `AgentTaskStore` interface**

In `src/core/store.ts`, inside `export interface AgentTaskStore { ... }`, add these methods just before `close(): void;`:

```ts
  /**
   * Set `deletionTimestamp` (and optionally seed propagation/kind finalizers)
   * on the spec row. Idempotent: a second call with deletion already set is a
   * no-op write that still bumps RV. CAS-aware via `opts.ifMatch` (spec RV).
   */
  setAgentTaskDeletion(
    taskId: string,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>>;

  /** Remove a single finalizer from the spec row. CAS-aware (spec RV). */
  removeAgentTaskFinalizer(
    taskId: string,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>>;

  /** Remove every ownerRef whose uid === ownerUid from the spec row (orphan). */
  removeAgentTaskOwnerRef(
    taskId: string,
    ownerUid: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>>;

  /**
   * Hard-delete the spec row (status drops via the FK ON DELETE CASCADE).
   * MUST throw if the row still has finalizers. CAS-aware (spec RV). Returns
   * the pre-delete view on success.
   */
  reapAgentTask(taskId: string, opts?: CasOpts): Promise<CasMutationResult<AgentTaskView>>;
```

`CasOpts` and `CasMutationResult` are already imported in `store.ts` (used by `putAgentTaskSpec`). `OwnerRef` is not needed here.

- [ ] **Step 2: Write the failing test**

Append to `src/local/sqlite-store.test.ts`. If the file does not yet exist, create it with this header:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTaskPhase, type AgentTaskSpecRecord } from "../core/agent-task.js";
import { expectOk } from "../core/cas.js";
import { KindFinalizer } from "../core/lifecycle-metadata.js";
import { createSqliteStores } from "./sqlite-store.js";
```

Add the test block:

```ts
describe("SqliteAgentTaskStore lifecycle mutators (#306)", () => {
  function spec(id: string, over: Partial<AgentTaskSpecRecord> = {}): AgentTaskSpecRecord {
    return {
      id,
      worktree: "/wt",
      runtime: "claude",
      role: "coder",
      prompt: "go",
      dependsOn: [],
      generation: 1,
      createdAt: "2026-06-08T00:00:00.000Z",
      ...over,
    };
  }

  test("setAgentTaskDeletion stamps the spec row", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      expectOk(await stores.agentTaskStore.putAgentTaskSpec(spec("t1")));
      const r = expectOk(
        await stores.agentTaskStore.setAgentTaskDeletion("t1", "2026-06-08T01:00:00.000Z"),
      );
      expect(r.spec.deletionTimestamp).toBe("2026-06-08T01:00:00.000Z");
    } finally {
      stores.close();
    }
  });

  test("reapAgentTask refuses while finalizers remain, succeeds once cleared", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("t2", { finalizers: [KindFinalizer.PendingReview] }),
        ),
      );
      expectOk(await stores.agentTaskStore.setAgentTaskDeletion("t2", "2026-06-08T01:00:00.000Z"));

      await expect(stores.agentTaskStore.reapAgentTask("t2")).rejects.toThrow(/finalizer/i);

      expectOk(
        await stores.agentTaskStore.removeAgentTaskFinalizer("t2", KindFinalizer.PendingReview),
      );
      expectOk(await stores.agentTaskStore.reapAgentTask("t2"));

      expect(await stores.agentTaskStore.getAgentTask("t2")).toBeUndefined();
    } finally {
      stores.close();
    }
  });

  test("removeAgentTaskOwnerRef strips matching refs (orphan)", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("t3", { ownerRef: { kind: "taskGroup", id: "tg", uid: "u-tg", controller: true } }),
        ),
      );
      const r = expectOk(await stores.agentTaskStore.removeAgentTaskOwnerRef("t3", "u-tg"));
      expect(r.spec.ownerRef).toBeUndefined();
    } finally {
      stores.close();
    }
  });
});
```

Note on `ownerRef` shape: `AgentTaskSpecRecord.ownerRef` is a single `OwnerRef` (see `src/core/agent-task.ts:43`). `removeAgentTaskOwnerRef` clears it when its uid matches.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/local/sqlite-store.test.ts`
Expected: FAIL — `setAgentTaskDeletion` etc. are not functions on the store.

- [ ] **Step 4: Implement the mutators**

In `src/local/sqlite-store.ts`, inside `class SqliteAgentTaskStore`, add these methods after `patchAgentTaskStatus` (before `listAgentTaskEntities`). They follow the same CAS pattern as `putAgentTaskSpec` (compare against spec `resource_version`, bump it on write):

```ts
  setAgentTaskDeletion = async (
    taskId: string,
    deletionTimestamp: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> =>
    this.mutateSpec(taskId, opts, (existing) => {
      const next = existing.deletionTimestamp ?? deletionTimestamp;
      this.db
        .prepare(
          `UPDATE agent_task_spec
             SET deletion_timestamp = ?, generation = generation + 1, resource_version = resource_version + 1
           WHERE id = ?`,
        )
        .run(next, taskId);
    });

  removeAgentTaskFinalizer = async (
    taskId: string,
    finalizer: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> =>
    this.mutateSpec(taskId, opts, (existing) => {
      const remaining = (existing.finalizers ?? []).filter((f) => f !== finalizer);
      this.db
        .prepare(
          `UPDATE agent_task_spec
             SET finalizers_json = ?, generation = generation + 1, resource_version = resource_version + 1
           WHERE id = ?`,
        )
        .run(JSON.stringify(remaining), taskId);
    });

  removeAgentTaskOwnerRef = async (
    taskId: string,
    ownerUid: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> =>
    this.mutateSpec(taskId, opts, (existing) => {
      const cleared = existing.ownerRef !== undefined && existing.ownerRef.uid === ownerUid;
      this.db
        .prepare(
          `UPDATE agent_task_spec
             SET owner_ref_json = ?, generation = generation + 1, resource_version = resource_version + 1
           WHERE id = ?`,
        )
        .run(cleared ? null : JSON.stringify(existing.ownerRef ?? null), taskId);
    });

  reapAgentTask = async (
    taskId: string,
    opts?: CasOpts,
  ): Promise<CasMutationResult<AgentTaskView>> => {
    let mismatch: CasMutationResult<AgentTaskView> | null = null;
    let deleted: AgentTaskView | null = null;
    const tx = this.db.transaction(() => {
      const existing = this.readAgentTask(taskId);
      if (existing === null) {
        throw new NotFoundError({
          resource: "AgentTask",
          identifier: taskId,
          message: `AgentTask '${taskId}' not found`,
        });
      }
      const cas = checkIfMatch(existing.spec.resourceVersion, opts?.ifMatch, existing.spec.generation);
      if (cas !== null) {
        mismatch = cas;
        return;
      }
      if ((existing.spec.finalizers ?? []).length > 0) {
        throw new Error(
          `reapAgentTask refused: '${taskId}' still has finalizers [${(existing.spec.finalizers ?? []).join(", ")}]`,
        );
      }
      deleted = existing;
      // agent_task_status drops via FK ON DELETE CASCADE.
      this.db.prepare("DELETE FROM agent_task_spec WHERE id = ?").run(taskId);
    });
    tx.immediate();
    if (mismatch !== null) return mismatch;
    if (deleted === null) throw new Error(`reapAgentTask('${taskId}') produced no view`);
    return { kind: "ok", view: deleted };
  };

  /** Shared CAS wrapper for spec-row lifecycle edits. */
  private mutateSpec(
    taskId: string,
    opts: CasOpts | undefined,
    apply: (existing: AgentTaskSpecRecord) => void,
  ): CasMutationResult<AgentTaskView> {
    let mismatch: CasMutationResult<AgentTaskView> | null = null;
    const tx = this.db.transaction(() => {
      const existing = this.readAgentTask(taskId);
      if (existing === null) {
        throw new NotFoundError({
          resource: "AgentTask",
          identifier: taskId,
          message: `AgentTask '${taskId}' not found`,
        });
      }
      const cas = checkIfMatch(existing.spec.resourceVersion, opts?.ifMatch, existing.spec.generation);
      if (cas !== null) {
        mismatch = cas;
        return;
      }
      apply(existing.spec);
    });
    tx.immediate();
    if (mismatch !== null) return mismatch;
    const view = this.readAgentTask(taskId);
    if (view === null) throw new Error(`Failed to read back agent task '${taskId}'`);
    this.emitAgentTaskWrite("MODIFIED", view);
    return { kind: "ok", view };
  }
```

`mutateSpec` is synchronous and returns the result directly; the public async methods just `return this.mutateSpec(...)` (a value, auto-wrapped in the returned Promise). `checkIfMatch` and `NotFoundError` are already imported in `sqlite-store.ts` (used by the existing methods). `AgentTaskSpecRecord` is already imported.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/local/sqlite-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS. Any other `AgentTaskStore` implementor (search `implements AgentTaskStore`) must also gain the four methods; if `bunx tsc` flags one, add the same signatures. (As of this plan, `SqliteAgentTaskStore` is the only implementor.)

- [ ] **Step 7: Commit**

```bash
git add src/core/store.ts src/local/sqlite-store.ts src/local/sqlite-store.test.ts
git commit --no-verify -m "feat(#306): AgentTask spec-lifecycle mutators + finalizer-guarded reap (Sqlite)"
```

---

## Task 6: AgentTaskGcStore adapter + CompositeGcStore + real-store integration

**Files:**
- Create: `src/core/agent-task-gc-store.ts`
- Test: `src/core/agent-task-gc-store.test.ts`

- [ ] **Step 1: Write the adapter + composite**

Create `src/core/agent-task-gc-store.ts`:

```ts
import type { AgentTaskView } from "./agent-task.js";
import type { CasMutationResult, CasOpts } from "./cas.js";
import type { GcStore } from "./garbage-collector.js";
import type { GcNode, GcRef } from "./owner-graph.js";
import type { AgentTaskStore } from "./store.js";

/** Project an AgentTaskView onto the GcNode lifecycle shape. */
function taskToGcNode(view: AgentTaskView): GcNode {
  return {
    kind: "agentTask",
    id: view.spec.id,
    // AgentTask has no separate uid column; its id is its stable identity.
    uid: view.spec.id,
    resourceVersion: String(view.spec.resourceVersion ?? view.spec.generation),
    ownerRefs: view.spec.ownerRef === undefined ? [] : [view.spec.ownerRef],
    finalizers: view.spec.finalizers ?? [],
    deletionTimestamp: view.spec.deletionTimestamp,
  };
}

function mapResult(r: CasMutationResult<AgentTaskView>): CasMutationResult<GcNode> {
  return r.kind === "ok" ? { kind: "ok", view: taskToGcNode(r.view) } : r;
}

/** GcStore scoped to the `agentTask` kind, backed by a real AgentTaskStore. */
export class AgentTaskGcStore implements GcStore {
  constructor(private readonly store: AgentTaskStore) {}

  private assertKind(ref: GcRef): void {
    if (ref.kind !== "agentTask") {
      throw new Error(`AgentTaskGcStore received non-agentTask ref: ${ref.kind}:${ref.id}`);
    }
  }

  async getNode(ref: GcRef): Promise<GcNode | undefined> {
    if (ref.kind !== "agentTask") return undefined;
    const view = await this.store.getAgentTask(ref.id);
    return view === undefined ? undefined : taskToGcNode(view);
  }

  async listPendingDeletion(): Promise<readonly GcNode[]> {
    const all = await this.store.listAgentTasks();
    return all
      .filter((v) => v.spec.deletionTimestamp !== undefined)
      .map(taskToGcNode);
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    const all = await this.store.listAgentTasks();
    return all
      .filter((v) => v.spec.ownerRef !== undefined && v.spec.ownerRef.uid === ownerUid)
      .map(taskToGcNode);
  }

  async setDeletionTimestamp(ref: GcRef, ts: string, opts?: CasOpts) {
    this.assertKind(ref);
    return mapResult(await this.store.setAgentTaskDeletion(ref.id, ts, opts));
  }

  async removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts) {
    this.assertKind(ref);
    return mapResult(await this.store.removeAgentTaskOwnerRef(ref.id, ownerUid, opts));
  }

  async removeFinalizer(ref: GcRef, finalizer: string, opts?: CasOpts) {
    this.assertKind(ref);
    return mapResult(await this.store.removeAgentTaskFinalizer(ref.id, finalizer, opts));
  }

  async reap(ref: GcRef, opts?: CasOpts) {
    this.assertKind(ref);
    return mapResult(await this.store.reapAgentTask(ref.id, opts));
  }
}

/**
 * Routes GcStore calls to a per-kind backing store, and fans `listPendingDeletion`
 * / `listOwnedBy` across all of them. Lets the GarbageCollector span a TaskGroup
 * owner (one store) and AgentTask children (another) as one logical graph.
 */
export class CompositeGcStore implements GcStore {
  constructor(private readonly byKind: ReadonlyMap<GcRef["kind"], GcStore>) {}

  private route(ref: GcRef): GcStore {
    const store = this.byKind.get(ref.kind);
    if (store === undefined) throw new Error(`no GcStore registered for kind ${ref.kind}`);
    return store;
  }

  getNode(ref: GcRef) {
    return this.route(ref).getNode(ref);
  }

  async listPendingDeletion(): Promise<readonly GcNode[]> {
    const out: GcNode[] = [];
    for (const store of this.byKind.values()) out.push(...(await store.listPendingDeletion()));
    return out;
  }

  async listOwnedBy(ownerUid: string): Promise<readonly GcNode[]> {
    const out: GcNode[] = [];
    for (const store of this.byKind.values()) out.push(...(await store.listOwnedBy(ownerUid)));
    return out;
  }

  setDeletionTimestamp(ref: GcRef, ts: string, opts?: CasOpts) {
    return this.route(ref).setDeletionTimestamp(ref, ts, opts);
  }
  removeOwnerRef(ref: GcRef, ownerUid: string, opts?: CasOpts) {
    return this.route(ref).removeOwnerRef(ref, ownerUid, opts);
  }
  removeFinalizer(ref: GcRef, finalizer: string, opts?: CasOpts) {
    return this.route(ref).removeFinalizer(ref, finalizer, opts);
  }
  reap(ref: GcRef, opts?: CasOpts) {
    return this.route(ref).reap(ref, opts);
  }
}
```

- [ ] **Step 2: Write the failing integration test**

Create `src/core/agent-task-gc-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentTaskSpecRecord } from "./agent-task.js";
import { expectOk } from "./cas.js";
import { GarbageCollector } from "./garbage-collector.js";
import { InMemoryGcStore } from "./in-memory-gc-store.js";
import { KindFinalizer, PropagationFinalizer } from "./lifecycle-metadata.js";
import type { GcRef } from "./owner-graph.js";
import { AgentTaskGcStore, CompositeGcStore } from "./agent-task-gc-store.js";
import { createSqliteStores } from "../local/sqlite-store.js";

function spec(id: string, over: Partial<AgentTaskSpecRecord> = {}): AgentTaskSpecRecord {
  return {
    id,
    worktree: "/wt",
    runtime: "claude",
    role: "coder",
    prompt: "go",
    dependsOn: [],
    generation: 1,
    createdAt: "2026-06-08T00:00:00.000Z",
    ...over,
  };
}

async function drain(gc: GarbageCollector, refs: GcRef[], probe: () => Promise<readonly GcRef[]>) {
  for (let pass = 0; pass < 50; pass += 1) {
    const dynamic = await probe();
    const all = new Map<string, GcRef>();
    for (const r of [...refs, ...dynamic]) all.set(`${r.kind}:${r.id}`, r);
    for (const ref of all.values()) await gc.reconcileNode(ref);
  }
}

describe("AgentTaskGcStore over real Sqlite", () => {
  test("pending-review finalizer blocks reap until removed", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      const store = new AgentTaskGcStore(stores.agentTaskStore);
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("at-1", { finalizers: [KindFinalizer.PendingReview] }),
        ),
      );
      expectOk(await stores.agentTaskStore.setAgentTaskDeletion("at-1", "2026-06-08T01:00:00.000Z"));

      const gc = new GarbageCollector({ store, now: () => Date.parse("2026-06-08T02:00:00.000Z") });
      const ref: GcRef = { kind: "agentTask", id: "at-1" };
      await drain(gc, [ref], async () => []);
      expect(await store.getNode(ref)).toBeDefined(); // blocked

      await store.removeFinalizer(ref, KindFinalizer.PendingReview);
      await drain(gc, [ref], async () => []);
      expect(await store.getNode(ref)).toBeUndefined(); // reaped
    } finally {
      stores.close();
    }
  });

  test("Foreground cascade: delete TaskGroup reaps real AgentTask children", async () => {
    const stores = createSqliteStores(":memory:");
    try {
      // TaskGroup owner lives in-memory; AgentTask children live in Sqlite.
      const tgStore = new InMemoryGcStore();
      tgStore.put({
        kind: "taskGroup",
        id: "tg",
        uid: "u-tg",
        ownerRefs: [],
        finalizers: [PropagationFinalizer.Foreground],
        deletionTimestamp: "2026-06-08T00:00:00.000Z",
      });
      expectOk(
        await stores.agentTaskStore.putAgentTaskSpec(
          spec("at-c", {
            ownerRef: { kind: "taskGroup", id: "tg", uid: "u-tg", controller: true },
          }),
        ),
      );

      const composite = new CompositeGcStore(
        new Map([
          ["taskGroup", tgStore],
          ["agentTask", new AgentTaskGcStore(stores.agentTaskStore)],
        ]),
      );
      const gc = new GarbageCollector({
        store: composite,
        now: () => Date.parse("2026-06-08T03:00:00.000Z"),
      });

      const tg: GcRef = { kind: "taskGroup", id: "tg" };
      const child: GcRef = { kind: "agentTask", id: "at-c" };
      await drain(gc, [tg, child], async () =>
        (await composite.listPendingDeletion()).map((n) => ({ kind: n.kind, id: n.id })),
      );

      expect(await stores.agentTaskStore.getAgentTask("at-c")).toBeUndefined(); // child reaped
      expect(tgStore.has(tg)).toBe(false); // owner reaped
    } finally {
      stores.close();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails (then passes)**

Run: `bun test src/core/agent-task-gc-store.test.ts`
Expected: FAIL first (module missing), then PASS after Step 1 is in place. If the Foreground cascade test stalls, confirm `CompositeGcStore.listOwnedBy` fans across BOTH kinds so the TaskGroup's AgentTask child is discovered by `u-tg`.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-task-gc-store.ts src/core/agent-task-gc-store.test.ts
git commit --no-verify -m "feat(#306): AgentTaskGcStore + CompositeGcStore; real-store cascade integration"
```

---

## Task 7: Exports + server wiring

**Files:**
- Modify: `src/core/index.ts`
- Create: `src/server/garbage-collector-wiring.ts`
- Test: `src/server/garbage-collector-wiring.test.ts`

- [ ] **Step 1: Add core exports**

In `src/core/index.ts`, add these near the other `export ... from` lines (the import-ordering lint sorts them; run biome fix in Step 5). Update the existing `lifecycle-metadata` export line and add the new modules:

```ts
export type {
  CascadePolicy,
  KindFinalizer,
  OwnerRef,
  PropagationFinalizer,
  SessionFinalizer,
} from "./lifecycle-metadata.js";
export { KindFinalizer, PropagationFinalizer } from "./lifecycle-metadata.js";
export type { GcAction, GcNode, GcRef } from "./owner-graph.js";
export { planDanglingChild, planOwnerDeletion, policyOf, refOf } from "./owner-graph.js";
export type { GarbageCollectorOptions, GcStore } from "./garbage-collector.js";
export { GarbageCollector, gcKey, parseGcKey } from "./garbage-collector.js";
export { InMemoryGcStore } from "./in-memory-gc-store.js";
export { AgentTaskGcStore, CompositeGcStore } from "./agent-task-gc-store.js";
```

Note: `KindFinalizer` and `PropagationFinalizer` are exported both as a type and a value (const + derived type sharing the name) — mirror the existing `Finalizer` dual export pattern already in `lifecycle-metadata.ts`. If the existing line only re-exports `OwnerRef`/`SessionFinalizer` as types, keep that and add the value re-export as a separate `export { ... }` line as shown.

- [ ] **Step 2: Write the failing wiring test**

Create `src/server/garbage-collector-wiring.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GarbageCollector } from "../core/garbage-collector.js";
import { InMemoryGcStore } from "../core/in-memory-gc-store.js";
import {
  createGarbageCollectorWiring,
  garbageCollectorEnabled,
} from "./garbage-collector-wiring.js";

describe("garbage-collector-wiring", () => {
  test("enabled by default, disabled by GROVE_GC=0", () => {
    expect(garbageCollectorEnabled({})).toBe(true);
    expect(garbageCollectorEnabled({ GROVE_GC: "0" })).toBe(false);
    expect(garbageCollectorEnabled({ GROVE_GC: "1" })).toBe(true);
  });

  test("constructs a GarbageCollector over the supplied store", () => {
    const wiring = createGarbageCollectorWiring({ store: new InMemoryGcStore(), workerCount: 2 });
    expect(wiring.collector).toBeInstanceOf(GarbageCollector);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/server/garbage-collector-wiring.test.ts`
Expected: FAIL — module `./garbage-collector-wiring.js` not found.

- [ ] **Step 4: Implement the wiring**

Create `src/server/garbage-collector-wiring.ts`:

```ts
import { GarbageCollector, type GcStore } from "../core/garbage-collector.js";

export function garbageCollectorEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.GROVE_GC !== "0";
}

export interface GarbageCollectorWiringOptions {
  readonly store: GcStore;
  readonly workerCount?: number | undefined;
  readonly resyncIntervalMs?: number | undefined;
  readonly onError?: ((error: unknown, key: string) => void) | undefined;
}

export interface GarbageCollectorWiring {
  readonly collector: GarbageCollector;
}

export function createGarbageCollectorWiring(
  options: GarbageCollectorWiringOptions,
): GarbageCollectorWiring {
  const collector = new GarbageCollector({
    store: options.store,
    workerCount: options.workerCount,
    resyncIntervalMs: options.resyncIntervalMs,
    onError: options.onError,
  });
  return { collector };
}
```

(Live activation in `serve.ts` — constructing a `CompositeGcStore` from the server's real stores and calling `collector.start()` — is deferred with TaskGroup persistence, per the spec. This module + its test are the seam.)

- [ ] **Step 5: Run tests + biome + typecheck**

Run: `bun test src/server/garbage-collector-wiring.test.ts`
Expected: PASS.

Run: `bunx @biomejs/biome check --write src/core/index.ts src/server/garbage-collector-wiring.ts`
Expected: import ordering normalized, no errors. (Targeted biome only — do NOT run repo-wide biome in a worktree; it hangs.)

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/index.ts src/server/garbage-collector-wiring.ts src/server/garbage-collector-wiring.test.ts
git commit --no-verify -m "feat(#306): export GC surface + server garbage-collector wiring seam"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test --timeout 60000`
Expected: PASS — all pre-existing tests plus the new GC tests. If a pre-existing `AgentTaskStore` mock/fake elsewhere fails to compile because it lacks the four new methods, add the four signatures to it (the interface grew). Search: `grep -rl "implements AgentTaskStore" src tests`.

- [ ] **Step 2: Typecheck the whole project**

Run: `bunx tsc --noEmit`
Expected: PASS (0 errors). This is the `erasableSyntaxOnly` gate that `bun test` does NOT enforce — it must pass before push.

- [ ] **Step 3: Targeted biome on all changed files**

Run: `git diff --name-only main...HEAD -- '*.ts' | xargs bunx @biomejs/biome check --write`
Expected: no remaining diagnostics. Re-stage any files biome rewrote.

- [ ] **Step 4: Confirm acceptance criteria are demonstrated**

Verify by re-reading the passing tests:
- **Delete TaskGroup → children cascade** — `garbage-collector.test.ts` (Foreground + Background) and `agent-task-gc-store.test.ts` (Foreground over real Sqlite).
- **Finalizer blocks deletion until removed** — `garbage-collector.test.ts` (in-memory) + `agent-task-gc-store.test.ts` (real Sqlite, `pending-review`). `MergeTask`/`pending-merge` is the documented follow-up.
- **Orphan preserves children** — `garbage-collector.test.ts` (Orphan: child kept, ownerRef stripped, not marked).

- [ ] **Step 5: Final commit (if biome restaged anything)**

```bash
git add -A
git commit --no-verify -m "chore(#306): biome + final verification pass"
```

---

## Deviations from the committed spec

Two conscious simplifications vs `docs/superpowers/specs/2026-06-08-...-design.md`, both keeping the acceptance criteria intact:

1. **No standalone `src/core/task-group.ts`.** The spec listed a minimal TaskGroup type + in-memory store. Since `GcNode` already models any lifecycle entity by `kind`, TaskGroup is represented as a `GcNode` of `kind: "taskGroup"` held in `InMemoryGcStore`. This is the "in-memory store as top-level owner" the spec asked for, without a redundant dedicated type. A real `TaskGroup` entity + persistence remains the deferred follow-up.
2. **`Terminating` condition emission is deferred.** The spec mentioned the GC setting a `Terminating` condition (mirroring `claim-controller`). That requires writing to the AgentTask **status** row (conditions live there, not on the spec lifecycle fields the GC owns), expanding the `GcStore` surface. None of the issue's acceptance criteria require it, so it is moved to the follow-up. The GC's observable signal in this issue is the `deletionTimestamp` + finalizer state on the spec row.

## Notes for the implementer

- **Worktree hazards** (from project memory): repo-wide biome and the pre-commit lefthook hook HANG in worktrees. Use targeted biome on changed files only and `git commit --no-verify`. A fresh worktree may need `bun install` before `build` succeeds (not required for `bun test`/`tsc`).
- **CAS pattern**: every store mutator compares `opts.ifMatch` against the spec `resource_version` and bumps it on write. The loop's `withIfMatch` reads the node's `resourceVersion`, so the value the store compares MUST equal `GcNode.resourceVersion` (the spec RV for AgentTask). Keep these consistent or CAS retries will livelock.
- **Idempotency is the invariant**: every plan function returns `[]` on a converged snapshot. If a test loops without terminating, a plan is emitting an action that doesn't change state — fix the plan, not the loop bound.
- **Do not** wire `collector.start()` into `serve.ts` in this issue; TaskGroup has no persistence yet, so a live GC would have no real owners to act on. The wiring seam (Task 7) is the handoff point for the follow-up.
