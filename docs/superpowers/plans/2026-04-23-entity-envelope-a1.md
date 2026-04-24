# Entity Envelope (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `Entity<Kind, Spec, Status>` envelope + Condition type in `src/core/entity.ts`, pure adapters for Contribution / Claim / AgentSession, and a `ConditionChips` TUI component rendered in the contribution detail view — satisfying issue #287 acceptance criteria.

**Architecture:** Adapter-based (strategy B from spec). No store or provider changes. All envelope logic lives in one new source file. Conditions are derived deterministically from existing flat-type fields; the AgentSession adapter takes an optional clock for test determinism.

**Tech Stack:** TypeScript (Bun), Bun test runner, React + OpenTUI (Ink-like `<box>`/`<text>` primitives), existing `src/tui/theme.ts` color tokens.

**Spec:** `docs/superpowers/specs/2026-04-23-entity-envelope-a1-design.md`

---

## File Structure

**New files:**

- `src/core/entity.ts` — envelope, Condition, per-kind Spec/Status types, three adapter functions. Single responsibility: Entity projection.
- `src/core/entity.test.ts` — adapter unit tests.
- `src/tui/components/condition-chips.tsx` — render a `Condition[]` as colored chips. Kind-agnostic.
- `src/tui/components/condition-chips.test.ts` — prop-contract + color-mapping tests (pure logic, no renderer — matches `empty-state.test.ts` pattern already in the codebase).

**Modified files:**

- `src/core/index.ts` — add re-exports for Entity surface.
- `src/tui/views/detail.tsx` — import adapter + component, render `<ConditionChips/>` above the metadata block.

---

## Task 1: Envelope + Condition types

**Files:**
- Create: `src/core/entity.ts`
- Test: `src/core/entity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/entity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Condition, ConditionStatus, Entity, EntityMetadata } from "./entity.js";

describe("Entity envelope types", () => {
  test("Condition has the five required fields", () => {
    const c: Condition = {
      type: "Ready",
      status: "True",
      observedGeneration: 1,
      lastTransitionTime: "2026-04-23T00:00:00Z",
      reason: "Started",
      message: "",
    };
    expect(c.type).toBe("Ready");
    expect(c.status).toBe("True");
  });

  test("ConditionStatus allows True | False | Unknown", () => {
    const values: ConditionStatus[] = ["True", "False", "Unknown"];
    expect(values).toHaveLength(3);
  });

  test("EntityMetadata requires generation, optional creationTimestamp", () => {
    const m: EntityMetadata = { generation: 1 };
    expect(m.generation).toBe(1);
    expect(m.creationTimestamp).toBeUndefined();
  });

  test("Entity envelope carries kind discriminant and all envelope fields", () => {
    type Foo = Entity<"Foo", { name: string }, { phase: string }>;
    const e: Foo = {
      kind: "Foo",
      namespace: "default",
      id: "foo-1",
      spec: { name: "x" },
      status: { phase: "ready" },
      conditions: [],
      observedGeneration: 0,
      resourceVersion: "0",
      metadata: { generation: 1 },
    };
    expect(e.kind).toBe("Foo");
    expect(e.namespace).toBe("default");
    expect(e.spec.name).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/entity.test.ts`
Expected: FAIL — module `./entity.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/entity.ts`:

```ts
/**
 * Entity<Kind, Spec, Status> — Kubernetes-style envelope for domain objects.
 *
 * This file only defines the envelope shape and per-kind projections for
 * Contribution, Claim, AgentSession. Stores still return the flat types;
 * callers project to Entity via the adapters in this module.
 *
 * Namespace is hardcoded to "default" until #290 lands server-enforced
 * isolation. That is the only call-site that needs to change.
 */

export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  readonly type: string;
  readonly status: ConditionStatus;
  readonly observedGeneration: number;
  readonly lastTransitionTime: string;
  readonly reason: string;
  readonly message: string;
}

export interface OwnerRef {
  readonly kind: string;
  readonly id: string;
}

export interface EntityMetadata {
  readonly generation: number;
  readonly creationTimestamp?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly ownerRefs?: readonly OwnerRef[] | undefined;
}

export interface Entity<K extends string, Spec, Status> {
  readonly kind: K;
  readonly namespace: string;
  readonly id: string;
  readonly spec: Spec;
  readonly status: Status;
  readonly conditions: readonly Condition[];
  readonly observedGeneration: number;
  readonly resourceVersion: string;
  readonly metadata: EntityMetadata;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/entity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/entity.ts src/core/entity.test.ts
git commit -m "feat(core): Entity<K,Spec,Status> envelope + Condition types (#287)"
```

---

## Task 2: Contribution adapter

**Files:**
- Modify: `src/core/entity.ts`
- Modify: `src/core/entity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/entity.test.ts`:

```ts
import type { Contribution } from "./models.js";
import { ContributionKind, ContributionMode } from "./models.js";
import type { ContributionEntity } from "./entity.js";
import { contributionToEntity } from "./entity.js";

function makeContribution(overrides: Partial<Contribution> = {}): Contribution {
  return {
    cid: "cid-1",
    manifestVersion: 1,
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "s",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1" },
    createdAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

describe("contributionToEntity", () => {
  test("wraps cid as id, namespace=default", () => {
    const e: ContributionEntity = contributionToEntity(makeContribution());
    expect(e.kind).toBe("Contribution");
    expect(e.id).toBe("cid-1");
    expect(e.namespace).toBe("default");
  });

  test("projects domain kind into spec.contributionKind", () => {
    const e = contributionToEntity(
      makeContribution({ kind: ContributionKind.Review }),
    );
    expect(e.spec.contributionKind).toBe("review");
  });

  test("status is empty object (immutable kind)", () => {
    const e = contributionToEntity(makeContribution());
    expect(e.status).toEqual({});
  });

  test("resourceVersion=0, observedGeneration=0, metadata.generation=1", () => {
    const e = contributionToEntity(makeContribution());
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
    expect(e.metadata.creationTimestamp).toBe("2026-04-23T00:00:00Z");
  });

  test("Published condition is always True with reason=Created", () => {
    const e = contributionToEntity(makeContribution());
    expect(e.conditions).toHaveLength(1);
    const published = e.conditions[0];
    expect(published?.type).toBe("Published");
    expect(published?.status).toBe("True");
    expect(published?.reason).toBe("Created");
    expect(published?.lastTransitionTime).toBe("2026-04-23T00:00:00Z");
  });

  test("preserves all spec fields from the contribution", () => {
    const c = makeContribution({
      summary: "hello",
      description: "full",
      tags: ["a", "b"],
      commitHash: "abc123",
    });
    const e = contributionToEntity(c);
    expect(e.spec.summary).toBe("hello");
    expect(e.spec.description).toBe("full");
    expect(e.spec.tags).toEqual(["a", "b"]);
    expect(e.spec.commitHash).toBe("abc123");
    expect(e.spec.agent).toEqual({ agentId: "agent-1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/entity.test.ts`
Expected: FAIL — `contributionToEntity` / `ContributionEntity` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/entity.ts`:

```ts
import type {
  AgentIdentity,
  Contribution,
  ContributionKind,
  ContributionMode,
  JsonValue,
  Relation,
  Score,
} from "./models.js";

export interface ContributionSpec {
  readonly contributionKind: ContributionKind;
  readonly mode: ContributionMode;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly commitHash?: string | undefined;
  readonly relations: readonly Relation[];
  readonly scores?: Readonly<Record<string, Score>> | undefined;
  readonly tags: readonly string[];
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly agent: AgentIdentity;
}

export type ContributionStatus = Record<string, never>;

export type ContributionEntity = Entity<
  "Contribution",
  ContributionSpec,
  ContributionStatus
>;

export function contributionToEntity(c: Contribution): ContributionEntity {
  const published: Condition = {
    type: "Published",
    status: "True",
    observedGeneration: 0,
    lastTransitionTime: c.createdAt,
    reason: "Created",
    message: "",
  };
  return {
    kind: "Contribution",
    namespace: "default",
    id: c.cid,
    spec: {
      contributionKind: c.kind,
      mode: c.mode,
      summary: c.summary,
      description: c.description,
      artifacts: c.artifacts,
      commitHash: c.commitHash,
      relations: c.relations,
      scores: c.scores,
      tags: c.tags,
      context: c.context,
      agent: c.agent,
    },
    status: {},
    conditions: [published],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: {
      generation: 1,
      creationTimestamp: c.createdAt,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/entity.test.ts`
Expected: PASS (all tests from Task 1 + the 6 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/entity.ts src/core/entity.test.ts
git commit -m "feat(core): contributionToEntity adapter (#287)"
```

---

## Task 3: Claim adapter

**Files:**
- Modify: `src/core/entity.ts`
- Modify: `src/core/entity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/entity.test.ts`:

```ts
import type { Claim } from "./models.js";
import { ClaimStatus } from "./models.js";
import type { ClaimEntity } from "./entity.js";
import { claimToEntity } from "./entity.js";

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: "claim-1",
    targetRef: "target-x",
    agent: { agentId: "agent-1" },
    status: ClaimStatus.Active,
    intentSummary: "do x",
    createdAt: "2026-04-23T00:00:00Z",
    heartbeatAt: "2026-04-23T00:01:00Z",
    leaseExpiresAt: "2026-04-23T00:05:00Z",
    ...overrides,
  };
}

describe("claimToEntity", () => {
  test("wraps claimId as id, kind=Claim", () => {
    const e: ClaimEntity = claimToEntity(makeClaim());
    expect(e.kind).toBe("Claim");
    expect(e.id).toBe("claim-1");
    expect(e.namespace).toBe("default");
  });

  test("spec carries targetRef, agent, intentSummary, context", () => {
    const e = claimToEntity(makeClaim({ context: { k: "v" } }));
    expect(e.spec.targetRef).toBe("target-x");
    expect(e.spec.intentSummary).toBe("do x");
    expect(e.spec.context).toEqual({ k: "v" });
  });

  test("status carries phase/heartbeatAt/leaseExpiresAt/attemptCount", () => {
    const e = claimToEntity(makeClaim({ attemptCount: 2 }));
    expect(e.status.phase).toBe("active");
    expect(e.status.heartbeatAt).toBe("2026-04-23T00:01:00Z");
    expect(e.status.leaseExpiresAt).toBe("2026-04-23T00:05:00Z");
    expect(e.status.attemptCount).toBe(2);
  });

  test("attemptCount defaults to 0 when undefined on input", () => {
    const e = claimToEntity(makeClaim());
    expect(e.status.attemptCount).toBe(0);
  });

  test("revision maps to resourceVersion + observedGeneration + metadata.generation", () => {
    const e = claimToEntity(makeClaim({ revision: 7 }));
    expect(e.resourceVersion).toBe("7");
    expect(e.observedGeneration).toBe(7);
    expect(e.metadata.generation).toBe(7);
  });

  test("missing revision → resourceVersion='0', generation=1", () => {
    const e = claimToEntity(makeClaim());
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
  });

  test("active phase → Active=True, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Active }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("True");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
    expect(m.Active?.reason).toBe("active");
    expect(m.Active?.lastTransitionTime).toBe("2026-04-23T00:01:00Z");
  });

  test("expired phase → Expired=True, Active=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Expired }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("True");
    expect(m.Expired?.lastTransitionTime).toBe("2026-04-23T00:05:00Z");
  });

  test("completed phase → Completed=True, Active=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Completed }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Completed?.status).toBe("True");
    expect(m.Active?.status).toBe("False");
  });

  test("released phase → Active=False, Expired=False, Completed=False", () => {
    const e = claimToEntity(makeClaim({ status: ClaimStatus.Released }));
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Active?.status).toBe("False");
    expect(m.Expired?.status).toBe("False");
    expect(m.Completed?.status).toBe("False");
  });

  test("conditions observedGeneration mirrors entity observedGeneration", () => {
    const e = claimToEntity(makeClaim({ revision: 3 }));
    for (const c of e.conditions) {
      expect(c.observedGeneration).toBe(3);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/entity.test.ts`
Expected: FAIL — `claimToEntity` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/entity.ts`:

```ts
import type { Claim, ClaimStatus as ClaimPhase } from "./models.js";

export interface ClaimSpec {
  readonly targetRef: string;
  readonly agent: AgentIdentity;
  readonly intentSummary: string;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface ClaimStatusBody {
  readonly phase: ClaimPhase;
  readonly heartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export type ClaimEntity = Entity<"Claim", ClaimSpec, ClaimStatusBody>;

export function claimToEntity(c: Claim): ClaimEntity {
  const generation = c.revision ?? 0;
  const obs = c.revision ?? 0;
  const metaGen = c.revision ?? 1;
  const phase = c.status;

  const mkCond = (
    type: string,
    active: boolean,
    lastTransitionTime: string,
  ): Condition => ({
    type,
    status: active ? "True" : "False",
    observedGeneration: obs,
    lastTransitionTime,
    reason: phase,
    message: "",
  });

  const conditions: readonly Condition[] = [
    mkCond("Active", phase === "active", c.heartbeatAt),
    mkCond("Expired", phase === "expired", c.leaseExpiresAt),
    mkCond("Completed", phase === "completed", c.heartbeatAt),
  ];

  return {
    kind: "Claim",
    namespace: "default",
    id: c.claimId,
    spec: {
      targetRef: c.targetRef,
      agent: c.agent,
      intentSummary: c.intentSummary,
      context: c.context,
    },
    status: {
      phase,
      heartbeatAt: c.heartbeatAt,
      leaseExpiresAt: c.leaseExpiresAt,
      attemptCount: c.attemptCount ?? 0,
    },
    conditions,
    observedGeneration: obs,
    resourceVersion: String(generation),
    metadata: {
      generation: metaGen,
      creationTimestamp: c.createdAt,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/entity.test.ts`
Expected: PASS (previous tests + 10 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/entity.ts src/core/entity.test.ts
git commit -m "feat(core): claimToEntity adapter with derived conditions (#287)"
```

---

## Task 4: AgentSession adapter (with injectable clock)

**Files:**
- Modify: `src/core/entity.ts`
- Modify: `src/core/entity.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/entity.test.ts`:

```ts
import type { AgentSession } from "./agent-runtime.js";
import type { AgentSessionEntity } from "./entity.js";
import { agentSessionToEntity } from "./entity.js";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "grove-coder-1-abc",
    role: "coder",
    status: "running",
    ...overrides,
  };
}

const fixedClock = () => "2026-04-23T12:00:00Z";

describe("agentSessionToEntity", () => {
  test("wraps id as id, kind=AgentSession", () => {
    const e: AgentSessionEntity = agentSessionToEntity(makeSession(), fixedClock);
    expect(e.kind).toBe("AgentSession");
    expect(e.id).toBe("grove-coder-1-abc");
    expect(e.namespace).toBe("default");
  });

  test("spec carries role/platform/model/agent", () => {
    const e = agentSessionToEntity(
      makeSession({ platform: "claude-code", model: "sonnet", agent: "claude" }),
      fixedClock,
    );
    expect(e.spec.role).toBe("coder");
    expect(e.spec.platform).toBe("claude-code");
    expect(e.spec.model).toBe("sonnet");
    expect(e.spec.agent).toBe("claude");
  });

  test("status carries phase + pid", () => {
    const e = agentSessionToEntity(makeSession({ pid: 4242 }), fixedClock);
    expect(e.status.phase).toBe("running");
    expect(e.status.pid).toBe(4242);
  });

  test("running → Ready=True, Crashed=False", () => {
    const e = agentSessionToEntity(makeSession({ status: "running" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("True");
    expect(m.Crashed?.status).toBe("False");
    expect(m.Ready?.reason).toBe("running");
  });

  test("idle → Ready=True", () => {
    const e = agentSessionToEntity(makeSession({ status: "idle" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("True");
    expect(m.Crashed?.status).toBe("False");
  });

  test("stopped → Ready=False, Crashed=False", () => {
    const e = agentSessionToEntity(makeSession({ status: "stopped" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("False");
    expect(m.Crashed?.status).toBe("False");
  });

  test("crashed → Ready=False, Crashed=True", () => {
    const e = agentSessionToEntity(makeSession({ status: "crashed" }), fixedClock);
    const m = Object.fromEntries(e.conditions.map((c) => [c.type, c]));
    expect(m.Ready?.status).toBe("False");
    expect(m.Crashed?.status).toBe("True");
  });

  test("lastTransitionTime uses injected clock", () => {
    const e = agentSessionToEntity(makeSession(), fixedClock);
    for (const c of e.conditions) {
      expect(c.lastTransitionTime).toBe("2026-04-23T12:00:00Z");
    }
  });

  test("resourceVersion='0', metadata.generation=1, creationTimestamp undefined", () => {
    const e = agentSessionToEntity(makeSession(), fixedClock);
    expect(e.resourceVersion).toBe("0");
    expect(e.observedGeneration).toBe(0);
    expect(e.metadata.generation).toBe(1);
    expect(e.metadata.creationTimestamp).toBeUndefined();
  });

  test("default clock parameter produces an ISO string", () => {
    const e = agentSessionToEntity(makeSession());
    // Shape check only — exact value is wall-clock.
    expect(typeof e.conditions[0]?.lastTransitionTime).toBe("string");
    expect(e.conditions[0]?.lastTransitionTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/entity.test.ts`
Expected: FAIL — `agentSessionToEntity` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/entity.ts`:

```ts
import type { AgentPlatformType, AgentSession } from "./agent-runtime.js";

export interface AgentSessionSpec {
  readonly role: string;
  readonly platform?: AgentPlatformType | undefined;
  readonly model?: string | undefined;
  readonly agent?: string | undefined;
}

export interface AgentSessionStatusBody {
  readonly phase: "running" | "idle" | "stopped" | "crashed";
  readonly pid?: number | undefined;
}

export type AgentSessionEntity = Entity<
  "AgentSession",
  AgentSessionSpec,
  AgentSessionStatusBody
>;

export function agentSessionToEntity(
  s: AgentSession,
  now: () => string = () => new Date().toISOString(),
): AgentSessionEntity {
  const t = now();
  const phase = s.status;
  const mkCond = (type: string, active: boolean): Condition => ({
    type,
    status: active ? "True" : "False",
    observedGeneration: 0,
    lastTransitionTime: t,
    reason: phase,
    message: "",
  });

  return {
    kind: "AgentSession",
    namespace: "default",
    id: s.id,
    spec: {
      role: s.role,
      platform: s.platform,
      model: s.model,
      agent: s.agent,
    },
    status: {
      phase,
      pid: s.pid,
    },
    conditions: [
      mkCond("Ready", phase === "running" || phase === "idle"),
      mkCond("Crashed", phase === "crashed"),
    ],
    observedGeneration: 0,
    resourceVersion: "0",
    metadata: {
      generation: 1,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/entity.test.ts`
Expected: PASS (previous tests + 10 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/entity.ts src/core/entity.test.ts
git commit -m "feat(core): agentSessionToEntity adapter with injectable clock (#287)"
```

---

## Task 5: Re-export Entity surface from `src/core/index.ts`

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/entity.test.ts`:

```ts
describe("core/index exports", () => {
  test("re-exports Entity adapters and types", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.contributionToEntity).toBe("function");
    expect(typeof mod.claimToEntity).toBe("function");
    expect(typeof mod.agentSessionToEntity).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/entity.test.ts`
Expected: FAIL — re-exports not present.

- [ ] **Step 3: Write minimal implementation**

Open `src/core/index.ts` and add (keep alphabetical with existing entity-like exports; place near the `deadline-watcher` block, which is in alphabetical order today):

```ts
export type {
  AgentSessionEntity,
  AgentSessionSpec,
  AgentSessionStatusBody,
  ClaimEntity,
  ClaimSpec,
  ClaimStatusBody,
  Condition,
  ConditionStatus,
  ContributionEntity,
  ContributionSpec,
  ContributionStatus,
  Entity,
  EntityMetadata,
  OwnerRef,
} from "./entity.js";
export {
  agentSessionToEntity,
  claimToEntity,
  contributionToEntity,
} from "./entity.js";
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/entity.test.ts`
Expected: PASS.

Also verify there are no duplicate or conflicting exports:
Run: `bun tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/entity.test.ts
git commit -m "feat(core): re-export Entity surface from core/index (#287)"
```

---

## Task 6: ConditionChips component (pure-logic + prop-contract tests)

**Files:**
- Create: `src/tui/components/condition-chips.tsx`
- Test: `src/tui/components/condition-chips.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tui/components/condition-chips.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Condition } from "../../core/entity.js";
import type { ConditionChipsProps } from "./condition-chips.js";
import { colorForStatus, shouldShowReason } from "./condition-chips.js";
import { theme } from "../theme.js";

describe("ConditionChips module", () => {
  test("exports ConditionChips as a React.memo component", async () => {
    const mod = await import("./condition-chips.js");
    expect(mod.ConditionChips).toBeDefined();
    expect(typeof mod.ConditionChips).toBe("object"); // React.memo → object
  });

  test("ConditionChips display name is ConditionChips", async () => {
    const { ConditionChips } = await import("./condition-chips.js");
    const inner = (ConditionChips as unknown as { type?: { name?: string } }).type;
    expect(inner?.name).toBe("ConditionChips");
  });
});

describe("ConditionChips props contract", () => {
  test("accepts a readonly Condition array", () => {
    const props: ConditionChipsProps = { conditions: [] };
    expect(props.conditions).toEqual([]);
  });

  test("accepts multiple conditions", () => {
    const cs: Condition[] = [
      {
        type: "Ready",
        status: "True",
        observedGeneration: 0,
        lastTransitionTime: "2026-04-23T00:00:00Z",
        reason: "running",
        message: "",
      },
    ];
    const props: ConditionChipsProps = { conditions: cs };
    expect(props.conditions).toHaveLength(1);
  });
});

describe("colorForStatus", () => {
  test("True → theme.success", () => {
    expect(colorForStatus("True")).toBe(theme.success);
  });
  test("False → theme.error", () => {
    expect(colorForStatus("False")).toBe(theme.error);
  });
  test("Unknown → theme.warning", () => {
    expect(colorForStatus("Unknown")).toBe(theme.warning);
  });
});

describe("shouldShowReason", () => {
  test("shows reason line for non-True conditions with a reason", () => {
    expect(
      shouldShowReason({
        type: "Expired",
        status: "False",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "active",
        message: "",
      }),
    ).toBe(true);
  });

  test("hides reason line for True conditions", () => {
    expect(
      shouldShowReason({
        type: "Ready",
        status: "True",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "running",
        message: "",
      }),
    ).toBe(false);
  });

  test("hides reason line when reason is empty", () => {
    expect(
      shouldShowReason({
        type: "Expired",
        status: "False",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "",
        message: "",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tui/components/condition-chips.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/tui/components/condition-chips.tsx`:

```tsx
/**
 * ConditionChips — renders a Condition[] as a row of colored chips.
 *
 * Used in detail views to surface entity conditions (e.g. Ready, Expired).
 * Kind-agnostic: accepts any Condition from src/core/entity.ts.
 */

import React from "react";
import type { Condition, ConditionStatus } from "../../core/entity.js";
import { theme } from "../theme.js";

export interface ConditionChipsProps {
  readonly conditions: readonly Condition[];
}

export function colorForStatus(status: ConditionStatus): string {
  if (status === "True") return theme.success;
  if (status === "False") return theme.error;
  return theme.warning;
}

export function shouldShowReason(c: Condition): boolean {
  return c.status !== "True" && c.reason.length > 0;
}

export const ConditionChips: React.NamedExoticComponent<ConditionChipsProps> =
  React.memo(function ConditionChips({
    conditions,
  }: ConditionChipsProps): React.ReactNode {
    if (conditions.length === 0) return null;
    const reasons = conditions.filter(shouldShowReason);
    return (
      <box flexDirection="column" marginBottom={1}>
        <box flexDirection="row">
          {conditions.map((c) => (
            <text key={c.type} color={colorForStatus(c.status)}>
              [{c.type}]{" "}
            </text>
          ))}
        </box>
        {reasons.length > 0 && (
          <box flexDirection="column">
            {reasons.map((c) => (
              <text key={`reason-${c.type}`} opacity={0.5}>
                {c.type}: {c.reason}
              </text>
            ))}
          </box>
        )}
      </box>
    );
  });
```

- [ ] **Step 4: Run tests**

Run: `bun test src/tui/components/condition-chips.test.ts`
Expected: PASS (all tests).

Also: `bun tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/condition-chips.tsx src/tui/components/condition-chips.test.ts
git commit -m "feat(tui): ConditionChips component for Entity conditions (#287)"
```

---

## Task 7: Mount ConditionChips in the contribution detail view

**Files:**
- Modify: `src/tui/views/detail.tsx`

- [ ] **Step 1: Modify detail.tsx to project to entity and render chips**

Edit `src/tui/views/detail.tsx`:

Add imports at the top, alongside existing `OutcomeBadge` import:

```ts
import { contributionToEntity } from "../../core/entity.js";
import { ConditionChips } from "../components/condition-chips.js";
```

Inside the component, after `const { contribution: c, ancestors, children, thread } = data;`, add:

```ts
const entity = contributionToEntity(c);
```

Then in the JSX, insert the chips row as the first child of the outer `<box flexDirection="column">`, before the existing header row that renders `{c.cid}` / `DataStatus` / `OutcomeBadge`:

```tsx
<ConditionChips conditions={entity.conditions} />
```

The resulting top of the rendered tree:

```tsx
return (
  <box flexDirection="column">
    <ConditionChips conditions={entity.conditions} />
    <box marginBottom={1} flexDirection="row">
      <text color={theme.focus}>{c.cid}</text>
      ...
    </box>
    ...
  </box>
);
```

- [ ] **Step 2: Run TUI tests to make sure no regressions**

Run: `bun test src/tui`
Expected: all tests pass.

- [ ] **Step 3: Typecheck whole project**

Run: `bun tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tui/views/detail.tsx
git commit -m "feat(tui): render condition chips in contribution detail view (#287)"
```

---

## Task 8: Final verification + issue update

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run: `bun tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint / format (if project uses biome via lefthook)**

Run: `bun run biome check --write src/core/entity.ts src/core/entity.test.ts src/tui/components/condition-chips.tsx src/tui/components/condition-chips.test.ts src/tui/views/detail.tsx src/core/index.ts`
Expected: exit 0.

If biome rewrites any file, re-run `bun test` and amend the affected commit (or create a "chore: biome format" follow-up commit).

- [ ] **Step 4: Confirm acceptance criteria on issue #287**

From the issue:
- Type defined in `src/core/entity.ts` — yes (Task 1).
- 3 existing stores return Entity-shaped objects — satisfied via adapters that project any existing store result to Entity shape (spec §Strategy documents the interpretation; tightening to `listEntities` store methods is deferred to A7 / #294).
- TUI detail panel renders conditions as colored chips — yes (Task 7).

Comment on issue #287 summarizing the PR + the deferred `listEntities` note so reviewers can see the explicit choice.
