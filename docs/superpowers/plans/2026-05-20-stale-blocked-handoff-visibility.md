# Stale Blocked Handoff Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add health-aware operator visibility and actions for stale, blocked, overdue, and failed handoffs.

**Architecture:** Keep `pending`, `overdue`, and `blocked` as derived operator states from durable handoff status plus optional health signals. Add durable terminal statuses only for explicit operator outcomes (`cancelled`, `manually_resolved`). Share a pure projection module between server boardroom routes and TUI rendering.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, bun:test, Hono routes, React/OpenTUI TUI components, SQLite and Nexus handoff stores.

---

## File Structure

- Create `src/core/handoff-operator-state.ts`: pure operator projection, health signal helpers, action affordances, and summary counts.
- Create `src/core/handoff-operator-state.test.ts`: TDD tests for projection rules, health precedence, action affordances, and counts.
- Modify `src/core/handoff.ts`: add durable terminal statuses and store methods for operator terminal actions.
- Modify `src/core/handoff-state-machine.test.ts`: lock terminal transitions for `cancelled` and `manually_resolved`.
- Modify `src/core/handoff-store.conformance.ts`: require store implementations to persist the new terminal transitions.
- Modify `src/core/operations/test-helpers.ts`: update mock handoff store with new required methods.
- Modify `src/core/index.ts`: export the projection module.
- Modify `src/core/in-memory-handoff-store.ts`, `src/local/sqlite-handoff-store.ts`, and `src/nexus/nexus-handoff-store.ts`: implement terminal metadata and methods.
- Modify `src/server/routes/handoffs.ts`: add operator action endpoints for cancel, manual resolve, resend, and reroute.
- Modify `tests/server/routes-extended.test.ts`: route tests for the new handoff action endpoints.
- Modify `src/server/routes/boardroom.ts`: add handoff operator summary.
- Modify `tests/server/boardroom.test.ts`: summary tests for pending, overdue, blocked, and dead-lettered handoffs.
- Modify `src/tui/provider.ts`, `src/tui/store-backed-provider.ts`, and `src/tui/remote-provider.ts`: expose operator action provider methods.
- Modify `src/tui/views/handoffs-view.tsx` and `src/tui/views/handoffs-view.test.tsx`: render projected states, reasons, and actions.
- Modify `src/tui/screens/running-view.tsx` and `src/tui/screens/running-view-handoffs.test.ts`: pass runtime/task health signals into the handoff panel.

## Task 1: Durable Operator Terminal Statuses

**Files:**
- Modify: `src/core/handoff.ts`
- Modify: `src/core/handoff-state-machine.test.ts`
- Modify: `src/core/handoff-store.conformance.ts`
- Modify: `src/core/operations/test-helpers.ts`
- Modify: `src/core/in-memory-handoff-store.ts`
- Modify: `src/local/sqlite-handoff-store.ts`
- Modify: `src/nexus/nexus-handoff-store.ts`

- [ ] **Step 1: Write failing state-machine tests**

Add these cases to `src/core/handoff-state-machine.test.ts`.

```ts
const {
  PendingPickup,
  Delivered,
  Processed,
  Replied,
  Expired,
  DeadLettered,
  Cancelled,
  ManuallyResolved,
} = HandoffStatus;

test("unresolved and failed handoffs can be cancelled by an operator", () => {
  expect(canTransition(PendingPickup, Cancelled)).toBe(true);
  expect(canTransition(Delivered, Cancelled)).toBe(true);
  expect(canTransition(Processed, Cancelled)).toBe(true);
  expect(canTransition(Expired, Cancelled)).toBe(true);
  expect(canTransition(DeadLettered, Cancelled)).toBe(true);
});

test("unresolved and failed handoffs can be manually resolved by an operator", () => {
  expect(canTransition(PendingPickup, ManuallyResolved)).toBe(true);
  expect(canTransition(Delivered, ManuallyResolved)).toBe(true);
  expect(canTransition(Processed, ManuallyResolved)).toBe(true);
  expect(canTransition(Expired, ManuallyResolved)).toBe(true);
  expect(canTransition(DeadLettered, ManuallyResolved)).toBe(true);
});

test("cancelled is terminal", () => {
  expect(canTransition(Cancelled, PendingPickup)).toBe(false);
  expect(canTransition(Cancelled, Delivered)).toBe(false);
  expect(canTransition(Cancelled, Processed)).toBe(false);
  expect(canTransition(Cancelled, Replied)).toBe(false);
  expect(canTransition(Cancelled, Expired)).toBe(false);
  expect(canTransition(Cancelled, DeadLettered)).toBe(false);
  expect(canTransition(Cancelled, ManuallyResolved)).toBe(false);
});

test("manually_resolved is terminal", () => {
  expect(canTransition(ManuallyResolved, PendingPickup)).toBe(false);
  expect(canTransition(ManuallyResolved, Delivered)).toBe(false);
  expect(canTransition(ManuallyResolved, Processed)).toBe(false);
  expect(canTransition(ManuallyResolved, Replied)).toBe(false);
  expect(canTransition(ManuallyResolved, Expired)).toBe(false);
  expect(canTransition(ManuallyResolved, DeadLettered)).toBe(false);
  expect(canTransition(ManuallyResolved, Cancelled)).toBe(false);
});
```

Update the existing `expired is terminal` test so it asserts `expired -> cancelled` and `expired -> manually_resolved` are valid and all other outgoing transitions remain invalid. Update the existing `dead_lettered is terminal` test so it asserts `dead_lettered -> cancelled` and `dead_lettered -> manually_resolved` are valid and all other outgoing transitions remain invalid. Update the enum-value test to assert 8 values and the two new strings.

- [ ] **Step 2: Run state-machine tests to verify RED**

Run:

```bash
bun test src/core/handoff-state-machine.test.ts
```

Expected: FAIL because `HandoffStatus.Cancelled` and `HandoffStatus.ManuallyResolved` do not exist.

- [ ] **Step 3: Write failing store conformance tests**

Add these tests to `src/core/handoff-store.conformance.ts` after the existing dead-letter/expiry transition tests.

```ts
test("markCancelled transitions unresolved handoff to cancelled with terminal metadata", async () => {
  const h = await store.create(makeHandoffInput());

  await store.markCancelled(h.handoffId, {
    terminalReason: "operator cancelled",
    replacementHandoffId: "handoff-replacement",
  });

  const updated = await store.get(h.handoffId);
  expect(updated?.status).toBe(HandoffStatus.Cancelled);
  expect(updated?.terminalReason).toBe("operator cancelled");
  expect(updated?.replacementHandoffId).toBe("handoff-replacement");
});

test("markManuallyResolved transitions expired handoff to manually_resolved", async () => {
  const pastDeadline = new Date(Date.now() - 60_000).toISOString();
  const h = await store.create(makeHandoffInput({ replyDueAt: pastDeadline }));
  await store.expireStale();

  await store.markManuallyResolved(h.handoffId, { terminalReason: "operator handled offline" });

  const updated = await store.get(h.handoffId);
  expect(updated?.status).toBe(HandoffStatus.ManuallyResolved);
  expect(updated?.terminalReason).toBe("operator handled offline");
});

test("markCancelled transitions dead-lettered handoff to cancelled", async () => {
  const h = await store.create(makeHandoffInput());
  await store.markDeadLettered(h.handoffId);

  await store.markCancelled(h.handoffId, { terminalReason: "operator retrying elsewhere" });

  const updated = await store.get(h.handoffId);
  expect(updated?.status).toBe(HandoffStatus.Cancelled);
  expect(updated?.terminalReason).toBe("operator retrying elsewhere");
});

test("markCancelled on replied handoff throws InvalidTransitionError", async () => {
  const h = await store.create(makeHandoffInput());
  await store.markDelivered(h.handoffId);
  await store.markReplied(h.handoffId, "blake3:reply");

  await expect(store.markCancelled(h.handoffId)).rejects.toThrow(InvalidTransitionError);
});
```

- [ ] **Step 4: Run conformance tests to verify RED**

Run:

```bash
bun test src/core/in-memory-handoff-store.conformance.test.ts
```

Expected: FAIL because `markCancelled`, `markManuallyResolved`, and the new Handoff fields do not exist.

- [ ] **Step 5: Implement core status, metadata, and interface changes**

In `src/core/handoff.ts`, update status and transitions:

```ts
export const HandoffStatus = {
  PendingPickup: "pending_pickup",
  Delivered: "delivered",
  Processed: "processed",
  Replied: "replied",
  Expired: "expired",
  DeadLettered: "dead_lettered",
  Cancelled: "cancelled",
  ManuallyResolved: "manually_resolved",
} as const;

export interface HandoffTerminalMetadata {
  readonly terminalReason?: string | undefined;
  readonly replacementHandoffId?: string | undefined;
}
```

Extend `VALID_TRANSITIONS`:

```ts
[HandoffStatus.PendingPickup]: [
  HandoffStatus.Delivered,
  HandoffStatus.Expired,
  HandoffStatus.DeadLettered,
  HandoffStatus.Cancelled,
  HandoffStatus.ManuallyResolved,
],
[HandoffStatus.Delivered]: [
  HandoffStatus.Processed,
  HandoffStatus.Replied,
  HandoffStatus.Expired,
  HandoffStatus.DeadLettered,
  HandoffStatus.Cancelled,
  HandoffStatus.ManuallyResolved,
],
[HandoffStatus.Processed]: [
  HandoffStatus.Replied,
  HandoffStatus.Expired,
  HandoffStatus.Cancelled,
  HandoffStatus.ManuallyResolved,
],
[HandoffStatus.Expired]: [HandoffStatus.Cancelled, HandoffStatus.ManuallyResolved],
[HandoffStatus.DeadLettered]: [HandoffStatus.Cancelled, HandoffStatus.ManuallyResolved],
[HandoffStatus.Cancelled]: [],
[HandoffStatus.ManuallyResolved]: [],
```

Add fields to `Handoff`:

```ts
readonly terminalReason?: string | undefined;
readonly replacementHandoffId?: string | undefined;
```

Add methods to `HandoffStore`:

```ts
markCancelled(id: string, metadata?: HandoffTerminalMetadata): Promise<void>;
markManuallyResolved(id: string, metadata?: HandoffTerminalMetadata): Promise<void>;
```

- [ ] **Step 6: Implement in-memory store methods**

In `src/core/in-memory-handoff-store.ts`, import `HandoffTerminalMetadata` and add:

```ts
async markCancelled(id: string, metadata?: HandoffTerminalMetadata): Promise<void> {
  const handoff = this.handoffs.get(id);
  if (handoff === undefined) {
    throw new NotFoundError({ resource: "Handoff", identifier: id });
  }
  validateTransition(id, handoff.status, HandoffStatus.Cancelled);
  this.handoffs.set(id, {
    ...handoff,
    status: HandoffStatus.Cancelled,
    ...(metadata?.terminalReason !== undefined ? { terminalReason: metadata.terminalReason } : {}),
    ...(metadata?.replacementHandoffId !== undefined
      ? { replacementHandoffId: metadata.replacementHandoffId }
      : {}),
  });
}

async markManuallyResolved(id: string, metadata?: HandoffTerminalMetadata): Promise<void> {
  const handoff = this.handoffs.get(id);
  if (handoff === undefined) {
    throw new NotFoundError({ resource: "Handoff", identifier: id });
  }
  validateTransition(id, handoff.status, HandoffStatus.ManuallyResolved);
  this.handoffs.set(id, {
    ...handoff,
    status: HandoffStatus.ManuallyResolved,
    ...(metadata?.terminalReason !== undefined ? { terminalReason: metadata.terminalReason } : {}),
    ...(metadata?.replacementHandoffId !== undefined
      ? { replacementHandoffId: metadata.replacementHandoffId }
      : {}),
  });
}
```

- [ ] **Step 7: Implement SQLite persistence**

In `src/local/sqlite-handoff-store.ts`:

Add columns to `HANDOFF_DDL`:

```sql
terminal_reason TEXT,
replacement_handoff_id TEXT,
```

Add fields to `HandoffRow`, `SELECT_COLS`, `rowToHandoff`, and constructor migration:

```ts
if (!columns.includes("terminal_reason")) this.safeAddColumn("terminal_reason");
if (!columns.includes("replacement_handoff_id")) this.safeAddColumn("replacement_handoff_id");
```

Update `insertSync` so new rows insert `null` for both terminal metadata columns until an operator terminal action sets them.

Add a private helper:

```ts
private metadataParams(metadata?: HandoffTerminalMetadata): readonly (string | null)[] {
  return [metadata?.terminalReason ?? null, metadata?.replacementHandoffId ?? null];
}
```

Add `markCancelled` and `markManuallyResolved` as conditional updates using the same scope and claim fragments as `markDeadLettered`. The `WHERE status IN (...)` sets must match the transition table:

```ts
WHERE handoff_id = ? AND status IN (?, ?, ?, ?, ?)${scopeExtra}
```

for cancelled, and:

```ts
WHERE handoff_id = ? AND status IN (?, ?, ?, ?, ?)${scopeExtra}
```

for manually resolved.

- [ ] **Step 8: Implement Nexus persistence**

In `src/nexus/nexus-handoff-store.ts`, add methods:

```ts
async markCancelled(
  handoffId: string,
  metadata?: import("../core/handoff.js").HandoffTerminalMetadata,
): Promise<void> {
  await this.updateHandoff(handoffId, (h) => {
    validateTransition(handoffId, h.status, HandoffStatus.Cancelled);
    return {
      ...h,
      status: HandoffStatus.Cancelled,
      ...(metadata?.terminalReason !== undefined ? { terminalReason: metadata.terminalReason } : {}),
      ...(metadata?.replacementHandoffId !== undefined
        ? { replacementHandoffId: metadata.replacementHandoffId }
        : {}),
    };
  });
}

async markManuallyResolved(
  handoffId: string,
  metadata?: import("../core/handoff.js").HandoffTerminalMetadata,
): Promise<void> {
  await this.updateHandoff(handoffId, (h) => {
    validateTransition(handoffId, h.status, HandoffStatus.ManuallyResolved);
    return {
      ...h,
      status: HandoffStatus.ManuallyResolved,
      ...(metadata?.terminalReason !== undefined ? { terminalReason: metadata.terminalReason } : {}),
      ...(metadata?.replacementHandoffId !== undefined
        ? { replacementHandoffId: metadata.replacementHandoffId }
        : {}),
    };
  });
}
```

- [ ] **Step 9: Update mock store factory**

In `src/core/operations/test-helpers.ts`, add defaults:

```ts
markCancelled: async () => undefined,
markManuallyResolved: async () => undefined,
```

- [ ] **Step 10: Run focused tests to verify GREEN**

Run:

```bash
bun test src/core/handoff-state-machine.test.ts src/core/in-memory-handoff-store.conformance.test.ts src/local/sqlite-handoff-store.conformance.test.ts src/nexus/nexus-handoff-store.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 1**

```bash
git add src/core/handoff.ts src/core/handoff-state-machine.test.ts src/core/handoff-store.conformance.ts src/core/operations/test-helpers.ts src/core/in-memory-handoff-store.ts src/local/sqlite-handoff-store.ts src/nexus/nexus-handoff-store.ts
git commit -m "feat: add operator terminal handoff states"
```

## Task 2: Shared Handoff Operator Projection

**Files:**
- Create: `src/core/handoff-operator-state.ts`
- Create: `src/core/handoff-operator-state.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing projection tests**

Create `src/core/handoff-operator-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type Handoff, HandoffStatus } from "./handoff.js";
import {
  HandoffOperatorAction,
  HandoffOperatorState,
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
} from "./handoff-operator-state.js";

function handoff(overrides?: Partial<Handoff>): Handoff {
  return {
    handoffId: "handoff-1",
    sourceCid: "blake3:source",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.PendingPickup,
    requiresReply: true,
    createdAt: "2026-05-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("deriveHandoffOperatorProjection", () => {
  test("pending unresolved handoff projects to pending", () => {
    const projection = deriveHandoffOperatorProjection(handoff(), {
      now: "2026-05-20T10:01:00.000Z",
    });
    expect(projection.state).toBe(HandoffOperatorState.Pending);
    expect(projection.reason).toBe("waiting for target role");
  });

  test("past unresolved deadline projects to overdue", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({ replyDueAt: "2026-05-20T10:00:30.000Z" }),
      { now: "2026-05-20T10:01:00.000Z" },
    );
    expect(projection.state).toBe(HandoffOperatorState.Overdue);
    expect(projection.reason).toBe("deadline passed");
  });

  test("unhealthy target projects unresolved handoff to blocked", () => {
    const projection = deriveHandoffOperatorProjection(handoff(), {
      healthSignals: [{ role: "reviewer", healthy: false, reason: "agent task failed" }],
      now: "2026-05-20T10:01:00.000Z",
    });
    expect(projection.state).toBe(HandoffOperatorState.Blocked);
    expect(projection.reason).toBe("agent task failed");
  });

  test("dead_lettered wins over health and deadline", () => {
    const projection = deriveHandoffOperatorProjection(
      handoff({
        status: HandoffStatus.DeadLettered,
        replyDueAt: "2026-05-20T10:00:30.000Z",
      }),
      {
        healthSignals: [{ role: "reviewer", healthy: false, reason: "agent task failed" }],
        now: "2026-05-20T10:01:00.000Z",
      },
    );
    expect(projection.state).toBe(HandoffOperatorState.DeadLettered);
    expect(projection.reason).toBe("delivery failed");
  });

  test("terminal statuses project to final operator states", () => {
    expect(
      deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.Replied })).state,
    ).toBe(HandoffOperatorState.Resolved);
    expect(
      deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.Cancelled })).state,
    ).toBe(HandoffOperatorState.Cancelled);
    expect(
      deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.ManuallyResolved })).state,
    ).toBe(HandoffOperatorState.ManuallyResolved);
  });

  test("blocked and dead-lettered projections expose action affordances", () => {
    const blocked = deriveHandoffOperatorProjection(handoff(), {
      healthSignals: [{ role: "reviewer", healthy: false, reason: "target session missing" }],
    });
    expect(blocked.actions).toContain(HandoffOperatorAction.Resend);
    expect(blocked.actions).toContain(HandoffOperatorAction.Reroute);
    expect(blocked.actions).toContain(HandoffOperatorAction.Cancel);
    expect(blocked.actions).toContain(HandoffOperatorAction.ManualResolve);

    const dead = deriveHandoffOperatorProjection(handoff({ status: HandoffStatus.DeadLettered }));
    expect(dead.actions).toContain(HandoffOperatorAction.Resend);
    expect(dead.actions).toContain(HandoffOperatorAction.Reroute);
    expect(dead.actions).toContain(HandoffOperatorAction.ManualResolve);
  });
});

describe("countHandoffOperatorStates", () => {
  test("counts pending, overdue, blocked, and dead-lettered states", () => {
    const counts = countHandoffOperatorStates([
      deriveHandoffOperatorProjection(handoff({ handoffId: "p" })),
      deriveHandoffOperatorProjection(
        handoff({ handoffId: "o", replyDueAt: "2026-05-20T10:00:00.000Z" }),
        { now: "2026-05-20T10:01:00.000Z" },
      ),
      deriveHandoffOperatorProjection(handoff({ handoffId: "b" }), {
        healthSignals: [{ role: "reviewer", healthy: false, reason: "missing" }],
      }),
      deriveHandoffOperatorProjection(
        handoff({ handoffId: "d", status: HandoffStatus.DeadLettered }),
      ),
    ]);

    expect(counts.pending).toBe(1);
    expect(counts.overdue).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.deadLettered).toBe(1);
  });
});
```

- [ ] **Step 2: Run projection tests to verify RED**

Run:

```bash
bun test src/core/handoff-operator-state.test.ts
```

Expected: FAIL because `src/core/handoff-operator-state.ts` does not exist.

- [ ] **Step 3: Implement the projection module**

Create `src/core/handoff-operator-state.ts`:

```ts
import { AgentTaskConditionType, AgentTaskPhase, type AgentTaskView } from "./agent-task.js";
import { type Handoff, HandoffStatus } from "./handoff.js";

export const HandoffOperatorState = {
  Pending: "pending",
  Overdue: "overdue",
  Blocked: "blocked",
  DeadLettered: "dead_lettered",
  Resolved: "resolved",
  Cancelled: "cancelled",
  ManuallyResolved: "manually_resolved",
} as const;
export type HandoffOperatorState =
  (typeof HandoffOperatorState)[keyof typeof HandoffOperatorState];

export const HandoffOperatorAction = {
  Resend: "resend",
  Reroute: "reroute",
  Cancel: "cancel",
  ManualResolve: "manual_resolve",
} as const;
export type HandoffOperatorAction =
  (typeof HandoffOperatorAction)[keyof typeof HandoffOperatorAction];

export interface HandoffHealthSignal {
  readonly role: string;
  readonly healthy: boolean;
  readonly reason: string;
}

export interface HandoffOperatorProjection {
  readonly handoff: Handoff;
  readonly state: HandoffOperatorState;
  readonly reason: string;
  readonly actions: readonly HandoffOperatorAction[];
}

export interface HandoffOperatorOptions {
  readonly now?: string | undefined;
  readonly healthSignals?: readonly HandoffHealthSignal[] | undefined;
}

const UNRESOLVED_STATUSES: ReadonlySet<HandoffStatus> = new Set([
  HandoffStatus.PendingPickup,
  HandoffStatus.Delivered,
  HandoffStatus.Processed,
]);

export function deriveHandoffOperatorProjection(
  handoff: Handoff,
  options?: HandoffOperatorOptions,
): HandoffOperatorProjection {
  const state = deriveState(handoff, options);
  return {
    handoff,
    state,
    reason: reasonFor(handoff, state, options),
    actions: actionsFor(state),
  };
}

function deriveState(handoff: Handoff, options?: HandoffOperatorOptions): HandoffOperatorState {
  if (handoff.status === HandoffStatus.DeadLettered) return HandoffOperatorState.DeadLettered;
  if (handoff.status === HandoffStatus.Replied) return HandoffOperatorState.Resolved;
  if (handoff.status === HandoffStatus.Cancelled) return HandoffOperatorState.Cancelled;
  if (handoff.status === HandoffStatus.ManuallyResolved) {
    return HandoffOperatorState.ManuallyResolved;
  }
  if (handoff.status === HandoffStatus.Expired) return HandoffOperatorState.Overdue;

  if (!UNRESOLVED_STATUSES.has(handoff.status)) return HandoffOperatorState.Pending;

  const unhealthy = unhealthySignalFor(handoff, options?.healthSignals);
  if (unhealthy !== undefined) return HandoffOperatorState.Blocked;

  if (handoff.replyDueAt !== undefined) {
    const nowMs = Date.parse(options?.now ?? new Date().toISOString());
    if (Date.parse(handoff.replyDueAt) <= nowMs) return HandoffOperatorState.Overdue;
  }

  return HandoffOperatorState.Pending;
}

function reasonFor(
  handoff: Handoff,
  state: HandoffOperatorState,
  options?: HandoffOperatorOptions,
): string {
  if (state === HandoffOperatorState.Blocked) {
    return unhealthySignalFor(handoff, options?.healthSignals)?.reason ?? "target unavailable";
  }
  if (state === HandoffOperatorState.Overdue) return "deadline passed";
  if (state === HandoffOperatorState.DeadLettered) return "delivery failed";
  if (state === HandoffOperatorState.Resolved) return "reply received";
  if (state === HandoffOperatorState.Cancelled) {
    return handoff.terminalReason ?? "operator cancelled";
  }
  if (state === HandoffOperatorState.ManuallyResolved) {
    return handoff.terminalReason ?? "operator resolved";
  }
  return "waiting for target role";
}

function unhealthySignalFor(
  handoff: Handoff,
  signals?: readonly HandoffHealthSignal[],
): HandoffHealthSignal | undefined {
  return signals?.find((signal) => signal.role === handoff.toRole && !signal.healthy);
}

function actionsFor(state: HandoffOperatorState): readonly HandoffOperatorAction[] {
  if (state === HandoffOperatorState.Blocked) {
    return [
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Reroute,
      HandoffOperatorAction.Cancel,
      HandoffOperatorAction.ManualResolve,
    ];
  }
  if (state === HandoffOperatorState.Overdue) {
    return [
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Cancel,
      HandoffOperatorAction.ManualResolve,
    ];
  }
  if (state === HandoffOperatorState.DeadLettered) {
    return [
      HandoffOperatorAction.Resend,
      HandoffOperatorAction.Reroute,
      HandoffOperatorAction.ManualResolve,
    ];
  }
  if (state === HandoffOperatorState.Pending) {
    return [HandoffOperatorAction.Resend, HandoffOperatorAction.Cancel];
  }
  return [];
}

export interface HandoffOperatorCounts {
  readonly pending: number;
  readonly overdue: number;
  readonly blocked: number;
  readonly deadLettered: number;
}

export function countHandoffOperatorStates(
  projections: readonly HandoffOperatorProjection[],
): HandoffOperatorCounts {
  return {
    pending: projections.filter((p) => p.state === HandoffOperatorState.Pending).length,
    overdue: projections.filter((p) => p.state === HandoffOperatorState.Overdue).length,
    blocked: projections.filter((p) => p.state === HandoffOperatorState.Blocked).length,
    deadLettered: projections.filter((p) => p.state === HandoffOperatorState.DeadLettered).length,
  };
}

export function healthSignalsFromAgentTasks(
  tasks: readonly AgentTaskView[],
): readonly HandoffHealthSignal[] {
  return tasks.flatMap((task) => {
    if (task.status.phase === AgentTaskPhase.Failed) {
      return [{ role: task.spec.role, healthy: false, reason: "agent task failed" }];
    }
    const badCondition = task.status.conditions.find(
      (condition) =>
        condition.status === "True" &&
        (condition.type === AgentTaskConditionType.Blocked ||
          condition.type === AgentTaskConditionType.Unschedulable ||
          condition.type === AgentTaskConditionType.Failed),
    );
    if (badCondition === undefined) return [];
    return [
      {
        role: task.spec.role,
        healthy: false,
        reason: badCondition.reason ?? badCondition.type,
      },
    ];
  });
}

export function healthSignalsFromAgentFailures(
  failures: ReadonlyMap<string, string> | undefined,
): readonly HandoffHealthSignal[] {
  if (failures === undefined) return [];
  return [...failures.entries()].map(([role, reason]) => ({
    role,
    healthy: false,
    reason,
  }));
}
```

- [ ] **Step 4: Export the projection module**

In `src/core/index.ts`, add:

```ts
export type {
  HandoffHealthSignal,
  HandoffOperatorCounts,
  HandoffOperatorOptions,
  HandoffOperatorProjection,
} from "./handoff-operator-state.js";
export {
  HandoffOperatorAction,
  HandoffOperatorState,
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  healthSignalsFromAgentFailures,
  healthSignalsFromAgentTasks,
} from "./handoff-operator-state.js";
```

- [ ] **Step 5: Run projection tests to verify GREEN**

Run:

```bash
bun test src/core/handoff-operator-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/core/handoff-operator-state.ts src/core/handoff-operator-state.test.ts src/core/index.ts
git commit -m "feat: derive operator handoff states"
```

## Task 3: Handoff Operator Action Endpoints

**Files:**
- Modify: `src/server/routes/handoffs.ts`
- Modify: `tests/server/routes-extended.test.ts`

- [ ] **Step 1: Write failing route tests**

In `tests/server/routes-extended.test.ts`, add tests under the `/api/handoffs` describe block:

```ts
test("POST /:id/cancel marks unresolved handoff cancelled", async () => {
  const handoff = await handoffStore.create({
    sourceCid: FAKE_CID,
    fromRole: "coder",
    toRole: "reviewer",
  });

  const res = await app.request(`/api/handoffs/${handoff.handoffId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify({ reason: "operator stopped waiting" }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; terminalReason?: string };
  expect(body.status).toBe(HandoffStatus.Cancelled);
  expect(body.terminalReason).toBe("operator stopped waiting");
});

test("POST /:id/manual-resolve marks dead-lettered handoff manually resolved", async () => {
  const handoff = await handoffStore.create({
    sourceCid: FAKE_CID,
    fromRole: "coder",
    toRole: "reviewer",
  });
  await handoffStore.markDeadLettered(handoff.handoffId);

  const res = await app.request(`/api/handoffs/${handoff.handoffId}/manual-resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify({ reason: "handled in terminal" }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; terminalReason?: string };
  expect(body.status).toBe(HandoffStatus.ManuallyResolved);
  expect(body.terminalReason).toBe("handled in terminal");
});

test("POST /:id/resend creates replacement handoff and cancels original", async () => {
  const handoff = await handoffStore.create({
    sourceCid: FAKE_CID,
    fromRole: "coder",
    toRole: "reviewer",
    requiresReply: true,
  });
  await handoffStore.markDeadLettered(handoff.handoffId);

  const res = await app.request(`/api/handoffs/${handoff.handoffId}/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify({ reason: "retry delivery" }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    original: { status: string; replacementHandoffId?: string };
    replacement: { handoffId: string; toRole: string; status: string };
  };
  expect(body.original.status).toBe(HandoffStatus.Cancelled);
  expect(body.original.replacementHandoffId).toBe(body.replacement.handoffId);
  expect(body.replacement.toRole).toBe("reviewer");
  expect(body.replacement.status).toBe(HandoffStatus.PendingPickup);
});

test("POST /:id/reroute creates replacement handoff for selected role", async () => {
  const handoff = await handoffStore.create({
    sourceCid: FAKE_CID,
    fromRole: "coder",
    toRole: "reviewer",
    requiresReply: true,
  });
  await handoffStore.markDeadLettered(handoff.handoffId);

  const res = await app.request(`/api/handoffs/${handoff.handoffId}/reroute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...TEST_AUTH_HEADERS },
    body: JSON.stringify({ toRole: "qa", reason: "reviewer unavailable" }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    original: { status: string; replacementHandoffId?: string };
    replacement: { handoffId: string; toRole: string };
  };
  expect(body.original.status).toBe(HandoffStatus.Cancelled);
  expect(body.replacement.toRole).toBe("qa");
});
```

- [ ] **Step 2: Run route tests to verify RED**

Run:

```bash
bun test tests/server/routes-extended.test.ts
```

Expected: FAIL with 404 for the new action endpoints.

- [ ] **Step 3: Add schemas and helper functions**

In `src/server/routes/handoffs.ts`, extend the status enum with:

```ts
HandoffStatusValue.Cancelled,
HandoffStatusValue.ManuallyResolved,
```

Add body schemas:

```ts
const terminalActionSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

const replacementActionSchema = terminalActionSchema.extend({
  replyDueAt: z.string().datetime().optional(),
});

const rerouteActionSchema = replacementActionSchema.extend({
  toRole: z.string().min(1),
});
```

Add helper:

```ts
async function parseOptionalJson(c: Context<ServerEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Add cancel and manual-resolve endpoints**

Add before `export { handoffs }`:

```ts
handoffs.post("/:id/cancel", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);
  const parsed = terminalActionSchema.safeParse(await parseOptionalJson(c));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }
  const id = c.req.param("id");
  await store.markCancelled(id, {
    terminalReason: parsed.data.reason ?? "operator cancelled",
  });
  const updated = await store.get(id);
  if (updated === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  return c.json(updated);
});

handoffs.post("/:id/manual-resolve", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);
  const parsed = terminalActionSchema.safeParse(await parseOptionalJson(c));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }
  const id = c.req.param("id");
  await store.markManuallyResolved(id, {
    terminalReason: parsed.data.reason ?? "operator resolved",
  });
  const updated = await store.get(id);
  if (updated === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  return c.json(updated);
});
```

- [ ] **Step 5: Add resend and reroute endpoints**

Add helper:

```ts
function replacementDueAt(original: { readonly replyDueAt?: string }, next?: string): string | undefined {
  if (next !== undefined) return next;
  if (original.replyDueAt === undefined) return undefined;
  return Date.parse(original.replyDueAt) > Date.now() ? original.replyDueAt : undefined;
}
```

Add endpoints:

```ts
handoffs.post("/:id/resend", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);
  const parsed = replacementActionSchema.safeParse(await parseOptionalJson(c));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }
  const id = c.req.param("id");
  const original = await store.get(id);
  if (original === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  const replacement = await store.create({
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: original.toRole,
    requiresReply: original.requiresReply,
    ...(replacementDueAt(original, parsed.data.replyDueAt) !== undefined
      ? { replyDueAt: replacementDueAt(original, parsed.data.replyDueAt) }
      : {}),
  });
  await store.markCancelled(id, {
    terminalReason: parsed.data.reason ?? "resent",
    replacementHandoffId: replacement.handoffId,
  });
  const updated = await store.get(id);
  return c.json({ original: updated, replacement });
});

handoffs.post("/:id/reroute", async (c) => {
  const store = resolveStore(c);
  if (store === undefined) return c.json({ error: "unreachable" }, 500);
  const parsed = rerouteActionSchema.safeParse(await parseOptionalJson(c));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", details: parsed.error.issues } }, 400);
  }
  const id = c.req.param("id");
  const original = await store.get(id);
  if (original === undefined) {
    return c.json({ error: { code: "NOT_FOUND", message: "Handoff not found" } }, 404);
  }
  const replacement = await store.create({
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: parsed.data.toRole,
    requiresReply: original.requiresReply,
    ...(replacementDueAt(original, parsed.data.replyDueAt) !== undefined
      ? { replyDueAt: replacementDueAt(original, parsed.data.replyDueAt) }
      : {}),
  });
  await store.markCancelled(id, {
    terminalReason: parsed.data.reason ?? `rerouted to ${parsed.data.toRole}`,
    replacementHandoffId: replacement.handoffId,
  });
  const updated = await store.get(id);
  return c.json({ original: updated, replacement });
});
```

- [ ] **Step 6: Run route tests to verify GREEN**

Run:

```bash
bun test tests/server/routes-extended.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/server/routes/handoffs.ts tests/server/routes-extended.test.ts
git commit -m "feat: add operator handoff action endpoints"
```

## Task 4: Boardroom Handoff Summary

**Files:**
- Modify: `src/server/routes/boardroom.ts`
- Modify: `tests/server/boardroom.test.ts`

- [ ] **Step 1: Write failing boardroom summary tests**

In `tests/server/boardroom.test.ts`, import `InMemoryHandoffStore`, `HandoffStatus`, `AgentTaskPhase`, and `createApp`. Add:

```ts
test("GET /api/boardroom/summary includes handoff operator counts", async () => {
  const ctx = await createTestContext();
  const handoffStore = new InMemoryHandoffStore();
  try {
    await handoffStore.create({
      sourceCid: "blake3:pending",
      fromRole: "coder",
      toRole: "reviewer",
    });
    await handoffStore.create({
      sourceCid: "blake3:overdue",
      fromRole: "coder",
      toRole: "reviewer",
      replyDueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const dead = await handoffStore.create({
      sourceCid: "blake3:dead",
      fromRole: "coder",
      toRole: "qa",
    });
    await handoffStore.markDeadLettered(dead.handoffId);

    const app = createApp(
      { ...ctx.deps, handoffStore },
      new Map([[TEST_KEY, TEST_NAMESPACE]]),
    );

    const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      handoffs: { pending: number; overdue: number; blocked: number; deadLettered: number };
    };
    expect(body.handoffs.pending).toBe(1);
    expect(body.handoffs.overdue).toBe(1);
    expect(body.handoffs.deadLettered).toBe(1);
  } finally {
    handoffStore.close();
    await ctx.cleanup();
  }
});

test("GET /api/boardroom/summary marks handoff blocked by failed agent task", async () => {
  const ctx = await createTestContext();
  const handoffStore = new InMemoryHandoffStore();
  try {
    await handoffStore.create({
      sourceCid: "blake3:blocked",
      fromRole: "coder",
      toRole: "reviewer",
    });
    await ctx.agentTaskStore.putAgentTaskSpec({
      id: "task-reviewer",
      role: "reviewer",
      runtime: "codex",
      worktree: "/tmp/reviewer",
      prompt: "review",
      dependsOn: [],
      generation: 1,
      createdAt: new Date().toISOString(),
    });
    await ctx.agentTaskStore.patchAgentTaskStatus("task-reviewer", {
      phase: AgentTaskPhase.Failed,
      conditions: [],
    });

    const app = createApp(
      { ...ctx.deps, handoffStore },
      new Map([[TEST_KEY, TEST_NAMESPACE]]),
    );

    const resp = await app.request("/api/boardroom/summary", { headers: TEST_AUTH_HEADERS });
    const body = (await resp.json()) as {
      handoffs: { blocked: number; items: readonly { state: string; reason: string }[] };
    };
    expect(body.handoffs.blocked).toBe(1);
    expect(body.handoffs.items[0]?.state).toBe("blocked");
    expect(body.handoffs.items[0]?.reason).toBe("agent task failed");
  } finally {
    handoffStore.close();
    await ctx.cleanup();
  }
});
```

- [ ] **Step 2: Run boardroom tests to verify RED**

Run:

```bash
bun test tests/server/boardroom.test.ts
```

Expected: FAIL because `body.handoffs` is absent.

- [ ] **Step 3: Implement boardroom summary projection**

In `src/server/routes/boardroom.ts`, import:

```ts
import {
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  healthSignalsFromAgentTasks,
  type HandoffOperatorProjection,
} from "../../core/handoff-operator-state.js";
import type { HandoffStore } from "../../core/handoff.js";
```

Extend `BoardroomSummary`:

```ts
readonly handoffs: {
  readonly pending: number;
  readonly overdue: number;
  readonly blocked: number;
  readonly deadLettered: number;
  readonly items: readonly HandoffOperatorProjection[];
};
```

Add helper:

```ts
function resolveHandoffStore(
  deps: import("../deps.js").ServerDeps,
  sessionId: string | undefined,
): HandoffStore | undefined {
  if (sessionId !== undefined && deps.handoffStoreForSession !== undefined) {
    return deps.handoffStoreForSession(sessionId) ?? deps.handoffStore;
  }
  return deps.handoffStore;
}
```

Inside `boardroom.get("/summary")`, before building `summary`, add:

```ts
const handoffStore = resolveHandoffStore(deps, sessionId);
const handoffs = handoffStore === undefined ? [] : await handoffStore.expireStale().then(() =>
  handoffStore.list({ limit: 200 }),
);
const taskSignals =
  deps.agentTaskStore === undefined
    ? []
    : healthSignalsFromAgentTasks(await deps.agentTaskStore.listAgentTasks());
const handoffProjections = handoffs.map((handoff) =>
  deriveHandoffOperatorProjection(handoff, { healthSignals: taskSignals }),
);
const handoffCounts = countHandoffOperatorStates(handoffProjections);
const handoffItems = handoffProjections.slice(0, 20);
```

Add to `summary`:

```ts
handoffs: {
  ...handoffCounts,
  items: handoffItems,
},
```

- [ ] **Step 4: Run boardroom tests to verify GREEN**

Run:

```bash
bun test tests/server/boardroom.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/server/routes/boardroom.ts tests/server/boardroom.test.ts
git commit -m "feat: expose handoff health in boardroom summary"
```

## Task 5: TUI Provider Operator Actions

**Files:**
- Modify: `src/tui/provider.ts`
- Modify: `src/tui/store-backed-provider.ts`
- Modify: `src/tui/remote-provider.ts`

- [ ] **Step 1: Write failing provider compile expectations**

Add method signatures to `src/tui/provider.ts` first so implementation files fail typecheck until they implement the methods:

```ts
cancelHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void>;
manualResolveHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void>;
resendHandoff(
  handoffId: string,
  options?: { readonly reason?: string; readonly replyDueAt?: string; readonly sessionId?: string },
): Promise<void>;
rerouteHandoff(
  handoffId: string,
  options: { readonly toRole: string; readonly reason?: string; readonly replyDueAt?: string; readonly sessionId?: string },
): Promise<void>;
```

- [ ] **Step 2: Run typecheck to verify RED**

Run:

```bash
bun run typecheck
```

Expected: FAIL because `StoreBackedProvider` and `RemoteDataProvider` no longer satisfy `TuiHandoffProvider`.

- [ ] **Step 3: Implement store-backed provider actions**

In `src/tui/store-backed-provider.ts`, add methods below `markHandoffDelivered`:

```ts
async cancelHandoff(handoffId: string, reason?: string): Promise<void> {
  await this.handoffs?.markCancelled(handoffId, {
    terminalReason: reason ?? "operator cancelled",
  });
}

async manualResolveHandoff(handoffId: string, reason?: string): Promise<void> {
  await this.handoffs?.markManuallyResolved(handoffId, {
    terminalReason: reason ?? "operator resolved",
  });
}

async resendHandoff(
  handoffId: string,
  options?: { readonly reason?: string; readonly replyDueAt?: string },
): Promise<void> {
  const original = await this.handoffs?.get(handoffId);
  if (this.handoffs === undefined || original === undefined) return;
  const replacement = await this.handoffs.create({
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: original.toRole,
    requiresReply: original.requiresReply,
    ...(options?.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
  });
  await this.handoffs.markCancelled(handoffId, {
    terminalReason: options?.reason ?? "resent",
    replacementHandoffId: replacement.handoffId,
  });
}

async rerouteHandoff(
  handoffId: string,
  options: { readonly toRole: string; readonly reason?: string; readonly replyDueAt?: string },
): Promise<void> {
  const original = await this.handoffs?.get(handoffId);
  if (this.handoffs === undefined || original === undefined) return;
  const replacement = await this.handoffs.create({
    sourceCid: original.sourceCid,
    fromRole: original.fromRole,
    toRole: options.toRole,
    requiresReply: original.requiresReply,
    ...(options.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
  });
  await this.handoffs.markCancelled(handoffId, {
    terminalReason: options.reason ?? `rerouted to ${options.toRole}`,
    replacementHandoffId: replacement.handoffId,
  });
}
```

- [ ] **Step 4: Implement remote provider actions**

In `src/tui/remote-provider.ts`, add helper:

```ts
private handoffActionUrl(
  handoffId: string,
  action: string,
  explicitSessionId?: string,
): string {
  const params = new URLSearchParams();
  const effective = explicitSessionId ?? this.activeSessionId;
  if (effective) params.set("sessionId", effective);
  const qs = params.toString();
  return `${this.baseUrl}/api/handoffs/${encodeURIComponent(handoffId)}/${action}${qs ? `?${qs}` : ""}`;
}
```

Add methods:

```ts
async cancelHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void> {
  await fetch(this.handoffActionUrl(handoffId, "cancel", sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...this.authHeaders },
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

async manualResolveHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void> {
  await fetch(this.handoffActionUrl(handoffId, "manual-resolve", sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...this.authHeaders },
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

async resendHandoff(
  handoffId: string,
  options?: { readonly reason?: string; readonly replyDueAt?: string; readonly sessionId?: string },
): Promise<void> {
  await fetch(this.handoffActionUrl(handoffId, "resend", options?.sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...this.authHeaders },
    body: JSON.stringify({
      ...(options?.reason !== undefined ? { reason: options.reason } : {}),
      ...(options?.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
    }),
  });
}

async rerouteHandoff(
  handoffId: string,
  options: { readonly toRole: string; readonly reason?: string; readonly replyDueAt?: string; readonly sessionId?: string },
): Promise<void> {
  await fetch(this.handoffActionUrl(handoffId, "reroute", options.sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...this.authHeaders },
    body: JSON.stringify({
      toRole: options.toRole,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
    }),
  });
}
```

- [ ] **Step 5: Run typecheck to verify GREEN**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/tui/provider.ts src/tui/store-backed-provider.ts src/tui/remote-provider.ts
git commit -m "feat: expose handoff operator actions to TUI providers"
```

## Task 6: TUI Handoff Visibility

**Files:**
- Modify: `src/tui/views/handoffs-view.tsx`
- Modify: `src/tui/views/handoffs-view.test.tsx`
- Modify: `src/tui/screens/running-view.tsx`
- Modify: `src/tui/screens/running-view-handoffs.test.ts`

- [ ] **Step 1: Write failing HandoffsView tests**

In `src/tui/views/handoffs-view.test.tsx`, add:

```ts
test("renders blocked handoffs with reason and actions", () => {
  const provider = {
    capabilities: { handoffs: true },
    getHandoffs: async () => [],
    markHandoffDelivered: async () => undefined,
    cancelHandoff: async () => undefined,
    manualResolveHandoff: async () => undefined,
    resendHandoff: async () => undefined,
    rerouteHandoff: async () => undefined,
  } as unknown as TuiDataProvider;
  const handoff: Handoff = {
    handoffId: "handoff-blocked",
    sourceCid: "blake3:a913b2e46abcdef",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.Delivered,
    requiresReply: true,
    createdAt: "2026-05-20T19:59:00.000Z",
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  act(() => {
    renderer = TestRenderer.create(
      React.createElement(HandoffsView, {
        provider,
        active: true,
        cursor: 0,
        handoffs: [handoff],
        healthSignals: [{ role: "reviewer", healthy: false, reason: "agent task failed" }],
      }),
    );
  });
  if (!renderer) throw new Error("renderer did not mount");

  const text = collectText(renderer.toJSON());
  expect(text).toContain("blocked");
  expect(text).toContain("agent task failed");
  expect(text).toContain("resend");
  expect(text).toContain("reroute");
  expect(text).toContain("manual");
});

test("renders dead-lettered handoffs as delivery failures", () => {
  const provider = {
    capabilities: { handoffs: true },
    getHandoffs: async () => [],
    markHandoffDelivered: async () => undefined,
    cancelHandoff: async () => undefined,
    manualResolveHandoff: async () => undefined,
    resendHandoff: async () => undefined,
    rerouteHandoff: async () => undefined,
  } as unknown as TuiDataProvider;
  const handoff: Handoff = {
    handoffId: "handoff-dead",
    sourceCid: "blake3:a913b2e46abcdef",
    fromRole: "coder",
    toRole: "reviewer",
    status: HandoffStatus.DeadLettered,
    requiresReply: true,
    createdAt: "2026-05-20T19:59:00.000Z",
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  act(() => {
    renderer = TestRenderer.create(
      React.createElement(HandoffsView, {
        provider,
        active: true,
        cursor: 0,
        handoffs: [handoff],
      }),
    );
  });
  if (!renderer) throw new Error("renderer did not mount");

  const text = collectText(renderer.toJSON());
  expect(text).toContain("dead_lettered");
  expect(text).toContain("delivery failed");
});
```

- [ ] **Step 2: Run HandoffsView tests to verify RED**

Run:

```bash
bun test src/tui/views/handoffs-view.test.tsx
```

Expected: FAIL because `healthSignals` prop and projected state rendering are absent.

- [ ] **Step 3: Render projections in HandoffsView**

In `src/tui/views/handoffs-view.tsx`, import:

```ts
import {
  HandoffOperatorState,
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  type HandoffHealthSignal,
} from "../../core/handoff-operator-state.js";
```

Change columns to:

```ts
const COLUMNS = [
  { header: "FROM", key: "from", width: 10 },
  { header: "TO", key: "to", width: 10 },
  { header: "STATE", key: "state", width: 16 },
  { header: "REASON", key: "reason", width: 22 },
  { header: "RECEIPT", key: "receipt", width: 10 },
  { header: "DEADLINE", key: "deadline", width: 12 },
  { header: "ACTIONS", key: "actions", width: 24 },
  { header: "SOURCE CID", key: "cid", width: 18 },
] as const;
```

Add prop:

```ts
readonly healthSignals?: readonly HandoffHealthSignal[] | undefined;
```

Inside the component:

```ts
const projections = handoffs.map((handoff) =>
  deriveHandoffOperatorProjection(handoff, { healthSignals }),
);
const counts = countHandoffOperatorStates(projections);
const rows = projections.map((projection) => ({
  from: projection.handoff.fromRole,
  to: projection.handoff.toRole,
  state: projection.state,
  reason: projection.reason,
  receipt: receiptLabel(projection.handoff),
  deadline: deadlineLabel(projection.handoff),
  actions: projection.actions.join(", "),
  cid: truncateCid(projection.handoff.sourceCid),
}));
```

Update header copy to show:

```tsx
<text opacity={0.5}>
  {handoffs.length > 0
    ? `  ${handoffs.length} total, ${counts.pending} pending, ${counts.overdue} overdue, ${counts.blocked} blocked, ${counts.deadLettered} failed`
    : "  (no handoffs yet)"}
</text>
```

- [ ] **Step 4: Pass health signals from RunningView**

In `src/tui/screens/running-view.tsx`, import:

```ts
import {
  healthSignalsFromAgentFailures,
  healthSignalsFromAgentTasks,
  type HandoffHealthSignal,
} from "../../core/handoff-operator-state.js";
```

Add state near handoff state:

```ts
const [handoffHealthSignals, setHandoffHealthSignals] = useState<
  readonly HandoffHealthSignal[]
>([]);
```

Inside `refreshHandoffs`, fetch agent tasks with handoffs:

```ts
void Promise.all([
  provider.getHandoffs({ limit: 200 }),
  provider.getAgentTasks ? provider.getAgentTasks() : Promise.resolve([]),
])
  .then(([all, tasks]) => {
    const cutoff =
      sessionStartedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const filtered = all.filter((h) => h.createdAt >= cutoff);
    setHandoffs(filtered);
    setHandoffHealthSignals([
      ...healthSignalsFromAgentFailures(agentFailures),
      ...healthSignalsFromAgentTasks(tasks),
    ]);
  })
```

Add `agentFailures` to the `refreshHandoffs` dependency list.

Pass the prop:

```tsx
<HandoffsView
  provider={ctx.provider}
  intervalMs={ctx.intervalMs}
  active
  cursor={0}
  sessionStartedAt={ctx.sessionStartedAt}
  handoffs={ctx.handoffs}
  healthSignals={ctx.handoffHealthSignals}
/>
```

Extend the render context type with:

```ts
readonly handoffHealthSignals?: readonly HandoffHealthSignal[] | undefined;
```

- [ ] **Step 5: Update string-wiring test**

In `src/tui/screens/running-view-handoffs.test.ts`, add expectations:

```ts
expect(source).toContain("healthSignalsFromAgentFailures");
expect(source).toContain("healthSignalsFromAgentTasks");
expect(source).toContain("handoffHealthSignals");
```

- [ ] **Step 6: Run TUI tests to verify GREEN**

Run:

```bash
bun test src/tui/views/handoffs-view.test.tsx src/tui/screens/running-view-handoffs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/tui/views/handoffs-view.tsx src/tui/views/handoffs-view.test.tsx src/tui/screens/running-view.tsx src/tui/screens/running-view-handoffs.test.ts
git commit -m "feat(tui): show operator handoff states"
```

## Task 7: Full Verification And Cleanup

**Files:**
- Review all changed files from Tasks 1-6.

- [ ] **Step 1: Run focused handoff/server/TUI tests**

Run:

```bash
bun test src/core/handoff-state-machine.test.ts src/core/handoff-operator-state.test.ts src/core/in-memory-handoff-store.conformance.test.ts src/local/sqlite-handoff-store.conformance.test.ts src/nexus/nexus-handoff-store.test.ts tests/server/routes-extended.test.ts tests/server/boardroom.test.ts src/tui/views/handoffs-view.test.tsx src/tui/screens/running-view-handoffs.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run project typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Biome check**

Run:

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD~6..HEAD
git diff --check
```

Expected: `git diff --check` exits 0.

- [ ] **Step 6: Commit verification-only adjustments after a formatting diff**

Run formatting, inspect whether it changed files, and commit only when `git status --short` shows a formatting diff:

```bash
bun run format
git status --short
git add .
git commit -m "chore: format handoff visibility changes"
```

Expected: skip `git add` and `git commit` when `git status --short` is empty after formatting.
