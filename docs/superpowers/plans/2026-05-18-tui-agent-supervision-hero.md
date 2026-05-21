# TUI Agent Supervision — Hero Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the feed-default body of `RunningView` with a fleet-rail + detail-rail supervision surface that surfaces blocked/stuck/thrashing/silent agents, inlines approvals, and persists agent selection across panel drill-downs. Behind env flag `GROVE_SUPERVISION=1` until stable.

**Architecture:** New module `src/tui/screens/supervision/` exports pure derivation (`agent-health`, `supervision-actions`), a join hook (`use-fleet-model`), and three React components (`fleet-rail`, `detail-rail`, `supervision`). `useAgentMonitor` gets a small additive timestamp map. `running-view.tsx` swaps its default body when the flag is on; the floating Permission Request overlay moves into the detail rail. `DagView` / `HandoffsView` gain optional `filterAgentId` props so drill-downs inherit the selected agent.

**Tech Stack:** TypeScript, React + `@opentui/react`, `bun:test`, `useEntities` informer push, existing `useAgentMonitor` / `useEventDrivenData` hooks.

**Spec:** `docs/superpowers/specs/2026-05-18-tui-agent-supervision-hero-design.md`

---

## File Structure

**New (in order of dependency):**
- `src/tui/screens/supervision/agent-health.ts` — pure: `AgentHealth` union, thresholds, `deriveAgentHealth(input, now)`
- `src/tui/screens/supervision/agent-health.test.ts`
- `src/tui/screens/supervision/supervision-actions.ts` — pure: `SupervisionAction` enum, `actionEnabled(action, health)`
- `src/tui/screens/supervision/supervision-actions.test.ts`
- `src/tui/screens/supervision/use-fleet-model.ts` — hook: join claims × tmux × cost × handoffs × permissions × monitor → `FleetAgent[]`
- `src/tui/screens/supervision/use-fleet-model.test.ts`
- `src/tui/screens/supervision/fleet-rail.tsx` — left rail
- `src/tui/screens/supervision/fleet-rail.test.tsx`
- `src/tui/screens/supervision/detail-rail.tsx` — right rail
- `src/tui/screens/supervision/detail-rail.test.tsx`
- `src/tui/screens/supervision/supervision-keyboard.ts` — pure key router for the supervision body
- `src/tui/screens/supervision/supervision-keyboard.test.ts`
- `src/tui/screens/supervision/supervision.tsx` — composition root + state
- `src/tui/screens/supervision/supervision.test.tsx`
- `tests/tui/supervision-e2e.ts` — integration smoke (nexus + 2 ACPX agents)

**Modified:**
- `src/tui/hooks/use-agent-monitor.ts` — add `agentOutputTimestamps` to state (additive)
- `src/tui/hooks/use-agent-monitor.test.ts` — add timestamp assertion
- `src/tui/views/dag.tsx` — additive `filterAgentId?: string` prop
- `src/tui/views/handoffs-view.tsx` — additive `filterAgentId?: string` prop
- `src/tui/screens/running-view.tsx` — flag-gated body swap; remove floating Permission Request box when flag is on; thread `selectedAgentId` to drill-down panels; help-overlay update

---

## Task 1: Extend `useAgentMonitor` with output timestamps

**Why:** `deriveAgentHealth` needs to detect `silent` ( = no output for N minutes). The current monitor stores only line arrays, no timestamps. Additive extension keeps existing consumers unaffected.

**Files:**
- Modify: `src/tui/hooks/use-agent-monitor.ts`
- Test: `src/tui/hooks/use-agent-monitor.test.ts`

- [ ] **Step 1: Write a failing test for the new map**

Append to `src/tui/hooks/use-agent-monitor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mergeOutputs } from "./use-agent-monitor.js";

describe("mergeOutputs", () => {
  test("returns next outputs and a parallel timestamp map keyed by role", () => {
    const now = new Date("2026-05-18T12:00:00Z").toISOString();
    const { outputs, timestamps } = mergeOutputs(
      new Map([["coder", ["old"]]]),
      new Map(),
      new Map([["coder", ["old", "new"]]]),
      now,
    );
    expect(outputs.get("coder")).toEqual(["old", "new"]);
    expect(timestamps.get("coder")).toBe(now);
  });

  test("preserves prior timestamps for roles whose outputs did not change", () => {
    const prior = new Date("2026-05-18T11:00:00Z").toISOString();
    const now = new Date("2026-05-18T12:00:00Z").toISOString();
    const { timestamps } = mergeOutputs(
      new Map([["coder", ["x"]]]),
      new Map([["coder", prior]]),
      new Map([["coder", ["x"]]]), // same content
      now,
    );
    expect(timestamps.get("coder")).toBe(prior);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/tui/hooks/use-agent-monitor.test.ts -t mergeOutputs`
Expected: FAIL — `mergeOutputs` not exported.

- [ ] **Step 3: Add `mergeOutputs` and wire it into the hook**

Edit `src/tui/hooks/use-agent-monitor.ts`:

1. Add `mergeOutputs` near the other exported pure helpers (around line 137, after `parseLogContent`):

```ts
/**
 * Merge a fresh outputs snapshot with the prior state and produce a parallel
 * timestamp map. A role's timestamp is bumped to `now` only when its line
 * array changed. Pure — exported for testing.
 */
export function mergeOutputs(
  priorOutputs: ReadonlyMap<string, readonly string[]>,
  priorTimestamps: ReadonlyMap<string, string>,
  nextOutputs: ReadonlyMap<string, readonly string[]>,
  now: string,
): {
  readonly outputs: ReadonlyMap<string, readonly string[]>;
  readonly timestamps: ReadonlyMap<string, string>;
} {
  const timestamps = new Map<string, string>(priorTimestamps);
  for (const [role, lines] of nextOutputs) {
    const prior = priorOutputs.get(role);
    const changed =
      !prior ||
      prior.length !== lines.length ||
      prior.some((line, i) => line !== lines[i]);
    if (changed) timestamps.set(role, now);
  }
  return { outputs: nextOutputs, timestamps };
}
```

2. Extend the `AgentMonitorState` interface:

```ts
export interface AgentMonitorState {
  readonly agentOutputs: ReadonlyMap<string, readonly string[]>;
  /** ISO timestamp of the most recent change per role. Updated only when the
   *  role's line array differs from its prior value. */
  readonly agentOutputTimestamps: ReadonlyMap<string, string>;
  readonly pendingPermissions: readonly PermissionPrompt[];
  readonly ipcMessages: readonly IpcMessage[];
  readonly spinnerFrame: number;
}
```

3. Inside `useAgentMonitor`:
   - Add a new state: `const [agentOutputTimestamps, setAgentOutputTimestamps] = useState<ReadonlyMap<string, string>>(new Map());`
   - Replace both `setAgentOutputs(outputs)` calls (one in `logPoll`, one in `tmuxPoll`) with:

```ts
const now = new Date().toISOString();
setAgentOutputs((prior) => {
  const merged = mergeOutputs(prior, agentOutputTimestamps, outputs, now);
  setAgentOutputTimestamps(merged.timestamps);
  return merged.outputs;
});
```

   - Add `agentOutputTimestamps` to the returned object.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test src/tui/hooks/use-agent-monitor.test.ts`
Expected: PASS (existing tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/tui/hooks/use-agent-monitor.ts src/tui/hooks/use-agent-monitor.test.ts
git commit -m "feat(tui): add per-role output timestamps to useAgentMonitor (#193)"
```

---

## Task 2: Pure `agent-health` module

**Files:**
- Create: `src/tui/screens/supervision/agent-health.ts`
- Create: `src/tui/screens/supervision/agent-health.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/tui/screens/supervision/agent-health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { deriveAgentHealth, HEALTH_THRESHOLDS, type HealthInput } from "./agent-health.js";

const NOW = new Date("2026-05-18T12:00:00Z").getTime();
const minutesAgo = (m: number): string =>
  new Date(NOW - m * 60_000).toISOString();

function baseInput(over: Partial<HealthInput> = {}): HealthInput {
  return {
    role: "coder",
    leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
    heartbeatAt: minutesAgo(0),
    attemptCount: 0,
    lastRetryAt: undefined,
    lastOutputAt: minutesAgo(0),
    currentTask: "task-a",
    currentTaskSinceMs: 1_000,
    pendingApproval: undefined,
    blockedOn: undefined,
    blockedSinceMs: 0,
    agentFailure: undefined,
    ...over,
  };
}

describe("deriveAgentHealth", () => {
  test("agentFailure → error (highest priority)", () => {
    const out = deriveAgentHealth(
      baseInput({
        agentFailure: "auth failed",
        pendingApproval: { sessionName: "grove-coder-x", agentRole: "coder", command: "ls" },
      }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "error", reason: "auth failed" });
  });

  test("pendingApproval beats blocked beats stuck", () => {
    const out = deriveAgentHealth(
      baseInput({
        pendingApproval: { sessionName: "s", agentRole: "coder", command: "rm" },
      }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "approval", cmd: "rm" });
  });

  test("lease expired → expired", () => {
    const out = deriveAgentHealth(
      baseInput({ leaseExpiresAt: new Date(NOW - 1).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("expired");
  });

  test("attemptCount >= threshold and recent retry → thrashing", () => {
    const out = deriveAgentHealth(
      baseInput({ attemptCount: 4, lastRetryAt: new Date(NOW - 10_000).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "thrashing", retries: 4 });
  });

  test("blockedOn set and past min duration → blocked", () => {
    const out = deriveAgentHealth(
      baseInput({ blockedOn: "coordinator", blockedSinceMs: 120_000 }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out).toEqual({ kind: "blocked", on: "coordinator", sinceMs: 120_000 });
  });

  test("no output for > SILENT_MS → silent", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: minutesAgo(6) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("silent");
  });

  test("task unchanged longer than STUCK_MS but output recent → stuck", () => {
    const out = deriveAgentHealth(
      baseInput({ currentTaskSinceMs: 9 * 60_000, lastOutputAt: minutesAgo(0) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("stuck");
  });

  test("heartbeat lapse > 60s → silent (heartbeat path)", () => {
    const out = deriveAgentHealth(
      baseInput({ heartbeatAt: minutesAgo(2), lastOutputAt: minutesAgo(0) }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("silent");
  });

  test("recent output + recent heartbeat → running", () => {
    const out = deriveAgentHealth(baseInput(), NOW, HEALTH_THRESHOLDS);
    expect(out.kind).toBe("running");
  });

  test("no output ever + no task → idle", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: undefined, currentTask: undefined }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).toBe("idle");
  });

  test("threshold edge: SILENT_MS - 1 → not silent", () => {
    const out = deriveAgentHealth(
      baseInput({ lastOutputAt: new Date(NOW - HEALTH_THRESHOLDS.silentMs + 1).toISOString() }),
      NOW,
      HEALTH_THRESHOLDS,
    );
    expect(out.kind).not.toBe("silent");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/agent-health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `agent-health.ts`**

Create `src/tui/screens/supervision/agent-health.ts`:

```ts
/**
 * Pure derivation of agent supervision health (issue #193).
 *
 * Inputs come from the fleet model (claim + monitor output timestamps +
 * handoffs + permissions). The first matching rule wins.
 */

import type { PermissionPrompt } from "../../hooks/use-agent-monitor.js";

export interface HealthThresholds {
  /** No output for longer than this → silent. */
  readonly silentMs: number;
  /** currentTask unchanged for longer than this (with recent output) → stuck. */
  readonly stuckMs: number;
  /** attemptCount >= this with a recent retry → thrashing. */
  readonly thrashRetries: number;
  /** "Recent retry" window: lastRetryAt within this from now. */
  readonly thrashWindowMs: number;
  /** Minimum blocked age before health flips to "blocked". */
  readonly blockedMinMs: number;
  /** Heartbeat lapse beyond this counts as silent. */
  readonly heartbeatLapseMs: number;
}

export const HEALTH_THRESHOLDS: HealthThresholds = {
  silentMs: 5 * 60_000,
  stuckMs: 8 * 60_000,
  thrashRetries: 3,
  thrashWindowMs: 30_000,
  blockedMinMs: 60_000,
  heartbeatLapseMs: 60_000,
};

export type AgentHealth =
  | { kind: "running" }
  | { kind: "idle" }
  | { kind: "approval"; cmd: string }
  | { kind: "blocked"; on: string; sinceMs: number }
  | { kind: "stuck"; sinceMs: number }
  | { kind: "thrashing"; retries: number }
  | { kind: "silent"; sinceMs: number }
  | { kind: "error"; reason: string }
  | { kind: "expired" };

export interface HealthInput {
  readonly role: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly attemptCount: number;
  readonly lastRetryAt: string | undefined;
  readonly lastOutputAt: string | undefined;
  readonly currentTask: string | undefined;
  readonly currentTaskSinceMs: number;
  readonly pendingApproval: PermissionPrompt | undefined;
  readonly blockedOn: string | undefined;
  readonly blockedSinceMs: number;
  readonly agentFailure: string | undefined;
}

/** Sort weight — lower = surfaced first. */
export function healthPriority(h: AgentHealth): number {
  switch (h.kind) {
    case "error": return 0;
    case "approval": return 1;
    case "blocked": return 2;
    case "stuck": return 3;
    case "thrashing": return 4;
    case "silent": return 5;
    case "running": return 6;
    case "idle": return 7;
    case "expired": return 8;
  }
}

export function deriveAgentHealth(
  i: HealthInput,
  nowMs: number,
  t: HealthThresholds,
): AgentHealth {
  if (i.agentFailure) return { kind: "error", reason: i.agentFailure };
  if (i.pendingApproval) return { kind: "approval", cmd: i.pendingApproval.command };

  const leaseMs = new Date(i.leaseExpiresAt).getTime();
  if (leaseMs <= nowMs) return { kind: "expired" };

  if (
    i.attemptCount >= t.thrashRetries &&
    i.lastRetryAt !== undefined &&
    nowMs - new Date(i.lastRetryAt).getTime() <= t.thrashWindowMs
  ) {
    return { kind: "thrashing", retries: i.attemptCount };
  }

  if (i.blockedOn !== undefined && i.blockedSinceMs > t.blockedMinMs) {
    return { kind: "blocked", on: i.blockedOn, sinceMs: i.blockedSinceMs };
  }

  const lastOutMs = i.lastOutputAt ? new Date(i.lastOutputAt).getTime() : undefined;
  if (lastOutMs !== undefined && nowMs - lastOutMs > t.silentMs) {
    return { kind: "silent", sinceMs: nowMs - lastOutMs };
  }

  if (i.currentTask !== undefined && i.currentTaskSinceMs > t.stuckMs && lastOutMs !== undefined) {
    return { kind: "stuck", sinceMs: i.currentTaskSinceMs };
  }

  const heartMs = new Date(i.heartbeatAt).getTime();
  if (nowMs - heartMs > t.heartbeatLapseMs) {
    return { kind: "silent", sinceMs: nowMs - heartMs };
  }

  if (lastOutMs !== undefined) return { kind: "running" };
  return { kind: "idle" };
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/agent-health.test.ts`
Expected: PASS — all 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/agent-health.ts src/tui/screens/supervision/agent-health.test.ts
git commit -m "feat(tui): pure agent-health derivation for supervision (#193)"
```

---

## Task 3: Pure `supervision-actions` module

**Files:**
- Create: `src/tui/screens/supervision/supervision-actions.ts`
- Create: `src/tui/screens/supervision/supervision-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/supervision-actions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { actionEnabled, SUPERVISION_ACTIONS, type SupervisionAction } from "./supervision-actions.js";
import type { AgentHealth } from "./agent-health.js";

const RUNNING: AgentHealth = { kind: "running" };
const APPROVAL: AgentHealth = { kind: "approval", cmd: "rm -rf /" };
const BLOCKED: AgentHealth = { kind: "blocked", on: "coordinator", sinceMs: 120_000 };
const EXPIRED: AgentHealth = { kind: "expired" };

describe("actionEnabled", () => {
  test("approve / deny / always require approval health", () => {
    expect(actionEnabled("approve", APPROVAL)).toBe(true);
    expect(actionEnabled("approve", RUNNING)).toBe(false);
    expect(actionEnabled("deny", BLOCKED)).toBe(false);
    expect(actionEnabled("always", APPROVAL)).toBe(true);
  });

  test("reroute requires blocked health", () => {
    expect(actionEnabled("reroute", BLOCKED)).toBe(true);
    expect(actionEnabled("reroute", RUNNING)).toBe(false);
  });

  test("kill enabled for everything except expired", () => {
    expect(actionEnabled("kill", RUNNING)).toBe(true);
    expect(actionEnabled("kill", APPROVAL)).toBe(true);
    expect(actionEnabled("kill", EXPIRED)).toBe(false);
  });

  test("tail / dag / message always enabled", () => {
    for (const action of ["tail", "dag", "message"] as SupervisionAction[]) {
      expect(actionEnabled(action, EXPIRED)).toBe(true);
    }
  });

  test("SUPERVISION_ACTIONS lists each action exactly once", () => {
    const set = new Set(SUPERVISION_ACTIONS);
    expect(set.size).toBe(SUPERVISION_ACTIONS.length);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/supervision-actions.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `supervision-actions.ts`**

```ts
/**
 * Supervision action descriptors. Pure module — pairs an action key with an
 * enablement predicate based on the selected agent's health.
 */

import type { AgentHealth } from "./agent-health.js";

export type SupervisionAction =
  | "approve"
  | "deny"
  | "always"
  | "reroute"
  | "kill"
  | "tail"
  | "dag"
  | "message";

export const SUPERVISION_ACTIONS: readonly SupervisionAction[] = [
  "approve",
  "deny",
  "always",
  "reroute",
  "kill",
  "tail",
  "dag",
  "message",
];

export function actionEnabled(action: SupervisionAction, health: AgentHealth): boolean {
  switch (action) {
    case "approve":
    case "deny":
    case "always":
      return health.kind === "approval";
    case "reroute":
      return health.kind === "blocked";
    case "kill":
      return health.kind !== "expired";
    case "tail":
    case "dag":
    case "message":
      return true;
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/supervision-actions.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/supervision-actions.ts src/tui/screens/supervision/supervision-actions.test.ts
git commit -m "feat(tui): supervision action descriptors + enablement (#193)"
```

---

## Task 4: `useFleetModel` join hook

**Files:**
- Create: `src/tui/screens/supervision/use-fleet-model.ts`
- Create: `src/tui/screens/supervision/use-fleet-model.test.ts`

This task tests the **pure join function** (`buildFleet`) that the hook wraps. The hook itself is exercised by `supervision.test.tsx` in Task 8.

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/use-fleet-model.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ClaimEntity } from "../../../core/entity.js";
import { type Handoff, HandoffStatus } from "../../../core/handoff.js";
import { buildFleet, type FleetSources } from "./use-fleet-model.js";

const NOW = new Date("2026-05-18T12:00:00Z").getTime();

function claim(
  agentId: string,
  role: string,
  over: Partial<ClaimEntity["status"]> = {},
): ClaimEntity {
  return {
    kind: "Claim",
    id: `claim-${agentId}`,
    metadata: { creationTimestamp: new Date(NOW - 60_000).toISOString() },
    spec: {
      agent: { agentId, agentName: agentId, role, platform: "claude" },
      targetRef: `target-${agentId}`,
      intentSummary: "do thing",
      context: {},
    },
    status: {
      phase: "active",
      heartbeatAt: new Date(NOW).toISOString(),
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      attemptCount: 0,
      ...over,
    },
  } as ClaimEntity;
}

const baseSources: FleetSources = {
  claims: [],
  tmuxSessions: [],
  costs: new Map(),
  agentOutputs: new Map(),
  agentOutputTimestamps: new Map(),
  pendingPermissions: [],
  handoffs: [],
  agentFailures: new Map(),
  filterText: undefined,
  nowMs: NOW,
};

describe("buildFleet", () => {
  test("sorts problem agents before running agents", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [
        claim("a-run", "coder"),
        claim("b-fail", "coder"),
      ],
      agentFailures: new Map([["coder", "ACP auth failed"]]),
    });
    expect(fleet[0]?.agentId).toBe("b-fail");
    expect(fleet[0]?.health.kind).toBe("error");
  });

  test("session field undefined when no tmux session matches", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      tmuxSessions: ["grove-other-xyz"],
    });
    expect(fleet[0]?.session).toBeUndefined();
  });

  test("cost rollup matches by agentId", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      costs: new Map([["a", { costUsd: 1.23, tokens: 4567 }]]),
    });
    expect(fleet[0]?.cost?.usd).toBe(1.23);
  });

  test("filterText narrows by case-insensitive substring across role/name/target", () => {
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("alpha", "coder"), claim("beta", "reviewer")],
      filterText: "REV",
    });
    expect(fleet.map((f) => f.agentId)).toEqual(["beta"]);
  });

  test("handoff blockedOn aggregated from oldest pending inbound", () => {
    const handoff: Handoff = {
      handoffId: "h1",
      fromRole: "coordinator",
      toRole: "coder",
      status: HandoffStatus.PendingPickup,
      sourceCid: "cid-1",
      createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    } as Handoff;
    const fleet = buildFleet({
      ...baseSources,
      claims: [claim("a", "coder")],
      handoffs: [handoff],
    });
    expect(fleet[0]?.handoffs.blockedOn).toBe("coordinator");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/use-fleet-model.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `use-fleet-model.ts`**

```ts
/**
 * Fleet model — join active claims with tmux session, cost, monitor outputs,
 * pending permissions, handoffs, and per-role failure messages, and derive
 * AgentHealth per agent. Sorted problem-first.
 *
 * The hook subscribes to the existing entity informer + monitor; all sources
 * are push-driven so the model recomputes only when inputs change.
 */

import { useCallback, useMemo } from "react";
import { type ClaimEntity, claimToEntity } from "../../../core/entity.js";
import type { Handoff } from "../../../core/handoff.js";
import { HandoffStatus } from "../../../core/handoff.js";
import { agentIdFromSession } from "../../agents/tmux-manager.js";
import { useEventDrivenData } from "../../hooks/use-event-driven-data.js";
import type { AgentMonitorState, PermissionPrompt } from "../../hooks/use-agent-monitor.js";
import type { TuiDataProvider } from "../../provider.js";
import { isHandoffProvider } from "../../provider.js";
import {
  type AgentHealth,
  deriveAgentHealth,
  HEALTH_THRESHOLDS,
  healthPriority,
} from "./agent-health.js";

export interface FleetCost {
  readonly usd: number;
  readonly tokens: number;
  readonly ctxPercent?: number;
}

export interface FleetAgent {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: string;
  readonly platform: string;
  readonly session: string | undefined;
  readonly claim: ClaimEntity;
  readonly health: AgentHealth;
  readonly currentTask: string | undefined;
  readonly lastAction: string | undefined;
  readonly lastOutputAt: string | undefined;
  readonly cost: FleetCost | undefined;
  readonly handoffs: { pendingOut: number; overdueIn: number; blockedOn?: string };
  readonly pendingApproval: PermissionPrompt | undefined;
  readonly attemptCount: number;
}

export interface FleetSources {
  readonly claims: readonly ClaimEntity[];
  readonly tmuxSessions: readonly string[];
  readonly costs: ReadonlyMap<string, FleetCost>;
  readonly agentOutputs: ReadonlyMap<string, readonly string[]>;
  readonly agentOutputTimestamps: ReadonlyMap<string, string>;
  readonly pendingPermissions: readonly PermissionPrompt[];
  readonly handoffs: readonly Handoff[];
  readonly agentFailures: ReadonlyMap<string, string>;
  readonly filterText: string | undefined;
  readonly nowMs: number;
}

const matchesFilter = (a: FleetAgent, q: string): boolean => {
  const haystack = `${a.agentName} ${a.agentId} ${a.role} ${a.platform} ${a.claim.spec.targetRef}`.toLowerCase();
  return haystack.includes(q);
};

/** Build a sorted FleetAgent list. Pure — exported for testing. */
export function buildFleet(s: FleetSources): readonly FleetAgent[] {
  const tmuxByAgent = new Map<string, string>();
  for (const session of s.tmuxSessions) {
    const id = agentIdFromSession(session);
    if (id) tmuxByAgent.set(id, session);
  }

  const inboundByRole = new Map<string, Handoff[]>();
  for (const h of s.handoffs) {
    if (h.status !== HandoffStatus.PendingPickup) continue;
    const list = inboundByRole.get(h.toRole) ?? [];
    list.push(h);
    inboundByRole.set(h.toRole, list);
  }
  const outboundByRole = new Map<string, number>();
  for (const h of s.handoffs) {
    if (h.status !== HandoffStatus.PendingPickup) continue;
    outboundByRole.set(h.fromRole, (outboundByRole.get(h.fromRole) ?? 0) + 1);
  }

  const agents: FleetAgent[] = [];
  for (const claim of s.claims) {
    const role = claim.spec.agent.role ?? "worker";
    const agentId = claim.spec.agent.agentId;
    const session = tmuxByAgent.get(agentId);
    const outputs = s.agentOutputs.get(role) ?? [];
    const lastAction = outputs.length > 0 ? outputs[outputs.length - 1] : undefined;
    const lastOutputAt = s.agentOutputTimestamps.get(role);
    const pendingApproval = s.pendingPermissions.find((p) => p.agentRole === role);
    const inbound = inboundByRole.get(role) ?? [];
    const oldestInbound = inbound
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const blockedOn = oldestInbound?.fromRole;
    const blockedSinceMs = oldestInbound
      ? s.nowMs - new Date(oldestInbound.createdAt).getTime()
      : 0;
    const overdueIn = inbound.filter(
      (h) =>
        h.replyDueAt !== undefined && new Date(h.replyDueAt).getTime() < s.nowMs,
    ).length;

    const health = deriveAgentHealth(
      {
        role,
        leaseExpiresAt: claim.status.leaseExpiresAt,
        heartbeatAt: claim.status.heartbeatAt,
        attemptCount: claim.status.attemptCount,
        lastRetryAt: undefined,
        lastOutputAt,
        currentTask: claim.spec.intentSummary,
        currentTaskSinceMs: s.nowMs - new Date(claim.metadata.creationTimestamp ?? claim.status.heartbeatAt).getTime(),
        pendingApproval,
        blockedOn,
        blockedSinceMs,
        agentFailure: s.agentFailures.get(role),
      },
      s.nowMs,
      HEALTH_THRESHOLDS,
    );

    agents.push({
      agentId,
      agentName: claim.spec.agent.agentName ?? agentId,
      role,
      platform: claim.spec.agent.platform ?? "-",
      session,
      claim,
      health,
      currentTask: claim.spec.intentSummary,
      lastAction,
      lastOutputAt,
      cost: s.costs.get(agentId),
      handoffs: {
        pendingOut: outboundByRole.get(role) ?? 0,
        overdueIn,
        ...(blockedOn ? { blockedOn } : {}),
      },
      pendingApproval,
      attemptCount: claim.status.attemptCount,
    });
  }

  const q = s.filterText?.trim().toLowerCase();
  const filtered = q ? agents.filter((a) => matchesFilter(a, q)) : agents;

  return filtered.slice().sort((a, b) => {
    const pa = healthPriority(a.health);
    const pb = healthPriority(b.health);
    if (pa !== pb) return pa - pb;
    if (a.role === "coordinator" && b.role !== "coordinator") return -1;
    if (b.role === "coordinator" && a.role !== "coordinator") return 1;
    return a.agentName.localeCompare(b.agentName);
  });
}

export interface UseFleetModelArgs {
  readonly provider: TuiDataProvider;
  readonly monitor: AgentMonitorState;
  readonly agentFailures: ReadonlyMap<string, string> | undefined;
  readonly tmux: import("../../agents/tmux-manager.js").TmuxManager | undefined;
  readonly filterText: string | undefined;
  readonly active: boolean;
}

const NAMESPACE = "default";

export function useFleetModel(args: UseFleetModelArgs): readonly FleetAgent[] {
  // Active claims (mirrors AgentListView's fallback fetcher pattern).
  const claimsFetcher = useCallback(async (): Promise<readonly ClaimEntity[]> => {
    const flat = await args.provider.getClaims({ status: "active" });
    return flat.map((c) => claimToEntity(c, () => Date.now(), NAMESPACE));
  }, [args.provider]);
  const { data: claims } = useEventDrivenData<readonly ClaimEntity[]>(
    claimsFetcher,
    undefined,
    undefined,
    args.active,
  );

  // Tmux sessions (same pattern as AgentListView).
  const tmuxFetcher = useCallback(async (): Promise<readonly string[]> => {
    if (!args.tmux) return [];
    return (await args.tmux.isAvailable()) ? args.tmux.listSessions() : [];
  }, [args.tmux]);
  const { data: tmuxSessions } = useEventDrivenData<readonly string[]>(
    tmuxFetcher,
    undefined,
    undefined,
    args.active && !!args.tmux,
  );

  // Session costs (same pattern as AgentListView).
  const costsFetcher = useCallback(async (): Promise<ReadonlyMap<string, FleetCost>> => {
    const cp = args.provider as unknown as {
      getSessionCosts?: () => Promise<{
        byAgent: readonly { agentId: string; costUsd: number; tokens: number; contextPercent?: number }[];
      }>;
    };
    if (!cp.getSessionCosts) return new Map();
    const out = await cp.getSessionCosts();
    const m = new Map<string, FleetCost>();
    for (const a of out.byAgent) {
      m.set(a.agentId, {
        usd: a.costUsd,
        tokens: a.tokens,
        ...(a.contextPercent !== undefined ? { ctxPercent: a.contextPercent } : {}),
      });
    }
    return m;
  }, [args.provider]);
  const { data: costs } = useEventDrivenData<ReadonlyMap<string, FleetCost>>(
    costsFetcher,
    undefined,
    undefined,
    args.active,
  );

  // Handoffs (same pattern as HandoffsView).
  const handoffsFetcher = useCallback(async (): Promise<readonly Handoff[]> => {
    if (!isHandoffProvider(args.provider)) return [];
    return args.provider.getHandoffs({ limit: 200 });
  }, [args.provider]);
  const { data: handoffs } = useEventDrivenData<readonly Handoff[]>(
    handoffsFetcher,
    undefined,
    undefined,
    args.active && isHandoffProvider(args.provider),
  );

  const failures = args.agentFailures ?? new Map<string, string>();

  return useMemo(
    () =>
      buildFleet({
        claims: claims ?? [],
        tmuxSessions: tmuxSessions ?? [],
        costs: costs ?? new Map(),
        agentOutputs: args.monitor.agentOutputs,
        agentOutputTimestamps: args.monitor.agentOutputTimestamps,
        pendingPermissions: args.monitor.pendingPermissions,
        handoffs: handoffs ?? [],
        agentFailures: failures,
        filterText: args.filterText,
        nowMs: Date.now(),
      }),
    [
      claims,
      tmuxSessions,
      costs,
      args.monitor.agentOutputs,
      args.monitor.agentOutputTimestamps,
      args.monitor.pendingPermissions,
      handoffs,
      failures,
      args.filterText,
    ],
  );
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/use-fleet-model.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/use-fleet-model.ts src/tui/screens/supervision/use-fleet-model.test.ts
git commit -m "feat(tui): fleet-model join + health sort (#193)"
```

---

## Task 5: `<FleetRail>` component

**Files:**
- Create: `src/tui/screens/supervision/fleet-rail.tsx`
- Create: `src/tui/screens/supervision/fleet-rail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/fleet-rail.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "@opentui/react";
import type { FleetAgent } from "./use-fleet-model.js";
import { FleetRail } from "./fleet-rail.js";

function agent(over: Partial<FleetAgent>): FleetAgent {
  return {
    agentId: "a",
    agentName: "agent-a",
    role: "coder",
    platform: "claude",
    session: undefined,
    claim: {} as FleetAgent["claim"],
    health: { kind: "running" },
    currentTask: "do thing",
    lastAction: undefined,
    lastOutputAt: undefined,
    cost: undefined,
    handoffs: { pendingOut: 0, overdueIn: 0 },
    pendingApproval: undefined,
    attemptCount: 0,
    ...over,
  };
}

describe("FleetRail", () => {
  test("renders one row per fleet agent with health icon prefix", () => {
    const r = render(
      <FleetRail
        agents={[
          agent({ agentId: "a1", health: { kind: "running" } }),
          agent({ agentId: "a2", health: { kind: "blocked", on: "coord", sinceMs: 120_000 } }),
        ]}
        cursor={0}
        selectedAgentId="a1"
      />,
    );
    const out = r.toString();
    expect(out).toContain("a1");
    expect(out).toContain("a2");
    expect(out).toContain("BLOCKED");
  });

  test("approval lane shows [y/n] suffix", () => {
    const r = render(
      <FleetRail
        agents={[agent({ agentId: "a1", health: { kind: "approval", cmd: "rm" } })]}
        cursor={0}
        selectedAgentId="a1"
      />,
    );
    expect(r.toString()).toContain("[y/n]");
  });

  test("empty state copy", () => {
    const r = render(
      <FleetRail agents={[]} cursor={0} selectedAgentId={undefined} />,
    );
    expect(r.toString()).toContain("No agents registered");
  });

  test("header reports problem count", () => {
    const r = render(
      <FleetRail
        agents={[
          agent({ agentId: "ok", health: { kind: "running" } }),
          agent({ agentId: "bad", health: { kind: "stuck", sinceMs: 9 * 60_000 } }),
        ]}
        cursor={0}
        selectedAgentId="ok"
      />,
    );
    expect(r.toString()).toMatch(/Fleet \(2 · 1 problem\)/);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/fleet-rail.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Create `fleet-rail.tsx`**

```tsx
/**
 * Fleet rail — dense one-row-per-agent list (issue #193).
 *
 * Renders the FleetAgent[] from useFleetModel. Cursor row is highlighted;
 * problem agents show ALL-CAPS health label and any blocked-on attribution.
 */

import React from "react";
import { EmptyState } from "../../components/empty-state.js";
import { agentStatusIcon, theme } from "../../theme.js";
import type { AgentHealth } from "./agent-health.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface FleetRailProps {
  readonly agents: readonly FleetAgent[];
  readonly cursor: number;
  readonly selectedAgentId: string | undefined;
}

const PROBLEM_KINDS = new Set<AgentHealth["kind"]>([
  "error",
  "approval",
  "blocked",
  "stuck",
  "thrashing",
  "silent",
]);

const trunc = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const mins = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

function healthLabel(h: AgentHealth): { label: string; color: string } {
  switch (h.kind) {
    case "running": return { label: "run", color: theme.running };
    case "idle": return { label: "idle", color: theme.idle };
    case "approval": return { label: "APPROVAL", color: theme.warning };
    case "blocked": return { label: `BLOCKED ${mins(h.sinceMs)}`, color: theme.error };
    case "stuck": return { label: `STUCK ${mins(h.sinceMs)}`, color: theme.warning };
    case "thrashing": return { label: `THRASH x${h.retries}`, color: theme.warning };
    case "silent": return { label: `SILENT ${mins(h.sinceMs)}`, color: theme.warning };
    case "error": return { label: "ERROR", color: theme.error };
    case "expired": return { label: "expired", color: theme.idle };
  }
}

export const FleetRail = React.memo(function FleetRail({
  agents,
  cursor,
  selectedAgentId,
}: FleetRailProps): React.ReactNode {
  if (agents.length === 0) {
    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Fleet (0)</text>
        </box>
        <EmptyState
          title="No agents registered."
          hint="Press r to register, or Ctrl+P to spawn."
        />
      </box>
    );
  }

  const problemCount = agents.filter((a) => PROBLEM_KINDS.has(a.health.kind)).length;
  const header = `Fleet (${agents.length}${problemCount > 0 ? ` · ${problemCount} problem` : ""})`;

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text bold>{header}</text>
      </box>
      {agents.map((a, i) => {
        const isCursor = i === cursor;
        const isSelected = a.agentId === selectedAgentId;
        const { icon } = agentStatusIcon(
          a.health.kind === "running" ? "running" : a.health.kind === "idle" ? "idle" : "error",
        );
        const lbl = healthLabel(a.health);
        const prefix = isCursor ? "►" : " ";
        const action = a.lastAction ?? a.currentTask ?? "";
        return (
          <box key={a.agentId} flexDirection="row" backgroundColor={isSelected ? theme.focus : undefined}>
            <text>{`${prefix} `}</text>
            <text color={lbl.color}>{`${icon} ${lbl.label.padEnd(14)}`}</text>
            <text color={theme.secondary}>{` ${a.role.padEnd(10)} `}</text>
            <text>{trunc(a.agentName, 14).padEnd(14)}</text>
            <text color={theme.secondary}>{` ${trunc(action, 40)}`}</text>
            {a.health.kind === "blocked" ? (
              <text color={theme.error}>{` ← ${a.health.on}`}</text>
            ) : null}
            {a.health.kind === "approval" ? (
              <text color={theme.warning}>{" [y/n]"}</text>
            ) : null}
            {a.cost ? (
              <text color={theme.secondary}>{`  $${a.cost.usd.toFixed(2)}`}</text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
});
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/fleet-rail.test.tsx`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/fleet-rail.tsx src/tui/screens/supervision/fleet-rail.test.tsx
git commit -m "feat(tui): fleet rail dense lane list (#193)"
```

---

## Task 6: `<DetailRail>` component

**Files:**
- Create: `src/tui/screens/supervision/detail-rail.tsx`
- Create: `src/tui/screens/supervision/detail-rail.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/detail-rail.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "@opentui/react";
import { DetailRail } from "./detail-rail.js";
import type { FleetAgent } from "./use-fleet-model.js";

const baseAgent: FleetAgent = {
  agentId: "a1",
  agentName: "alpha",
  role: "coder",
  platform: "claude",
  session: "grove-coder-x",
  claim: {} as FleetAgent["claim"],
  health: { kind: "running" },
  currentTask: "edit login.ts",
  lastAction: undefined,
  lastOutputAt: undefined,
  cost: { usd: 1.18, tokens: 42_000 },
  handoffs: { pendingOut: 1, overdueIn: 0 },
  pendingApproval: undefined,
  attemptCount: 0,
};

describe("DetailRail", () => {
  test("renders placeholder when no agent selected", () => {
    const r = render(
      <DetailRail agent={undefined} tail={[]} />,
    );
    expect(r.toString()).toContain("Select an agent");
  });

  test("renders task + cost + handoffs for selected agent", () => {
    const r = render(<DetailRail agent={baseAgent} tail={["line 1", "line 2"]} />);
    const out = r.toString();
    expect(out).toContain("alpha");
    expect(out).toContain("edit login.ts");
    expect(out).toContain("$1.18");
    expect(out).toContain("1 pending out");
    expect(out).toContain("line 2");
  });

  test("approval section appears only when health is approval", () => {
    const approvalAgent: FleetAgent = {
      ...baseAgent,
      health: { kind: "approval", cmd: "rm -rf foo" },
      pendingApproval: { sessionName: "s", agentRole: "coder", command: "rm -rf foo" },
    };
    const r = render(<DetailRail agent={approvalAgent} tail={[]} />);
    expect(r.toString()).toContain("rm -rf foo");
    expect(r.toString()).toContain("[y]allow");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/detail-rail.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Create `detail-rail.tsx`**

```tsx
/**
 * Detail rail — selected-agent context (issue #193).
 *
 * Stacked sections: header, approval (when present), task, tail, handoffs,
 * cost, action footer.
 */

import React from "react";
import { theme } from "../../theme.js";
import type { AgentHealth } from "./agent-health.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface DetailRailProps {
  readonly agent: FleetAgent | undefined;
  readonly tail: readonly string[];
}

const mins = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

function healthHeader(h: AgentHealth): { text: string; color: string } {
  switch (h.kind) {
    case "running": return { text: "RUNNING", color: theme.running };
    case "idle": return { text: "IDLE", color: theme.idle };
    case "approval": return { text: "APPROVAL PENDING", color: theme.warning };
    case "blocked": return { text: `BLOCKED ${mins(h.sinceMs)} on ${h.on}`, color: theme.error };
    case "stuck": return { text: `STUCK ${mins(h.sinceMs)}`, color: theme.warning };
    case "thrashing": return { text: `THRASHING (${h.retries} retries)`, color: theme.warning };
    case "silent": return { text: `SILENT ${mins(h.sinceMs)}`, color: theme.warning };
    case "error": return { text: `ERROR: ${h.reason}`, color: theme.error };
    case "expired": return { text: "EXPIRED", color: theme.idle };
  }
}

export const DetailRail = React.memo(function DetailRail({
  agent,
  tail,
}: DetailRailProps): React.ReactNode {
  if (!agent) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text opacity={0.5}>Select an agent (j/k) to view context</text>
      </box>
    );
  }

  const hdr = healthHeader(agent.health);

  return (
    <box flexDirection="column" paddingX={1}>
      <box flexDirection="row" marginBottom={1}>
        <text bold>{agent.agentName}</text>
        <text color={theme.secondary}>{`  (${agent.role}/${agent.platform})  `}</text>
        <text color={hdr.color} bold>{hdr.text}</text>
      </box>

      {agent.health.kind === "approval" ? (
        <box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={theme.warning} paddingX={1}>
          <text color={theme.warning} bold>Wants to run:</text>
          <text>{agent.health.cmd}</text>
          <text color={theme.secondary}>[y]allow [n]deny [a]always</text>
        </box>
      ) : null}

      <box flexDirection="column" marginBottom={1}>
        <text color={theme.secondary} bold>Task</text>
        <text>{agent.currentTask ?? "(no task)"}</text>
        <text color={theme.secondary}>target: {agent.claim.spec?.targetRef ?? "-"}</text>
      </box>

      <box flexDirection="column" marginBottom={1}>
        <text color={theme.secondary} bold>Tail</text>
        {tail.length === 0 ? (
          <text opacity={0.4}>(no output)</text>
        ) : (
          tail.slice(-8).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ephemeral lines
            <text key={i}>{line}</text>
          ))
        )}
      </box>

      <box flexDirection="row" marginBottom={1}>
        <text color={theme.secondary}>Handoffs: </text>
        <text>{`${agent.handoffs.pendingOut} pending out`}</text>
        {agent.handoffs.overdueIn > 0 ? (
          <text color={theme.error}>{`  ${agent.handoffs.overdueIn} overdue in`}</text>
        ) : null}
        {agent.handoffs.blockedOn ? (
          <text color={theme.error}>{`  blocked on ${agent.handoffs.blockedOn}`}</text>
        ) : null}
      </box>

      <box flexDirection="row" marginBottom={1}>
        <text color={theme.secondary}>Cost: </text>
        <text>{agent.cost ? `$${agent.cost.usd.toFixed(2)} · ${agent.cost.tokens.toLocaleString()} tok` : "-"}</text>
      </box>

      <box flexDirection="row">
        <text color={theme.secondary}>[t]ail [d]ag [r]eroute [K]ill [m]essage</text>
      </box>
    </box>
  );
});
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/detail-rail.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/detail-rail.tsx src/tui/screens/supervision/detail-rail.test.tsx
git commit -m "feat(tui): detail rail with stacked sections (#193)"
```

---

## Task 7: Pure supervision keyboard router

**Files:**
- Create: `src/tui/screens/supervision/supervision-keyboard.ts`
- Create: `src/tui/screens/supervision/supervision-keyboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/supervision-keyboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  routeSupervisionKey,
  type SupervisionKeyboardActions,
  type SupervisionKeyboardState,
} from "./supervision-keyboard.js";
import type { AgentHealth } from "./agent-health.js";

function calls() {
  const log: string[] = [];
  const actions: SupervisionKeyboardActions = {
    moveCursor: (delta) => log.push(`move:${delta}`),
    pinSelection: () => log.push("pin"),
    jumpTop: () => log.push("top"),
    jumpBottom: () => log.push("bottom"),
    approve: () => log.push("approve"),
    deny: () => log.push("deny"),
    always: () => log.push("always"),
    openTail: () => log.push("tail"),
    openDag: () => log.push("dag"),
    reroute: () => log.push("reroute"),
    kill: () => log.push("kill"),
    openMessage: () => log.push("msg"),
  };
  return { actions, log };
}

function state(over: Partial<SupervisionKeyboardState> = {}): SupervisionKeyboardState {
  return {
    fleetSize: 3,
    selectedHealth: { kind: "running" } as AgentHealth,
    ...over,
  };
}

describe("routeSupervisionKey", () => {
  test("j moves cursor down, k moves up", () => {
    const { actions, log } = calls();
    routeSupervisionKey({ name: "j" }, state(), actions);
    routeSupervisionKey({ name: "k" }, state(), actions);
    expect(log).toEqual(["move:1", "move:-1"]);
  });

  test("y triggers approve only when health is approval", () => {
    const { actions: a1, log: l1 } = calls();
    routeSupervisionKey(
      { name: "y" },
      state({ selectedHealth: { kind: "approval", cmd: "rm" } }),
      a1,
    );
    expect(l1).toEqual(["approve"]);

    const { actions: a2, log: l2 } = calls();
    routeSupervisionKey({ name: "y" }, state(), a2);
    expect(l2).toEqual([]);
  });

  test("r triggers reroute only when blocked", () => {
    const { actions, log } = calls();
    routeSupervisionKey(
      { name: "r" },
      state({ selectedHealth: { kind: "blocked", on: "x", sinceMs: 9e5 } }),
      actions,
    );
    expect(log).toEqual(["reroute"]);
  });

  test("returns true when handled, false otherwise", () => {
    const { actions } = calls();
    expect(routeSupervisionKey({ name: "j" }, state(), actions)).toBe(true);
    expect(routeSupervisionKey({ name: "z" }, state(), actions)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/supervision-keyboard.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `supervision-keyboard.ts`**

```ts
/**
 * Pure keyboard router for the supervision body (issue #193).
 *
 * Returns true if it consumed the key. Caller passes through to the global
 * router otherwise.
 */

import type { AgentHealth } from "./agent-health.js";
import { actionEnabled } from "./supervision-actions.js";

export interface SupervisionKey {
  readonly name: string;
}

export interface SupervisionKeyboardState {
  readonly fleetSize: number;
  readonly selectedHealth: AgentHealth | undefined;
}

export interface SupervisionKeyboardActions {
  readonly moveCursor: (delta: number) => void;
  readonly pinSelection: () => void;
  readonly jumpTop: () => void;
  readonly jumpBottom: () => void;
  readonly approve: () => void;
  readonly deny: () => void;
  readonly always: () => void;
  readonly openTail: () => void;
  readonly openDag: () => void;
  readonly reroute: () => void;
  readonly kill: () => void;
  readonly openMessage: () => void;
}

export function routeSupervisionKey(
  key: SupervisionKey,
  state: SupervisionKeyboardState,
  actions: SupervisionKeyboardActions,
): boolean {
  const health = state.selectedHealth;
  switch (key.name) {
    case "j":
      actions.moveCursor(1);
      return true;
    case "k":
      actions.moveCursor(-1);
      return true;
    case "return":
    case "enter":
      actions.pinSelection();
      return true;
    case "g":
      actions.jumpTop();
      return true;
    case "G":
      actions.jumpBottom();
      return true;
    case "y":
      if (health && actionEnabled("approve", health)) {
        actions.approve();
        return true;
      }
      return false;
    case "n":
      if (health && actionEnabled("deny", health)) {
        actions.deny();
        return true;
      }
      return false;
    case "a":
      if (health && actionEnabled("always", health)) {
        actions.always();
        return true;
      }
      return false;
    case "t":
      if (health && actionEnabled("tail", health)) {
        actions.openTail();
        return true;
      }
      return false;
    case "d":
      if (health && actionEnabled("dag", health)) {
        actions.openDag();
        return true;
      }
      return false;
    case "r":
      if (health && actionEnabled("reroute", health)) {
        actions.reroute();
        return true;
      }
      return false;
    case "K":
      if (health && actionEnabled("kill", health)) {
        actions.kill();
        return true;
      }
      return false;
    case "m":
      if (health && actionEnabled("message", health)) {
        actions.openMessage();
        return true;
      }
      return false;
    default:
      return false;
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/supervision-keyboard.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/supervision-keyboard.ts src/tui/screens/supervision/supervision-keyboard.test.ts
git commit -m "feat(tui): supervision keyboard router (#193)"
```

---

## Task 8: `<Supervision>` composition + state

**Files:**
- Create: `src/tui/screens/supervision/supervision.tsx`
- Create: `src/tui/screens/supervision/supervision.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/tui/screens/supervision/supervision.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "@opentui/react";
import { Supervision } from "./supervision.js";
import type { FleetAgent } from "./use-fleet-model.js";

function agent(over: Partial<FleetAgent>): FleetAgent {
  return {
    agentId: "a",
    agentName: "agent-a",
    role: "coder",
    platform: "claude",
    session: undefined,
    claim: { spec: { targetRef: "t" } } as FleetAgent["claim"],
    health: { kind: "running" },
    currentTask: "task",
    lastAction: undefined,
    lastOutputAt: undefined,
    cost: undefined,
    handoffs: { pendingOut: 0, overdueIn: 0 },
    pendingApproval: undefined,
    attemptCount: 0,
    ...over,
  };
}

describe("Supervision", () => {
  test("auto-selects highest-priority agent on mount", () => {
    const r = render(
      <Supervision
        agents={[
          agent({ agentId: "ok", health: { kind: "running" } }),
          agent({ agentId: "bad", health: { kind: "error", reason: "boom" } }),
        ]}
        tail={[]}
        actions={{}}
      />,
    );
    const out = r.toString();
    // detail rail header echoes agent name when selected
    expect(out).toContain("bad");
    expect(out).toContain("ERROR: boom");
  });

  test("placeholder when fleet empty", () => {
    const r = render(<Supervision agents={[]} tail={[]} actions={{}} />);
    expect(r.toString()).toContain("No agents registered");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/supervision/supervision.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `supervision.tsx`**

```tsx
/**
 * Supervision body — fleet rail + detail rail (issue #193).
 *
 * Owns selection state. Auto-selects the highest-priority agent until the
 * operator pins (Enter). On new approval, auto-selects the approving agent
 * unless pinned.
 *
 * Keyboard wiring lives in the caller (running-view.tsx) via
 * routeSupervisionKey + the actions passed in here.
 */

import React, { useEffect, useRef, useState } from "react";
import { theme } from "../../theme.js";
import { DetailRail } from "./detail-rail.js";
import { FleetRail } from "./fleet-rail.js";
import type { FleetAgent } from "./use-fleet-model.js";

export interface SupervisionProps {
  readonly agents: readonly FleetAgent[];
  readonly tail: readonly string[];
  /** Optional callbacks for tests; production wiring lives in running-view. */
  readonly actions: Partial<{
    onSelect: (agentId: string | undefined) => void;
  }>;
}

export const Supervision = React.memo(function Supervision({
  agents,
  tail,
  actions,
}: SupervisionProps): React.ReactNode {
  const [cursor, setCursor] = useState(0);
  const [pinnedAgentId, setPinnedAgentId] = useState<string | undefined>(undefined);
  const lastApprovalRef = useRef<string | undefined>(undefined);

  // Clamp cursor when fleet size changes.
  useEffect(() => {
    if (cursor >= agents.length) setCursor(Math.max(0, agents.length - 1));
  }, [agents.length, cursor]);

  // Auto-select on new approval (unless operator has pinned someone else).
  useEffect(() => {
    const approval = agents.find((a) => a.health.kind === "approval");
    if (approval && approval.agentId !== lastApprovalRef.current) {
      lastApprovalRef.current = approval.agentId;
      if (!pinnedAgentId) {
        const idx = agents.findIndex((a) => a.agentId === approval.agentId);
        if (idx >= 0) setCursor(idx);
      }
    } else if (!approval) {
      lastApprovalRef.current = undefined;
    }
  }, [agents, pinnedAgentId]);

  const selectedAgent =
    (pinnedAgentId
      ? agents.find((a) => a.agentId === pinnedAgentId)
      : agents[cursor]) ?? agents[0];

  useEffect(() => {
    actions.onSelect?.(selectedAgent?.agentId);
  }, [selectedAgent?.agentId, actions]);

  // Mark `setPinnedAgentId` as intentionally unused-via-prop here; the caller
  // wires Enter through actions in a follow-up commit. Keep the setter alive
  // for future use without lint complaints.
  void setPinnedAgentId;

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexBasis="40%" paddingX={1}>
        <FleetRail
          agents={agents}
          cursor={cursor}
          selectedAgentId={selectedAgent?.agentId}
        />
      </box>
      <box
        flexDirection="column"
        flexBasis="60%"
        borderStyle="round"
        borderColor={theme.focus}
      >
        <DetailRail agent={selectedAgent} tail={tail} />
      </box>
    </box>
  );
});
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/supervision/supervision.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/supervision/supervision.tsx src/tui/screens/supervision/supervision.test.tsx
git commit -m "feat(tui): supervision composition root (#193)"
```

---

## Task 9: Additive `filterAgentId` prop on `DagView` and `HandoffsView`

**Why:** When the operator presses `d` (open DAG) or `5` (handoffs) from supervision, the drilled-down view should highlight or narrow to the selected agent.

**Files:**
- Modify: `src/tui/views/dag.tsx`
- Modify: `src/tui/views/handoffs-view.tsx`
- Modify: `src/tui/views/dag.test.tsx` (extend)
- Modify: `src/tui/views/handoffs-view.test.tsx` (create if missing)

- [ ] **Step 1: Write the failing test for DagView (extend `dag.test.tsx`)**

Append to `src/tui/views/dag.test.tsx`:

```tsx
test("renders without crash when filterAgentId prop is supplied", () => {
  const r = render(
    <DagView
      provider={{} as unknown as never}
      active={false}
      cursor={0}
      filterAgentId="agent-a"
    />,
  );
  expect(r).toBeDefined();
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/views/dag.test.tsx -t filterAgentId`
Expected: FAIL — prop type does not include `filterAgentId`.

- [ ] **Step 3: Add the prop**

Edit `src/tui/views/dag.tsx`, append to `DagProps` (around line 132):

```ts
  /** Optional: when set, the DAG biases focus / highlights toward this
   *  agent. Default behavior (unfiltered) is preserved when omitted. */
  readonly filterAgentId?: string | undefined;
```

Edit the component signature to accept it, but do not implement narrowing in this task — that's a follow-up. The prop is plumbed for callers; behavior change is out of scope.

Same change for `src/tui/views/handoffs-view.tsx` — append to `HandoffsViewProps`:

```ts
  /** Optional: scope handoffs to those touching this agent's role. */
  readonly filterAgentId?: string | undefined;
```

Inside `HandoffsView`, narrow the fetched result:

```ts
const scoped =
  filterAgentId
    ? handoffs.filter((h) =>
        // best-effort: match by role from agentId prefix
        h.fromRole === filterAgentId || h.toRole === filterAgentId,
      )
    : handoffs;
```

…and use `scoped` where `handoffs` is consumed in the render block.

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/views/dag.test.tsx src/tui/views/handoffs-view.test.ts*`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/views/dag.tsx src/tui/views/handoffs-view.tsx src/tui/views/dag.test.tsx
git commit -m "feat(tui): additive filterAgentId on dag and handoffs views (#193)"
```

---

## Task 10: Wire `GROVE_SUPERVISION` flag into `RunningView`

**Files:**
- Modify: `src/tui/screens/running-view.tsx`

- [ ] **Step 1: Read the supervision-flag gate location**

Open `src/tui/screens/running-view.tsx`. Find the module-scope env gate near line 114:

```ts
const useLogView = process.env.GROVE_LOGVIEW === "1";
```

- [ ] **Step 2: Add the supervision gate next to it**

Insert after the `useLogView` line:

```ts
const useSupervision = process.env.GROVE_SUPERVISION === "1";
```

- [ ] **Step 3: Import the supervision module**

Near the other view imports (after line 55 `import { VfsBrowserView }`), add:

```ts
import { Supervision } from "./supervision/supervision.js";
import { useFleetModel } from "./supervision/use-fleet-model.js";
import { routeSupervisionKey } from "./supervision/supervision-keyboard.js";
```

- [ ] **Step 4: Call `useFleetModel` near the existing data hooks**

Inside `RunningView`, after `dashboard` is defined (around line 535), add:

```ts
const fleet = useFleetModel({
  provider,
  monitor,
  agentFailures,
  tmux,
  filterText: filterQuery,
  active: useSupervision && expandedPanel === null,
});

const [selectedSupervisionAgent, setSelectedSupervisionAgent] = useState<string | undefined>(undefined);
const selectedAgent = useMemo(
  () => fleet.find((a) => a.agentId === selectedSupervisionAgent) ?? fleet[0],
  [fleet, selectedSupervisionAgent],
);
const selectedRole = selectedAgent?.role;
const selectedTail = useMemo<readonly string[]>(
  () => (selectedRole ? monitor.agentOutputs.get(selectedRole) ?? [] : []),
  [selectedRole, monitor.agentOutputs],
);
```

- [ ] **Step 5: Swap the default body**

Find the no-panel-expanded render path. Search for `renderAgentSection(` and the surrounding block (around line 1404–1426). Replace that block with a flag-gated branch:

```tsx
{useSupervision ? (
  <Supervision
    agents={fleet}
    tail={selectedTail}
    actions={{ onSelect: (id) => setSelectedSupervisionAgent(id) }}
  />
) : (
  <>
    {renderAgentSection(
      topology,
      dashboard,
      monitor,
      agentFailures,
      sessionStartedAt,
      feed.length,
    )}
    {renderFeedSection(
      feed,
      cursor,
      goal,
      pendingAskUser,
      frontier,
      autoFollow,
      newSinceFreeze,
      activeRoles,
      agentFailures,
    )}
  </>
)}
```

- [ ] **Step 6: Wire the supervision keyboard router**

Inside the existing `useKeyboard(...)` handler (search for `routeRunningKey`), add a guard before the global router:

```ts
if (useSupervision && expandedPanel === null) {
  const handled = routeSupervisionKey(
    { name: key.name },
    {
      fleetSize: fleet.length,
      selectedHealth: selectedAgent?.health,
    },
    {
      moveCursor: (delta) => {
        const idx = Math.max(0, Math.min(fleet.length - 1, (cursor ?? 0) + delta));
        setCursor(idx);
        setSelectedSupervisionAgent(fleet[idx]?.agentId);
      },
      pinSelection: () => setSelectedSupervisionAgent(selectedAgent?.agentId),
      jumpTop: () => {
        setCursor(0);
        setSelectedSupervisionAgent(fleet[0]?.agentId);
      },
      jumpBottom: () => {
        const last = Math.max(0, fleet.length - 1);
        setCursor(last);
        setSelectedSupervisionAgent(fleet[last]?.agentId);
      },
      approve: () => {
        const p = selectedAgent?.pendingApproval;
        if (p && tmux) void tmux.sendKeys(p.sessionName, "y");
      },
      deny: () => {
        const p = selectedAgent?.pendingApproval;
        if (p && tmux) void tmux.sendKeys(p.sessionName, "n");
      },
      always: () => {
        const p = selectedAgent?.pendingApproval;
        if (p && tmux) void tmux.sendKeys(p.sessionName, "a");
      },
      openTail: () => actions.expandPanel(RunningPanel.Terminal),
      openDag: () => actions.expandPanel(RunningPanel.Dag),
      reroute: () => {
        // Reroute lands with #163; surface a flash message until then.
        setFlashError("Reroute lands with #163");
      },
      kill: () => {
        // No provider.revokeClaim today; flash a placeholder until that lands.
        // Tracked as follow-up in the spec's "Out of scope" section.
        setFlashError("Kill action lands with claim-revoke provider API");
      },
      openMessage: () => {
        if (selectedRole) {
          setPromptMode(true);
          setPromptTarget(
            (activeRoles ?? []).findIndex((r) => r === selectedRole),
          );
        }
      },
    },
  );
  if (handled) return;
}
```

Note: `cursor` and `setCursor` are reused from the existing `RunningView` state (the cmd-mode / feed cursor). If that's not desirable, declare a new local `[fleetCursor, setFleetCursor]` and use those instead — same wiring.

- [ ] **Step 7: Run the full TUI test suite to confirm no regressions**

Run: `bun test src/tui/`
Expected: PASS — all existing tests still pass with `GROVE_SUPERVISION` unset.

- [ ] **Step 8: Manual smoke with the flag on**

```bash
GROVE_SUPERVISION=1 bun run grove up
```
Expected: TUI launches; default body is the fleet+detail rail. With the flag unset (`bun run grove up`), the old feed+agents body renders.

- [ ] **Step 9: Commit**

```bash
git add src/tui/screens/running-view.tsx
git commit -m "feat(tui): GROVE_SUPERVISION flag swaps default body to fleet/detail rail (#193)"
```

---

## Task 11: Remove floating Permission Request box when supervision is on

**Files:**
- Modify: `src/tui/screens/running-view.tsx`

The floating overlay (`monitor.pendingPermissions.length > 0` block at lines ~1873–1894) now lives inside DetailRail. With `GROVE_SUPERVISION=1` it must not render, or operator sees duplicate prompts.

- [ ] **Step 1: Write a regression test**

Create `src/tui/screens/running-view-supervision.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "@opentui/react";
// Minimal RunningView harness: only the bottom chrome render path is exercised.
import { renderBottomChromeForTest } from "./running-view.js";

describe("renderBottomChrome under GROVE_SUPERVISION", () => {
  test("does not render the Permission Request overlay when supervision is on", () => {
    const r = renderBottomChromeForTest({
      supervisionOn: true,
      pendingPermissions: [
        { sessionName: "s", agentRole: "coder", command: "rm -rf x" },
      ],
    });
    expect(r.toString()).not.toContain("Permission Request");
  });

  test("still renders the overlay when supervision is off", () => {
    const r = renderBottomChromeForTest({
      supervisionOn: false,
      pendingPermissions: [
        { sessionName: "s", agentRole: "coder", command: "rm -rf x" },
      ],
    });
    expect(r.toString()).toContain("Permission Request");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test src/tui/screens/running-view-supervision.test.tsx`
Expected: FAIL — `renderBottomChromeForTest` not exported.

- [ ] **Step 3: Extract and gate the overlay**

In `src/tui/screens/running-view.tsx`, modify `renderBottomChrome` (around line 1856–1956). Replace:

```tsx
{monitor.pendingPermissions.length > 0 ? (
  <box ...>...Permission Request...</box>
) : null}
```

with:

```tsx
{!supervisionOn && monitor.pendingPermissions.length > 0 ? (
  <box ...>...Permission Request...</box>
) : null}
```

Add `supervisionOn` to `renderBottomChrome`'s parameter list; pass `useSupervision` from the caller. Export a thin test wrapper:

```tsx
export function renderBottomChromeForTest(args: {
  readonly supervisionOn: boolean;
  readonly pendingPermissions: readonly PermissionPrompt[];
}): React.ReactNode {
  return renderBottomChrome(
    {
      pendingPermissions: args.pendingPermissions,
      ipcMessages: [],
      agentOutputs: new Map(),
      agentOutputTimestamps: new Map(),
      spinnerFrame: 0,
    },
    false,
    undefined,
    undefined,
    false,
    "",
    0,
    undefined,
    { mode: "none", text: "", suggestionIndex: 0, history: [] } as never,
    [],
    null,
    args.supervisionOn,
  );
}
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `bun test src/tui/screens/running-view-supervision.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/screens/running-view.tsx src/tui/screens/running-view-supervision.test.tsx
git commit -m "feat(tui): hide floating Permission Request when supervision body owns it (#193)"
```

---

## Task 12: Help overlay — add Supervision section

**Files:**
- Modify: `src/tui/screens/running-view.tsx` (the `renderHelpOverlay` function around line 1959)

- [ ] **Step 1: Locate the help overlay function**

Find `function renderHelpOverlay()` near line 1959. Note its structure: a column of `<text>` entries.

- [ ] **Step 2: Append a Supervision section**

Inside `renderHelpOverlay`, after the existing key list, before the closing `</box>`, append:

```tsx
<text> </text>
<text color={theme.focus} bold>
  Supervision (GROVE_SUPERVISION=1)
</text>
<text color={theme.text}> j/k Move fleet cursor / G g top/bottom</text>
<text color={theme.text}> Enter Pin selection</text>
<text color={theme.text}> y/n/a Approve / deny / always-allow</text>
<text color={theme.text}> t Open Terminal (scoped to selected)</text>
<text color={theme.text}> d Open DAG (scoped to selected)</text>
<text color={theme.text}> r Reroute blocked handoff</text>
<text color={theme.text}> K Kill / revoke claim</text>
<text color={theme.text}> m Message the selected agent</text>
```

- [ ] **Step 3: Manual verify**

```bash
GROVE_SUPERVISION=1 bun run grove up
# press ? to open help overlay
```
Expected: New Supervision section appears at the bottom.

- [ ] **Step 4: Commit**

```bash
git add src/tui/screens/running-view.tsx
git commit -m "docs(tui): help overlay lists supervision shortcuts (#193)"
```

---

## Task 13: E2E smoke — supervision with two ACPX agents

**Files:**
- Create: `tests/tui/supervision-e2e.ts`

This is an integration test that follows the launch recipe in `[[project_pr438_logview_validated]]`. Use `grove up`, hit Nexus stores. Force one agent into stalled state and assert the lane shows `SILENT` plus detail-rail tail.

- [ ] **Step 1: Copy the existing tmux+grove harness as the starting point**

Use `tests/tui/typed-acp-tmux-e2e.ts` as the template. Copy it to `tests/tui/supervision-e2e.ts`. Replace the assertion section with the supervision-specific checks below.

- [ ] **Step 2: Add supervision-specific assertions**

Inside the test body, after launching grove with two ACPX agents (coder + reviewer):

```ts
// Force the reviewer into silent state: kill its tmux pane writer.
await tmux.sendKeys(`grove-reviewer-${runId}`, "C-c");
// Wait beyond SILENT_MS (5m) — for the test, override via env:
process.env.GROVE_SUPERVISION_SILENT_MS = "2000";
await sleep(3000);

const frame = await captureTuiFrame();
expect(frame).toContain("Fleet (2");
expect(frame).toContain("SILENT");
expect(frame).toContain("reviewer");
```

- [ ] **Step 3: Run the smoke**

Run: `GROVE_SUPERVISION=1 bun test tests/tui/supervision-e2e.ts --timeout 120000`
Expected: PASS — the captured frame contains the SILENT badge on the reviewer lane.

- [ ] **Step 4: Commit**

```bash
git add tests/tui/supervision-e2e.ts
git commit -m "test(tui): supervision e2e — silent agent surfaces in fleet rail (#193)"
```

---

## Wrap-up

After Task 13:

```bash
bun test                               # full suite
bun run check                          # biome/lint
GROVE_SUPERVISION=1 bun run grove up   # final manual smoke
```

Open a draft PR titled `feat(tui): supervision hero surface (#193)` with the spec link in the description. Mark it draft until the env-flag flip is approved.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `AgentHealth` union + thresholds | Task 2 |
| Derivation rules (error → idle priority) | Task 2 |
| `FleetAgent` shape | Task 4 |
| Sort order (problem-first) | Task 4 |
| `useAgentMonitor` extension (`agentOutputTimestamps`) | Task 1 |
| `<FleetRail>` lane rendering | Task 5 |
| `<DetailRail>` stacked sections + approval | Task 6 |
| `<Supervision>` selection state + auto-select | Task 8 |
| Supervision keyboard routing | Task 7 (router) + Task 10 (wiring) |
| Drill-down inherits selection (filterAgentId) | Task 9 |
| Flag-gated body swap | Task 10 |
| Floating Permission Request overlay removal | Task 11 |
| Help overlay update | Task 12 |
| Integration smoke | Task 13 |

Out-of-scope items are tracked in the spec's "Out of scope" section; do not implement reroute, contribution history, per-agent IPC filter, or collapsible detail sections in this plan.
