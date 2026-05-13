# WorkBlock Session Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build full-scope `WorkBlock`, `TimelineEvent`, and `SessionTimeline` support for issue #375 across contracts, storage, API, watch, projections, providers, CLI, and fixtures.

**Architecture:** Add core timeline contracts and entity projections first, then back them with a shared `TimelineStore` interface implemented by SQLite and Nexus. The store owns both work blocks and append-only timeline events so status patches and timeline appends can be atomic; API/watch/projector/provider layers consume that store without replacing contributions or claims.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, Zod, bun:test, bun:sqlite, Hono, Nexus VFS adapters, Biome.

---

## File Structure

- Create `src/core/timeline.ts`: timeline constants, domain interfaces, ID helpers, timeline scope helper, cost merge helper.
- Create `src/core/timeline-schemas.ts`: Zod schemas and parse helpers for `WorkBlock`, `TimelineEvent`, and `SessionTimeline`.
- Create `src/core/timeline-store.ts`: `TimelineStore` protocol, query types, patch/input types, and store errors.
- Create `src/core/timeline-store.conformance.ts`: shared behavior tests for SQLite and Nexus stores.
- Modify `src/core/entity.ts`: add `WorkBlockEntity`, `TimelineEventEntity`, and projection helpers.
- Modify `src/core/watch-events.ts`: extend `WatchKind` and `WatchEntity`.
- Modify `src/core/index.ts`: export timeline contracts, schemas, stores, and entity helpers.
- Create `src/local/sqlite-timeline-store.ts`: SQLite-backed `TimelineStore`.
- Modify `src/local/sqlite-store.ts`: execute timeline DDL and return `timelineStore` from `createSqliteStores`.
- Modify `src/local/runtime.ts`: expose `timelineStore` and wire local watch recorder callbacks.
- Create `src/nexus/nexus-timeline-store.ts`: Nexus-backed `TimelineStore`.
- Modify `src/nexus/vfs-paths.ts`: timeline/work-block path helpers.
- Modify `src/nexus/index.ts`: export `NexusTimelineStore`.
- Create `src/core/timeline-projector.ts`: deterministic derived event projection from contributions, claims, ask-user, usage reports, and plans.
- Modify `src/core/operations/deps.ts`: add optional `timelineStore`.
- Modify `src/core/operations/contribute.ts`: append timeline events after successful contribution writes.
- Modify claim operation/routes where claims mutate: append claim timeline events when `timelineStore` is present.
- Modify `src/server/deps.ts`, `src/server/operation-adapter.ts`, `src/server/app.ts`, `src/server/serve.ts`: dependency and route wiring.
- Create `src/server/routes/work-blocks.ts`: work-block CRUD/list routes.
- Create `src/server/routes/timeline.ts`: session timeline read routes.
- Modify `src/server/routes/watch.ts`: add `WorkBlock` and `TimelineEvent` list/watch/notify support.
- Modify `src/core/informer.ts`, `src/core/watch-client.ts` only where type maps require new kinds.
- Modify TUI provider files: `src/tui/provider.ts`, `src/tui/local-provider.ts`, `src/tui/remote-provider.ts`, `src/tui/provider-shared.ts` to add timeline query methods.
- Create CLI command files `src/cli/commands/work-blocks.ts` and `src/cli/commands/timeline.ts`; register them in `src/cli/main.ts`.
- Add `tests/fixtures/timeline/incident-investigation.json`.

## Task 1: Core Timeline Contracts And Schemas

**Files:**
- Create: `src/core/timeline.ts`
- Create: `src/core/timeline-schemas.ts`
- Create: `src/core/timeline.test.ts`
- Create: `src/core/timeline-schemas.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing contract tests**

Create `src/core/timeline.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  TimelineEventType,
  WorkBlockOrigin,
  WorkBlockStatus,
  buildTimelineEventId,
  buildWorkBlockId,
  mergeCostSummary,
  timelineScope,
} from "./timeline.js";

describe("timeline contracts", () => {
  test("exports stable literal values", () => {
    expect(WorkBlockStatus.Running).toBe("running");
    expect(WorkBlockStatus.WaitingApproval).toBe("waiting_approval");
    expect(WorkBlockOrigin.Triggered).toBe("triggered");
    expect(TimelineEventType.ContributionCreated).toBe("contribution.created");
    expect(TimelineEventType.ApprovalDecided).toBe("approval.decided");
  });

  test("builds prefixed ids", () => {
    expect(buildWorkBlockId(() => "00000000-0000-4000-8000-000000000001")).toBe(
      "wb_00000000-0000-4000-8000-000000000001",
    );
    expect(buildTimelineEventId(() => "00000000-0000-4000-8000-000000000002")).toBe(
      "te_00000000-0000-4000-8000-000000000002",
    );
  });

  test("computes timeline scopes", () => {
    expect(timelineScope()).toBe("global");
    expect(timelineScope("session/alpha")).toBe("session/session%2Falpha");
  });

  test("merges cost summaries additively", () => {
    expect(
      mergeCostSummary(
        { inputTokens: 10, outputTokens: 5, costUsd: 0.2, model: "m1" },
        { inputTokens: 2, outputTokens: 3, costUsd: 0.1, model: "m2" },
      ),
    ).toEqual({ inputTokens: 12, outputTokens: 8, costUsd: 0.30000000000000004, model: "m2" });
  });
});
```

- [ ] **Step 2: Write failing schema tests**

Create `src/core/timeline-schemas.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  parseSessionTimeline,
  parseTimelineEvent,
  parseTimelineEvents,
  parseWorkBlock,
  parseWorkBlocks,
} from "./timeline-schemas.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "./timeline.js";
import type { AgentIdentity } from "./models.js";

const agent: AgentIdentity = { agentId: "agent-1", role: "incident-lead", platform: "codex" };

describe("timeline schemas", () => {
  test("parses a minimal WorkBlock", () => {
    const block = parseWorkBlock({
      workBlockId: "wb_1",
      goal: "Investigate checkout latency",
      actor: agent,
      origin: WorkBlockOrigin.Agent,
      status: WorkBlockStatus.Running,
      updatedAt: "2026-05-13T10:00:00.000Z",
      inputRefs: [],
      outputRefs: [],
      evidenceRefs: [],
      approvalRefs: [],
      contributionCids: [],
      artifactHashes: [],
      claimIds: [],
      revision: 1,
      createdAt: "2026-05-13T09:59:00.000Z",
    });
    expect(block.workBlockId).toBe("wb_1");
  });

  test("rejects invalid WorkBlock status", () => {
    expect(() =>
      parseWorkBlock({
        workBlockId: "wb_1",
        goal: "Investigate checkout latency",
        actor: agent,
        origin: WorkBlockOrigin.Agent,
        status: "done",
        updatedAt: "2026-05-13T10:00:00.000Z",
        inputRefs: [],
        outputRefs: [],
        evidenceRefs: [],
        approvalRefs: [],
        contributionCids: [],
        artifactHashes: [],
        claimIds: [],
        revision: 1,
        createdAt: "2026-05-13T09:59:00.000Z",
      }),
    ).toThrow();
  });

  test("rejects negative costs", () => {
    expect(() =>
      parseWorkBlock({
        workBlockId: "wb_1",
        goal: "Investigate checkout latency",
        actor: agent,
        origin: WorkBlockOrigin.Agent,
        status: WorkBlockStatus.Running,
        updatedAt: "2026-05-13T10:00:00.000Z",
        inputRefs: [],
        outputRefs: [],
        evidenceRefs: [],
        approvalRefs: [],
        contributionCids: [],
        artifactHashes: [],
        claimIds: [],
        costSummary: { costUsd: -1 },
        revision: 1,
        createdAt: "2026-05-13T09:59:00.000Z",
      }),
    ).toThrow();
  });

  test("parses a timeline event and timeline view", () => {
    const event = parseTimelineEvent({
      eventId: "te_1",
      resourceVersion: "1",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor: agent,
      workBlockId: "wb_1",
      targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
      payload: { goal: "Investigate checkout latency" },
    });
    expect(event.resourceVersion).toBe("1");
    expect(parseSessionTimeline({ sessionId: "s1", events: [event], timelineResourceVersion: "1" }).events).toHaveLength(1);
  });

  test("array parsers preserve readonly arrays", () => {
    expect(parseWorkBlocks([])).toEqual([]);
    expect(parseTimelineEvents([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
bun test src/core/timeline.test.ts src/core/timeline-schemas.test.ts
```

Expected: fail with module-not-found errors for `timeline.js` and `timeline-schemas.js`.

- [ ] **Step 4: Implement `src/core/timeline.ts`**

Create `src/core/timeline.ts`:

```ts
import { encodeSegment } from "../nexus/vfs-paths.js";
import type { AgentIdentity, JsonValue } from "./models.js";

export const WorkBlockStatus = {
  Pending: "pending",
  Running: "running",
  Blocked: "blocked",
  WaitingApproval: "waiting_approval",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type WorkBlockStatus = (typeof WorkBlockStatus)[keyof typeof WorkBlockStatus];

export const WorkBlockOrigin = {
  Manual: "manual",
  Agent: "agent",
  Scheduled: "scheduled",
  Triggered: "triggered",
} as const;
export type WorkBlockOrigin = (typeof WorkBlockOrigin)[keyof typeof WorkBlockOrigin];

export const TimelineEventType = {
  WorkBlockCreated: "work_block.created",
  WorkBlockStarted: "work_block.started",
  WorkBlockStatusChanged: "work_block.status_changed",
  WorkBlockCompleted: "work_block.completed",
  WorkBlockFailed: "work_block.failed",
  AgentSessionStarted: "agent_session.started",
  AgentSessionStatusChanged: "agent_session.status_changed",
  AgentSessionStopped: "agent_session.stopped",
  ClaimCreated: "claim.created",
  ClaimLeaseRefreshed: "claim.lease_refreshed",
  ClaimCompleted: "claim.completed",
  ClaimReleased: "claim.released",
  ClaimExpired: "claim.expired",
  ContributionCreated: "contribution.created",
  ArtifactLinked: "artifact.linked",
  ApprovalRequested: "approval.requested",
  ApprovalDecided: "approval.decided",
  CostReported: "cost.reported",
  PlanTaskCreated: "plan.task_created",
  PlanTaskStatusChanged: "plan.task_status_changed",
  RunHealthDegraded: "run.health_degraded",
  RunHealthRecovered: "run.health_recovered",
} as const;
export type TimelineEventType = (typeof TimelineEventType)[keyof typeof TimelineEventType];

export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string | undefined;
  readonly href?: string | undefined;
}

export interface CostSummary {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly model?: string | undefined;
}

export interface WorkBlock {
  readonly workBlockId: string;
  readonly sessionId?: string | undefined;
  readonly goal: string;
  readonly actor: AgentIdentity;
  readonly origin: WorkBlockOrigin;
  readonly status: WorkBlockStatus;
  readonly startedAt?: string | undefined;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
  readonly inputRefs: readonly ResourceRef[];
  readonly outputRefs: readonly ResourceRef[];
  readonly evidenceRefs: readonly ResourceRef[];
  readonly approvalRefs: readonly ResourceRef[];
  readonly contributionCids: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly claimIds: readonly string[];
  readonly costSummary?: CostSummary | undefined;
  readonly links?: readonly ResourceRef[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly revision: number;
  readonly createdAt: string;
}

export interface TimelineEvent {
  readonly eventId: string;
  readonly resourceVersion: string;
  readonly sessionId?: string | undefined;
  readonly type: TimelineEventType;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor?: AgentIdentity | undefined;
  readonly workBlockId?: string | undefined;
  readonly targetRefs: readonly ResourceRef[];
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface SessionTimeline {
  readonly sessionId?: string | undefined;
  readonly events: readonly TimelineEvent[];
  readonly workBlocks?: readonly WorkBlock[] | undefined;
  readonly timelineResourceVersion: string;
}

export function buildWorkBlockId(uuid: () => string = () => crypto.randomUUID()): string {
  return `wb_${uuid()}`;
}

export function buildTimelineEventId(uuid: () => string = () => crypto.randomUUID()): string {
  return `te_${uuid()}`;
}

export function timelineScope(sessionId?: string | undefined): string {
  return sessionId === undefined ? "global" : `session/${encodeSegment(sessionId)}`;
}

export function mergeCostSummary(
  existing: CostSummary | undefined,
  incoming: CostSummary,
): CostSummary {
  return {
    inputTokens: (existing?.inputTokens ?? 0) + (incoming.inputTokens ?? 0),
    outputTokens: (existing?.outputTokens ?? 0) + (incoming.outputTokens ?? 0),
    costUsd: (existing?.costUsd ?? 0) + (incoming.costUsd ?? 0),
    model: incoming.model ?? existing?.model,
  };
}
```

- [ ] **Step 5: Implement `src/core/timeline-schemas.ts`**

Create `src/core/timeline-schemas.ts`:

```ts
import { z } from "zod";
import type { AgentIdentity, JsonValue } from "./models.js";
import type { SessionTimeline, TimelineEvent, WorkBlock } from "./timeline.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus } from "./timeline.js";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const AgentIdentitySchema: z.ZodType<AgentIdentity> = z.object({
  agentId: z.string().min(1),
  agentName: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
  toolchain: z.string().optional(),
  runtime: z.string().optional(),
  role: z.string().optional(),
});

const IsoTimestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "expected ISO-8601 timestamp",
});

const ResourceRefSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    label: z.string().optional(),
    href: z.string().optional(),
  })
  .strict();

const CostSummarySchema = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
    model: z.string().optional(),
  })
  .strict();

export const WorkBlockSchema: z.ZodType<WorkBlock> = z
  .object({
    workBlockId: z.string().min(1),
    sessionId: z.string().optional(),
    goal: z.string().min(1),
    actor: AgentIdentitySchema,
    origin: z.enum(Object.values(WorkBlockOrigin) as [WorkBlockOrigin, ...WorkBlockOrigin[]]),
    status: z.enum(Object.values(WorkBlockStatus) as [WorkBlockStatus, ...WorkBlockStatus[]]),
    startedAt: IsoTimestampSchema.optional(),
    updatedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
    inputRefs: z.array(ResourceRefSchema),
    outputRefs: z.array(ResourceRefSchema),
    evidenceRefs: z.array(ResourceRefSchema),
    approvalRefs: z.array(ResourceRefSchema),
    contributionCids: z.array(z.string()),
    artifactHashes: z.array(z.string()),
    claimIds: z.array(z.string()),
    costSummary: CostSummarySchema.optional(),
    links: z.array(ResourceRefSchema).optional(),
    context: z.record(z.string(), JsonValueSchema).optional(),
    revision: z.number().int().min(1),
    createdAt: IsoTimestampSchema,
  })
  .strict();

export const TimelineEventSchema: z.ZodType<TimelineEvent> = z
  .object({
    eventId: z.string().min(1),
    resourceVersion: z.string().regex(/^[0-9]+$/),
    sessionId: z.string().optional(),
    type: z.enum(Object.values(TimelineEventType) as [TimelineEventType, ...TimelineEventType[]]),
    occurredAt: IsoTimestampSchema,
    recordedAt: IsoTimestampSchema,
    actor: AgentIdentitySchema.optional(),
    workBlockId: z.string().optional(),
    targetRefs: z.array(ResourceRefSchema),
    payload: z.record(z.string(), JsonValueSchema),
  })
  .strict();

export const SessionTimelineSchema: z.ZodType<SessionTimeline> = z
  .object({
    sessionId: z.string().optional(),
    events: z.array(TimelineEventSchema),
    workBlocks: z.array(WorkBlockSchema).optional(),
    timelineResourceVersion: z.string().regex(/^[0-9]+$/),
  })
  .strict();

export function parseWorkBlock(data: unknown): WorkBlock {
  return WorkBlockSchema.parse(data);
}

export function parseWorkBlocks(data: unknown): readonly WorkBlock[] {
  return z.array(WorkBlockSchema).parse(data);
}

export function parseTimelineEvent(data: unknown): TimelineEvent {
  return TimelineEventSchema.parse(data);
}

export function parseTimelineEvents(data: unknown): readonly TimelineEvent[] {
  return z.array(TimelineEventSchema).parse(data);
}

export function parseSessionTimeline(data: unknown): SessionTimeline {
  return SessionTimelineSchema.parse(data);
}
```

- [ ] **Step 6: Export core timeline modules**

Modify `src/core/index.ts` to export:

```ts
export * from "./timeline.js";
export * from "./timeline-schemas.js";
```

- [ ] **Step 7: Run tests**

Run:

```bash
bun test src/core/timeline.test.ts src/core/timeline-schemas.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/core/timeline.ts src/core/timeline-schemas.ts src/core/timeline.test.ts src/core/timeline-schemas.test.ts src/core/index.ts
git commit -m "feat: add timeline core contracts"
```

## Task 2: Entity, WatchKind, And Store Protocol

**Files:**
- Modify: `src/core/entity.ts`
- Modify: `src/core/entity.test.ts`
- Modify: `src/core/watch-events.ts`
- Create: `src/core/timeline-store.ts`
- Create: `src/core/timeline-store.conformance.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing entity projection tests**

Append to `src/core/entity.test.ts`:

```ts
import {
  TimelineEventType,
  WorkBlockOrigin,
  WorkBlockStatus,
  type TimelineEvent,
  type WorkBlock,
} from "./timeline.js";
import { timelineEventToEntity, workBlockToEntity } from "./entity.js";

describe("timeline entity projections", () => {
  const actor = { agentId: "agent-1", role: "incident-lead" };

  test("projects WorkBlock into Entity envelope", () => {
    const block: WorkBlock = {
      workBlockId: "wb_1",
      sessionId: "s1",
      goal: "Investigate checkout latency",
      actor,
      origin: WorkBlockOrigin.Agent,
      status: WorkBlockStatus.Running,
      startedAt: "2026-05-13T10:00:00.000Z",
      updatedAt: "2026-05-13T10:01:00.000Z",
      inputRefs: [],
      outputRefs: [],
      evidenceRefs: [],
      approvalRefs: [],
      contributionCids: [],
      artifactHashes: [],
      claimIds: [],
      revision: 3,
      createdAt: "2026-05-13T09:59:00.000Z",
    };
    const entity = workBlockToEntity(block, "ns/test");
    expect(entity.kind).toBe("WorkBlock");
    expect(entity.id).toBe("wb_1");
    expect(entity.resourceVersion).toBe("3");
    expect(entity.status.phase).toBe("running");
    expect(entity.conditions.some((c) => c.type === "Running" && c.status === "True")).toBe(true);
  });

  test("projects TimelineEvent into append-only Entity envelope", () => {
    const event: TimelineEvent = {
      eventId: "te_1",
      resourceVersion: "7",
      sessionId: "s1",
      type: TimelineEventType.ContributionCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      recordedAt: "2026-05-13T10:00:01.000Z",
      actor,
      workBlockId: "wb_1",
      targetRefs: [{ kind: "Contribution", id: "cid-1" }],
      payload: { cid: "cid-1" },
    };
    const entity = timelineEventToEntity(event, "ns/test");
    expect(entity.kind).toBe("TimelineEvent");
    expect(entity.id).toBe("te_1");
    expect(entity.resourceVersion).toBe("7");
    expect(entity.conditions[0]?.type).toBe("Recorded");
  });
});
```

- [ ] **Step 2: Write failing store protocol conformance shell**

Create `src/core/timeline-store.conformance.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { TimelineStore } from "./timeline-store.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus, type WorkBlock } from "./timeline.js";

export interface TimelineStoreHarness {
  readonly name: string;
  readonly createStore: () => Promise<{ readonly store: TimelineStore; readonly close: () => void }>;
}

export function runTimelineStoreConformance(harness: TimelineStoreHarness): void {
  describe(`${harness.name} TimelineStore conformance`, () => {
    test("stores, patches, and lists work blocks", async () => {
      const { store, close } = await harness.createStore();
      try {
        const block: WorkBlock = {
          workBlockId: "wb_conformance",
          sessionId: "s1",
          goal: "Investigate incident",
          actor: { agentId: "agent-1" },
          origin: WorkBlockOrigin.Agent,
          status: WorkBlockStatus.Pending,
          updatedAt: "2026-05-13T10:00:00.000Z",
          inputRefs: [],
          outputRefs: [],
          evidenceRefs: [],
          approvalRefs: [],
          contributionCids: [],
          artifactHashes: [],
          claimIds: [],
          revision: 1,
          createdAt: "2026-05-13T10:00:00.000Z",
        };
        await store.putWorkBlock(block);
        const patched = await store.patchWorkBlock("wb_conformance", {
          status: WorkBlockStatus.Running,
          startedAt: "2026-05-13T10:01:00.000Z",
        });
        expect(patched.revision).toBe(2);
        expect((await store.listWorkBlocks({ sessionId: "s1" }))).toHaveLength(1);
        expect((await store.listWorkBlockEntities({ status: WorkBlockStatus.Running }))[0]?.kind).toBe("WorkBlock");
      } finally {
        close();
      }
    });

    test("appends timeline events with monotonic resource versions", async () => {
      const { store, close } = await harness.createStore();
      try {
        const first = await store.appendTimelineEvent({
          eventId: "te_a",
          sessionId: "s1",
          type: TimelineEventType.WorkBlockCreated,
          occurredAt: "2026-05-13T10:00:00.000Z",
          actor: { agentId: "agent-1" },
          workBlockId: "wb_1",
          targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
          payload: { goal: "Investigate incident" },
        });
        const second = await store.appendTimelineEvent({
          eventId: "te_b",
          sessionId: "s1",
          type: TimelineEventType.WorkBlockStarted,
          occurredAt: "2026-05-13T10:01:00.000Z",
          actor: { agentId: "agent-1" },
          workBlockId: "wb_1",
          targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
          payload: {},
        });
        expect(first.resourceVersion).toBe("1");
        expect(second.resourceVersion).toBe("2");
        expect(await store.currentTimelineResourceVersion("s1")).toBe("2");
        expect((await store.listTimelineEvents({ sessionId: "s1", afterRv: "1" })).map((e) => e.eventId)).toEqual(["te_b"]);
        expect((await store.listTimelineEventEntities({ sessionId: "s1" }))[0]?.kind).toBe("TimelineEvent");
      } finally {
        close();
      }
    });
  });
}
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
bun test src/core/entity.test.ts src/core/timeline-store.conformance.ts
```

Expected: fail with missing exports from `entity.js` and missing `timeline-store.js`.

- [ ] **Step 4: Implement entity projections**

Modify `src/core/entity.ts`:

```ts
import type { TimelineEvent, WorkBlock, WorkBlockStatus as WorkBlockPhase } from "./timeline.js";
```

Add the entity types and adapters after `AgentSessionEntity`:

```ts
export interface WorkBlockSpec {
  readonly sessionId?: string | undefined;
  readonly goal: string;
  readonly actor: AgentIdentity;
  readonly origin: import("./timeline.js").WorkBlockOrigin;
  readonly inputRefs: readonly import("./timeline.js").ResourceRef[];
  readonly outputRefs: readonly import("./timeline.js").ResourceRef[];
  readonly evidenceRefs: readonly import("./timeline.js").ResourceRef[];
  readonly approvalRefs: readonly import("./timeline.js").ResourceRef[];
  readonly contributionCids: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly claimIds: readonly string[];
  readonly costSummary?: import("./timeline.js").CostSummary | undefined;
  readonly links?: readonly import("./timeline.js").ResourceRef[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface WorkBlockStatusBody {
  readonly phase: WorkBlockPhase;
  readonly startedAt?: string | undefined;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
}

export type WorkBlockEntity = Entity<"WorkBlock", WorkBlockSpec, WorkBlockStatusBody>;

export function workBlockToEntity(block: WorkBlock, namespace = "default"): WorkBlockEntity {
  const mkCond = (type: string, active: boolean): Condition => ({
    type,
    status: active ? "True" : "False",
    observedGeneration: block.revision,
    lastTransitionTime: block.updatedAt,
    reason: block.status,
    message: "",
  });
  return {
    kind: "WorkBlock",
    namespace,
    id: block.workBlockId,
    spec: {
      sessionId: block.sessionId,
      goal: block.goal,
      actor: block.actor,
      origin: block.origin,
      inputRefs: block.inputRefs,
      outputRefs: block.outputRefs,
      evidenceRefs: block.evidenceRefs,
      approvalRefs: block.approvalRefs,
      contributionCids: block.contributionCids,
      artifactHashes: block.artifactHashes,
      claimIds: block.claimIds,
      costSummary: block.costSummary,
      links: block.links,
      context: block.context,
    },
    status: {
      phase: block.status,
      startedAt: block.startedAt,
      updatedAt: block.updatedAt,
      completedAt: block.completedAt,
    },
    conditions: [
      mkCond("Running", block.status === "running"),
      mkCond("Blocked", block.status === "blocked" || block.status === "waiting_approval"),
      mkCond("Completed", block.status === "completed"),
      mkCond("Failed", block.status === "failed"),
    ],
    observedGeneration: block.revision,
    resourceVersion: String(block.revision),
    metadata: {
      generation: block.revision,
      creationTimestamp: block.createdAt,
    },
  };
}

export interface TimelineEventSpec {
  readonly sessionId?: string | undefined;
  readonly type: import("./timeline.js").TimelineEventType;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor?: AgentIdentity | undefined;
  readonly workBlockId?: string | undefined;
  readonly targetRefs: readonly import("./timeline.js").ResourceRef[];
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export type TimelineEventEntity = Entity<"TimelineEvent", TimelineEventSpec, Record<string, never>>;

export function timelineEventToEntity(
  event: TimelineEvent,
  namespace = "default",
): TimelineEventEntity {
  return {
    kind: "TimelineEvent",
    namespace,
    id: event.eventId,
    spec: {
      sessionId: event.sessionId,
      type: event.type,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      actor: event.actor,
      workBlockId: event.workBlockId,
      targetRefs: event.targetRefs,
      payload: event.payload,
    },
    status: {},
    conditions: [
      {
        type: "Recorded",
        status: "True",
        observedGeneration: Number(event.resourceVersion),
        lastTransitionTime: event.recordedAt,
        reason: "recorded",
        message: "",
      },
    ],
    observedGeneration: Number(event.resourceVersion),
    resourceVersion: event.resourceVersion,
    metadata: {
      generation: Number(event.resourceVersion),
      creationTimestamp: event.recordedAt,
    },
  };
}
```

- [ ] **Step 5: Extend watch event types**

Modify `src/core/watch-events.ts`:

```ts
import type {
  AgentSessionEntity,
  ClaimEntity,
  ContributionEntity,
  TimelineEventEntity,
  WorkBlockEntity,
} from "./entity.js";

export type WatchKind = "Contribution" | "Claim" | "AgentSession" | "WorkBlock" | "TimelineEvent";

export type WatchEntity =
  | ContributionEntity
  | ClaimEntity
  | AgentSessionEntity
  | WorkBlockEntity
  | TimelineEventEntity;
```

- [ ] **Step 6: Implement `src/core/timeline-store.ts`**

Create `src/core/timeline-store.ts` matching the protocol from the spec:

```ts
import type { TimelineEventEntity, WorkBlockEntity } from "./entity.js";
import type { TimelineEvent, WorkBlock, WorkBlockStatus } from "./timeline.js";

export interface WorkBlockQuery {
  readonly sessionId?: string | undefined;
  readonly status?: WorkBlockStatus | readonly WorkBlockStatus[] | undefined;
  readonly actorId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface TimelineEventQuery {
  readonly sessionId?: string | undefined;
  readonly afterRv?: string | undefined;
  readonly limit?: number | undefined;
  readonly workBlockId?: string | undefined;
}

export type WorkBlockPatch = Partial<
  Pick<
    WorkBlock,
    | "status"
    | "startedAt"
    | "completedAt"
    | "inputRefs"
    | "outputRefs"
    | "evidenceRefs"
    | "approvalRefs"
    | "contributionCids"
    | "artifactHashes"
    | "claimIds"
    | "costSummary"
    | "links"
    | "context"
  >
>;

export type TimelineEventInput = Omit<TimelineEvent, "resourceVersion" | "recordedAt"> &
  Partial<Pick<TimelineEvent, "recordedAt">>;

export interface TimelineStore {
  readonly storeIdentity?: string | undefined;
  putWorkBlock(block: WorkBlock): Promise<WorkBlock>;
  patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock>;
  getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined>;
  listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]>;
  listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]>;
  appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent>;
  getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined>;
  listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]>;
  listTimelineEventEntities(query?: TimelineEventQuery): Promise<readonly TimelineEventEntity[]>;
  currentTimelineResourceVersion(sessionId?: string): Promise<string>;
  close(): void;
}
```

- [ ] **Step 7: Export store protocol**

Modify `src/core/index.ts`:

```ts
export * from "./timeline-store.js";
```

- [ ] **Step 8: Run tests**

Run:

```bash
bun test src/core/entity.test.ts src/core/timeline-store.conformance.ts
```

Expected: pass.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/core/entity.ts src/core/entity.test.ts src/core/watch-events.ts src/core/timeline-store.ts src/core/timeline-store.conformance.ts src/core/index.ts
git commit -m "feat: add timeline entity and store contracts"
```

## Task 3: SQLite Timeline Store

**Files:**
- Create: `src/local/sqlite-timeline-store.ts`
- Create: `src/local/sqlite-timeline-store.test.ts`
- Modify: `src/local/sqlite-store.ts`
- Modify: `src/local/runtime.ts`
- Modify: `src/local/watch-hub-recorder.ts`

- [ ] **Step 1: Write failing SQLite conformance test**

Create `src/local/sqlite-timeline-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runTimelineStoreConformance } from "../core/timeline-store.conformance.js";
import { TimelineEventType, WorkBlockOrigin, WorkBlockStatus, type WorkBlock } from "../core/timeline.js";
import { initSqliteDb } from "./sqlite-store.js";
import { SqliteTimelineStore } from "./sqlite-timeline-store.js";

let dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-timeline-"));
  dirs.push(dir);
  return join(dir, "grove.db");
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

runTimelineStoreConformance({
  name: "SqliteTimelineStore",
  async createStore() {
    const db = initSqliteDb(tempDb());
    const store = new SqliteTimelineStore(db);
    return { store, close: () => db.close() };
  },
});

describe("SqliteTimelineStore persistence", () => {
  test("persists work blocks and timeline cursor across reopen", async () => {
    const dbPath = tempDb();
    const block: WorkBlock = {
      workBlockId: "wb_reopen",
      sessionId: "s1",
      goal: "Investigate incident",
      actor: { agentId: "agent-1" },
      origin: WorkBlockOrigin.Agent,
      status: WorkBlockStatus.Pending,
      updatedAt: "2026-05-13T10:00:00.000Z",
      inputRefs: [],
      outputRefs: [],
      evidenceRefs: [],
      approvalRefs: [],
      contributionCids: [],
      artifactHashes: [],
      claimIds: [],
      revision: 1,
      createdAt: "2026-05-13T10:00:00.000Z",
    };
    {
      const db = initSqliteDb(dbPath);
      const store = new SqliteTimelineStore(db);
      await store.putWorkBlock(block);
      await store.appendTimelineEvent({
        eventId: "te_reopen",
        sessionId: "s1",
        type: TimelineEventType.WorkBlockCreated,
        occurredAt: "2026-05-13T10:00:00.000Z",
        actor: { agentId: "agent-1" },
        workBlockId: "wb_reopen",
        targetRefs: [{ kind: "WorkBlock", id: "wb_reopen" }],
        payload: {},
      });
      db.close();
    }
    {
      const db = initSqliteDb(dbPath);
      const store = new SqliteTimelineStore(db);
      expect((await store.getWorkBlock("wb_reopen"))?.goal).toBe("Investigate incident");
      expect(await store.currentTimelineResourceVersion("s1")).toBe("1");
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run failing SQLite tests**

Run:

```bash
bun test src/local/sqlite-timeline-store.test.ts
```

Expected: fail because `sqlite-timeline-store.js` does not exist.

- [ ] **Step 3: Implement SQLite store file**

Create `src/local/sqlite-timeline-store.ts` with these exports and callbacks:

```ts
import type { Database } from "bun:sqlite";
import { timelineEventToEntity, workBlockToEntity } from "../core/entity.js";
import type { TimelineEvent, WorkBlock } from "../core/timeline.js";
import { timelineScope } from "../core/timeline.js";
import type {
  TimelineEventInput,
  TimelineEventQuery,
  TimelineStore,
  WorkBlockPatch,
  WorkBlockQuery,
} from "../core/timeline-store.js";
import { parseTimelineEvent, parseWorkBlock } from "../core/timeline-schemas.js";
import type { WatchOp } from "../core/watch-events.js";
import { readStoreNamespace } from "./sqlite-store.js";

export const SQLITE_TIMELINE_DDL = `
  CREATE TABLE IF NOT EXISTS work_blocks (
    work_block_id TEXT PRIMARY KEY,
    session_id TEXT,
    goal TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    input_refs_json TEXT NOT NULL DEFAULT '[]',
    output_refs_json TEXT NOT NULL DEFAULT '[]',
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    approval_refs_json TEXT NOT NULL DEFAULT '[]',
    contribution_cids_json TEXT NOT NULL DEFAULT '[]',
    artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
    claim_ids_json TEXT NOT NULL DEFAULT '[]',
    cost_summary_json TEXT,
    links_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_blocks_session_status ON work_blocks(session_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_work_blocks_actor ON work_blocks(actor_id, updated_at);
  CREATE TABLE IF NOT EXISTS timeline_cursors (
    scope TEXT PRIMARY KEY,
    current_rv INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS timeline_events (
    event_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    resource_version INTEGER NOT NULL,
    session_id TEXT,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    actor_id TEXT,
    actor_json TEXT,
    work_block_id TEXT,
    target_refs_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(scope, resource_version)
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_events_scope_rv ON timeline_events(scope, resource_version);
  CREATE INDEX IF NOT EXISTS idx_timeline_events_work_block ON timeline_events(work_block_id, resource_version);
  CREATE INDEX IF NOT EXISTS idx_timeline_events_type ON timeline_events(type, recorded_at);
`;

export class SqliteTimelineStore implements TimelineStore {
  readonly storeIdentity: string;
  onWorkBlockWrite?: (op: WatchOp, block: WorkBlock) => void;
  onTimelineEventWrite?: (op: "ADDED", event: TimelineEvent) => void;

  constructor(private readonly db: Database) {
    this.storeIdentity = `${db.filename}:timeline`;
  }

  async putWorkBlock(block: WorkBlock): Promise<WorkBlock> {
    const parsed = parseWorkBlock(block);
    const existed = await this.getWorkBlock(parsed.workBlockId);
    this.db
      .prepare(
        `INSERT INTO work_blocks (
          work_block_id, session_id, goal, actor_id, actor_json, origin, status,
          started_at, updated_at, completed_at, input_refs_json, output_refs_json,
          evidence_refs_json, approval_refs_json, contribution_cids_json,
          artifact_hashes_json, claim_ids_json, cost_summary_json, links_json,
          context_json, revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_block_id) DO UPDATE SET
          session_id = excluded.session_id,
          goal = excluded.goal,
          actor_id = excluded.actor_id,
          actor_json = excluded.actor_json,
          origin = excluded.origin,
          status = excluded.status,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          input_refs_json = excluded.input_refs_json,
          output_refs_json = excluded.output_refs_json,
          evidence_refs_json = excluded.evidence_refs_json,
          approval_refs_json = excluded.approval_refs_json,
          contribution_cids_json = excluded.contribution_cids_json,
          artifact_hashes_json = excluded.artifact_hashes_json,
          claim_ids_json = excluded.claim_ids_json,
          cost_summary_json = excluded.cost_summary_json,
          links_json = excluded.links_json,
          context_json = excluded.context_json,
          revision = excluded.revision`,
      )
      .run(...workBlockBindings(parsed));
    this.onWorkBlockWrite?.(existed === undefined ? "ADDED" : "MODIFIED", parsed);
    return parsed;
  }

  async patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock> {
    const existing = await this.getWorkBlock(workBlockId);
    if (existing === undefined) throw new Error(`WorkBlock not found: ${workBlockId}`);
    const now = new Date().toISOString();
    const updated = parseWorkBlock({
      ...existing,
      ...patch,
      updatedAt: now,
      revision: existing.revision + 1,
    });
    await this.putWorkBlock(updated);
    return updated;
  }

  async getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined> {
    const row = this.db.prepare("SELECT * FROM work_blocks WHERE work_block_id = ?").get(workBlockId) as WorkBlockRow | null;
    return row === null ? undefined : rowToWorkBlock(row);
  }

  async listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query?.sessionId !== undefined) {
      clauses.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query?.actorId !== undefined) {
      clauses.push("actor_id = ?");
      params.push(query.actorId);
    }
    if (query?.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = query?.limit === undefined ? "" : " LIMIT ?";
    const offset = query?.offset === undefined ? "" : " OFFSET ?";
    if (query?.limit !== undefined) params.push(query.limit);
    if (query?.offset !== undefined) params.push(query.offset);
    const rows = this.db.prepare(`SELECT * FROM work_blocks ${where} ORDER BY updated_at DESC${limit}${offset}`).all(...params) as WorkBlockRow[];
    return rows.map(rowToWorkBlock);
  }

  async listWorkBlockEntities(query?: WorkBlockQuery) {
    const namespace = readStoreNamespace(this.db);
    return (await this.listWorkBlocks(query)).map((block) => workBlockToEntity(block, namespace));
  }

  async appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent> {
    const existing = await this.getTimelineEvent(input.eventId);
    if (existing !== undefined) return existing;
    const tx = this.db.transaction(() => {
      const scope = timelineScope(input.sessionId);
      this.db.prepare("INSERT OR IGNORE INTO timeline_cursors(scope, current_rv) VALUES (?, 0)").run(scope);
      const row = this.db.prepare("UPDATE timeline_cursors SET current_rv = current_rv + 1 WHERE scope = ? RETURNING current_rv").get(scope) as { current_rv: number };
      const event = parseTimelineEvent({
        ...input,
        resourceVersion: String(row.current_rv),
        recordedAt: input.recordedAt ?? new Date().toISOString(),
      });
      this.db.prepare(
        `INSERT INTO timeline_events (
          event_id, scope, resource_version, session_id, type, occurred_at, recorded_at,
          actor_id, actor_json, work_block_id, target_refs_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.eventId,
        scope,
        Number(event.resourceVersion),
        event.sessionId ?? null,
        event.type,
        event.occurredAt,
        event.recordedAt,
        event.actor?.agentId ?? null,
        event.actor === undefined ? null : JSON.stringify(event.actor),
        event.workBlockId ?? null,
        JSON.stringify(event.targetRefs),
        JSON.stringify(event.payload),
      );
      return event;
    });
    const event = tx();
    this.onTimelineEventWrite?.("ADDED", event);
    return event;
  }

  async getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined> {
    const row = this.db.prepare("SELECT * FROM timeline_events WHERE event_id = ?").get(eventId) as TimelineEventRow | null;
    return row === null ? undefined : rowToTimelineEvent(row);
  }

  async listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]> {
    const clauses: string[] = ["scope = ?"];
    const params: Array<string | number> = [timelineScope(query?.sessionId)];
    if (query?.afterRv !== undefined) {
      clauses.push("resource_version > ?");
      params.push(Number(query.afterRv));
    }
    if (query?.workBlockId !== undefined) {
      clauses.push("work_block_id = ?");
      params.push(query.workBlockId);
    }
    const limit = query?.limit === undefined ? "" : " LIMIT ?";
    if (query?.limit !== undefined) params.push(query.limit);
    const rows = this.db.prepare(`SELECT * FROM timeline_events WHERE ${clauses.join(" AND ")} ORDER BY resource_version ASC${limit}`).all(...params) as TimelineEventRow[];
    return rows.map(rowToTimelineEvent);
  }

  async listTimelineEventEntities(query?: TimelineEventQuery) {
    const namespace = readStoreNamespace(this.db);
    return (await this.listTimelineEvents(query)).map((event) => timelineEventToEntity(event, namespace));
  }

  async currentTimelineResourceVersion(sessionId?: string): Promise<string> {
    const row = this.db.prepare("SELECT current_rv FROM timeline_cursors WHERE scope = ?").get(timelineScope(sessionId)) as { current_rv: number } | null;
    return String(row?.current_rv ?? 0);
  }

  close(): void {}
}
```

Add the private row helpers below the class. Keep them in this file:

```ts
interface WorkBlockRow {
  readonly work_block_id: string;
  readonly session_id: string | null;
  readonly goal: string;
  readonly actor_json: string;
  readonly origin: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly input_refs_json: string;
  readonly output_refs_json: string;
  readonly evidence_refs_json: string;
  readonly approval_refs_json: string;
  readonly contribution_cids_json: string;
  readonly artifact_hashes_json: string;
  readonly claim_ids_json: string;
  readonly cost_summary_json: string | null;
  readonly links_json: string;
  readonly context_json: string | null;
  readonly revision: number;
  readonly created_at: string;
}

interface TimelineEventRow {
  readonly event_id: string;
  readonly resource_version: number;
  readonly session_id: string | null;
  readonly type: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly actor_json: string | null;
  readonly work_block_id: string | null;
  readonly target_refs_json: string;
  readonly payload_json: string;
}

function workBlockBindings(block: WorkBlock): readonly unknown[] {
  return [
    block.workBlockId,
    block.sessionId ?? null,
    block.goal,
    block.actor.agentId,
    JSON.stringify(block.actor),
    block.origin,
    block.status,
    block.startedAt ?? null,
    block.updatedAt,
    block.completedAt ?? null,
    JSON.stringify(block.inputRefs),
    JSON.stringify(block.outputRefs),
    JSON.stringify(block.evidenceRefs),
    JSON.stringify(block.approvalRefs),
    JSON.stringify(block.contributionCids),
    JSON.stringify(block.artifactHashes),
    JSON.stringify(block.claimIds),
    block.costSummary === undefined ? null : JSON.stringify(block.costSummary),
    JSON.stringify(block.links ?? []),
    block.context === undefined ? null : JSON.stringify(block.context),
    block.revision,
    block.createdAt,
  ];
}

function rowToWorkBlock(row: WorkBlockRow): WorkBlock {
  return parseWorkBlock({
    workBlockId: row.work_block_id,
    sessionId: row.session_id ?? undefined,
    goal: row.goal,
    actor: JSON.parse(row.actor_json),
    origin: row.origin,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    inputRefs: JSON.parse(row.input_refs_json),
    outputRefs: JSON.parse(row.output_refs_json),
    evidenceRefs: JSON.parse(row.evidence_refs_json),
    approvalRefs: JSON.parse(row.approval_refs_json),
    contributionCids: JSON.parse(row.contribution_cids_json),
    artifactHashes: JSON.parse(row.artifact_hashes_json),
    claimIds: JSON.parse(row.claim_ids_json),
    costSummary: row.cost_summary_json === null ? undefined : JSON.parse(row.cost_summary_json),
    links: JSON.parse(row.links_json),
    context: row.context_json === null ? undefined : JSON.parse(row.context_json),
    revision: row.revision,
    createdAt: row.created_at,
  });
}

function rowToTimelineEvent(row: TimelineEventRow): TimelineEvent {
  return parseTimelineEvent({
    eventId: row.event_id,
    resourceVersion: String(row.resource_version),
    sessionId: row.session_id ?? undefined,
    type: row.type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor_json === null ? undefined : JSON.parse(row.actor_json),
    workBlockId: row.work_block_id ?? undefined,
    targetRefs: JSON.parse(row.target_refs_json),
    payload: JSON.parse(row.payload_json),
  });
}
```

- [ ] **Step 4: Wire SQLite DDL and factory**

Modify `src/local/sqlite-store.ts`:

```ts
import { SQLITE_TIMELINE_DDL, SqliteTimelineStore } from "./sqlite-timeline-store.js";
```

Inside `initSqliteDb`, after existing DDL exec calls:

```ts
db.exec(SQLITE_TIMELINE_DDL);
```

Bump:

```ts
export const CURRENT_SCHEMA_VERSION = 15;
```

Add `timelineStore` to the `createSqliteStores` return type and value:

```ts
timelineStore: SqliteTimelineStore;
```

```ts
timelineStore: new SqliteTimelineStore(db),
```

`readStoreNamespace` is already exported from `src/local/sqlite-store.ts`; keep using that helper from `SqliteTimelineStore`:

```ts
import { readStoreNamespace } from "./sqlite-store.js";
```

- [ ] **Step 5: Wire local runtime and recorder**

Modify `src/local/watch-hub-recorder.ts`:

```ts
import { timelineEventToEntity, workBlockToEntity } from "../core/entity.js";
import type { TimelineEvent, WorkBlock } from "../core/timeline.js";

export interface WatchHubRecorder {
  contribution(op: WatchOp, c: Contribution): void;
  claim(op: WatchOp, c: Claim): void;
  agentSession(op: WatchOp, s: AgentSession): void;
  workBlock(op: WatchOp, block: WorkBlock): void;
  timelineEvent(op: "ADDED", event: TimelineEvent): void;
}
```

Add methods:

```ts
workBlock(op, block) {
  safeRecord("WorkBlock", op, workBlockToEntity(block, namespace));
},
timelineEvent(op, event) {
  safeRecord("TimelineEvent", op, timelineEventToEntity(event, namespace));
},
```

Modify `src/local/runtime.ts`:

```ts
readonly timelineStore: import("./sqlite-timeline-store.js").SqliteTimelineStore;
```

Return `timelineStore: stores.timelineStore`, and inside the watch hub wiring:

```ts
stores.timelineStore.onWorkBlockWrite = (op, block) => recorder.workBlock(op, block);
stores.timelineStore.onTimelineEventWrite = (op, event) => recorder.timelineEvent(op, event);
```

- [ ] **Step 6: Run SQLite tests**

Run:

```bash
bun test src/local/sqlite-timeline-store.test.ts src/local/runtime.test.ts src/local/watch-hub-recorder.test.ts
```

Expected: pass. If `runtime.test.ts` or `watch-hub-recorder.test.ts` needs new assertions, add checks that `WorkBlock` and `TimelineEvent` writes advance the hub RV.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/local/sqlite-timeline-store.ts src/local/sqlite-timeline-store.test.ts src/local/sqlite-store.ts src/local/runtime.ts src/local/watch-hub-recorder.ts src/local/runtime.test.ts src/local/watch-hub-recorder.test.ts
git commit -m "feat: add sqlite timeline store"
```

## Task 4: Nexus Timeline Store

**Files:**
- Modify: `src/nexus/vfs-paths.ts`
- Create: `src/nexus/nexus-timeline-store.ts`
- Create: `src/nexus/nexus-timeline-store.test.ts`
- Modify: `src/nexus/index.ts`

- [ ] **Step 1: Write failing Nexus conformance test**

Create `src/nexus/nexus-timeline-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { runTimelineStoreConformance } from "../core/timeline-store.conformance.js";
import { TimelineEventType } from "../core/timeline.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusTimelineStore } from "./nexus-timeline-store.js";

runTimelineStoreConformance({
  name: "NexusTimelineStore",
  async createStore() {
    const client = new MockNexusClient();
    const store = new NexusTimelineStore({ client, zoneId: "zone/test" });
    return { store, close: () => undefined };
  },
});

describe("NexusTimelineStore cursor", () => {
  test("deduplicates append by event id", async () => {
    const store = new NexusTimelineStore({ client: new MockNexusClient(), zoneId: "zone/test" });
    const input = {
      eventId: "te_same",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      actor: { agentId: "agent-1" },
      workBlockId: "wb_1",
      targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
      payload: {},
    };
    const first = await store.appendTimelineEvent(input);
    const second = await store.appendTimelineEvent(input);
    expect(first.resourceVersion).toBe("1");
    expect(second.resourceVersion).toBe("1");
    expect(await store.currentTimelineResourceVersion("s1")).toBe("1");
  });
});
```

- [ ] **Step 2: Run failing Nexus test**

Run:

```bash
bun test src/nexus/nexus-timeline-store.test.ts
```

Expected: fail because `nexus-timeline-store.js` does not exist.

- [ ] **Step 3: Add VFS path helpers**

Modify `src/nexus/vfs-paths.ts`:

```ts
export function workBlockPath(zoneId: string, workBlockId: string): string {
  return `/zones/${encodeSegment(zoneId)}/work-blocks/${encodeSegment(workBlockId)}.json`;
}

export function workBlocksDir(zoneId: string): string {
  return `/zones/${encodeSegment(zoneId)}/work-blocks`;
}

export function workBlockSessionIndexPath(
  zoneId: string,
  sessionId: string,
  updatedAt: string,
  workBlockId: string,
): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/work-blocks/session/${encodeSegment(sessionId)}/${encodeSegment(updatedAt)}-${encodeSegment(workBlockId)}.json`;
}

export function workBlockStatusIndexPath(
  zoneId: string,
  status: string,
  updatedAt: string,
  workBlockId: string,
): string {
  return `/zones/${encodeSegment(zoneId)}/indexes/work-blocks/status/${encodeSegment(status)}/${encodeSegment(updatedAt)}-${encodeSegment(workBlockId)}.json`;
}

export function timelineCursorPath(zoneId: string, scope: string): string {
  return `/zones/${encodeSegment(zoneId)}/timeline/cursors/${encodeSegment(scope)}.json`;
}

export function timelineEventsDir(zoneId: string, scope: string): string {
  return `/zones/${encodeSegment(zoneId)}/timeline/events/${encodeSegment(scope)}`;
}

export function timelineEventPath(
  zoneId: string,
  scope: string,
  resourceVersion: string,
  eventId: string,
): string {
  return `${timelineEventsDir(zoneId, scope)}/${resourceVersion.padStart(20, "0")}-${encodeSegment(eventId)}.json`;
}

export function timelineEventByIdPath(zoneId: string, eventId: string): string {
  return `/zones/${encodeSegment(zoneId)}/timeline/by-id/${encodeSegment(eventId)}.json`;
}
```

- [ ] **Step 4: Implement `NexusTimelineStore`**

Create `src/nexus/nexus-timeline-store.ts`. Use the same parse helpers as SQLite and the `listAllPages` helper. The key methods must follow this behavior:

```ts
export interface NexusTimelineStoreConfig {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly watchPublisher?: NexusWatchPublisher | undefined;
  readonly maxCursorRetries?: number | undefined;
}

export class NexusTimelineStore implements TimelineStore {
  readonly storeIdentity: string;
  private readonly maxCursorRetries: number;

  constructor(private readonly config: NexusTimelineStoreConfig) {
    this.storeIdentity = `nexus:${config.zoneId}:timeline`;
    this.maxCursorRetries = config.maxCursorRetries ?? 8;
  }

  async putWorkBlock(block: WorkBlock): Promise<WorkBlock> {
    const parsed = parseWorkBlock(block);
    const existed = await this.getWorkBlock(parsed.workBlockId);
    const body = encoder.encode(JSON.stringify(parsed));
    const writes = [{ path: workBlockPath(this.config.zoneId, parsed.workBlockId), content: body }];
    if (parsed.sessionId !== undefined) {
      writes.push({
        path: workBlockSessionIndexPath(this.config.zoneId, parsed.sessionId, parsed.updatedAt, parsed.workBlockId),
        content: body,
      });
    }
    writes.push({
      path: workBlockStatusIndexPath(this.config.zoneId, parsed.status, parsed.updatedAt, parsed.workBlockId),
      content: body,
    });
    await this.config.client.writeBatch(writes);
    await this.publish("WorkBlock", existed === undefined ? "ADDED" : "MODIFIED", parsed.workBlockId, parsed.revision);
    return parsed;
  }
}
```

Implement the remaining methods with these rules:

- `patchWorkBlock`: read, merge patch, set `updatedAt` to `new Date().toISOString()`, increment `revision`, call `putWorkBlock`.
- `getWorkBlock`: read `workBlockPath`, parse with `parseWorkBlock`.
- `listWorkBlocks`: list `workBlocksDir`, read JSON files, filter in memory by session/status/actor, sort `updatedAt DESC`, apply offset/limit.
- `appendTimelineEvent`: return existing by-id event when present; otherwise allocate cursor with `allocateResourceVersion(sessionId)`, write event file and by-id file in a batch, publish `TimelineEvent` watch envelope.
- `allocateResourceVersion`: read `timelineCursorPath`, write incremented JSON `{ currentRv: next }` using `ifMatch` when file exists or `ifNoneMatch: "*"` when absent, retry on conflict up to `maxCursorRetries`.
- `listTimelineEvents`: list `timelineEventsDir(zoneId, timelineScope(sessionId))`, read event files, filter by `afterRv` and `workBlockId`, sort numeric `resourceVersion ASC`, apply limit.
- `currentTimelineResourceVersion`: read cursor JSON; return `"0"` when missing.

Use this publish helper:

```ts
private async publish(kind: WatchKind, op: WatchOp, entityId: string, generation: number): Promise<void> {
  await this.config.watchPublisher?.publish({ kind, op, entityId, generation });
}
```

- [ ] **Step 5: Export Nexus store**

Modify `src/nexus/index.ts`:

```ts
export { NexusTimelineStore } from "./nexus-timeline-store.js";
export type { NexusTimelineStoreConfig } from "./nexus-timeline-store.js";
```

- [ ] **Step 6: Run Nexus tests**

Run:

```bash
bun test src/nexus/nexus-timeline-store.test.ts src/nexus/vfs-paths.test.ts
```

Expected: pass. Add vfs path assertions if the existing path test does not cover new helpers.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/nexus/vfs-paths.ts src/nexus/vfs-paths.test.ts src/nexus/nexus-timeline-store.ts src/nexus/nexus-timeline-store.test.ts src/nexus/index.ts
git commit -m "feat: add nexus timeline store"
```

## Task 5: HTTP API And Watch Support

**Files:**
- Modify: `src/server/deps.ts`
- Modify: `src/server/operation-adapter.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/serve.ts`
- Modify: `src/server/routes/watch.ts`
- Create: `src/server/routes/work-blocks.ts`
- Create: `src/server/routes/work-blocks.test.ts`
- Create: `src/server/routes/timeline.ts`
- Create: `src/server/routes/timeline.test.ts`
- Modify: `src/server/test-helpers.ts`

- [ ] **Step 1: Write failing route tests**

Create `src/server/routes/timeline.test.ts` with a minimal app-backed test:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { TimelineEventType } from "../../core/timeline.js";
import { InMemoryTimelineStore } from "../../core/testing.js";
import { timeline } from "./timeline.js";

describe("timeline routes", () => {
  test("GET /timeline returns ordered events and current RV", async () => {
    const store = new InMemoryTimelineStore();
    await store.appendTimelineEvent({
      eventId: "te_1",
      sessionId: "s1",
      type: TimelineEventType.WorkBlockCreated,
      occurredAt: "2026-05-13T10:00:00.000Z",
      targetRefs: [{ kind: "WorkBlock", id: "wb_1" }],
      payload: {},
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("namespace", "ns/test");
      c.set("deps", { timelineStore: store });
      await next();
    });
    app.route("/", timeline);
    const res = await app.request("/timeline?sessionId=s1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.timelineResourceVersion).toBe("1");
    expect(json.events).toHaveLength(1);
  });
});
```

Create `src/server/routes/work-blocks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { InMemoryTimelineStore } from "../../core/testing.js";
import { WorkBlockOrigin, WorkBlockStatus } from "../../core/timeline.js";
import { workBlocks } from "./work-blocks.js";

describe("work block routes", () => {
  test("creates and patches a work block", async () => {
    const store = new InMemoryTimelineStore();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("namespace", "ns/test");
      c.set("deps", { timelineStore: store, watchHub: { recordWrite: () => 1n } });
      await next();
    });
    app.route("/", workBlocks);
    const create = await app.request("/work-blocks", {
      method: "POST",
      body: JSON.stringify({
        workBlockId: "wb_route",
        sessionId: "s1",
        goal: "Investigate incident",
        actor: { agentId: "agent-1" },
        origin: WorkBlockOrigin.Manual,
        status: WorkBlockStatus.Pending,
        updatedAt: "2026-05-13T10:00:00.000Z",
        inputRefs: [],
        outputRefs: [],
        evidenceRefs: [],
        approvalRefs: [],
        contributionCids: [],
        artifactHashes: [],
        claimIds: [],
        revision: 1,
        createdAt: "2026-05-13T10:00:00.000Z",
      }),
    });
    expect(create.status).toBe(201);
    const patch = await app.request("/work-blocks/wb_route", {
      method: "PATCH",
      body: JSON.stringify({ status: WorkBlockStatus.Running }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).status).toBe("running");
  });
});
```

- [ ] **Step 2: Run failing route tests**

Run:

```bash
bun test src/server/routes/timeline.test.ts src/server/routes/work-blocks.test.ts
```

Expected: fail because routes and `InMemoryTimelineStore` are missing.

- [ ] **Step 3: Add in-memory timeline test store**

Modify `src/core/testing.ts` to export `InMemoryTimelineStore` implementing `TimelineStore`. Use arrays/maps and the same monotonic per-scope counter as SQLite:

```ts
export class InMemoryTimelineStore implements TimelineStore {
  private readonly blocks = new Map<string, WorkBlock>();
  private readonly events = new Map<string, TimelineEvent>();
  private readonly counters = new Map<string, number>();
  readonly storeIdentity = "in-memory:timeline";
  async putWorkBlock(block: WorkBlock): Promise<WorkBlock> {
    this.blocks.set(block.workBlockId, block);
    return block;
  }
  async patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock> {
    const existing = this.blocks.get(workBlockId);
    if (existing === undefined) throw new Error(`WorkBlock not found: ${workBlockId}`);
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString(), revision: existing.revision + 1 };
    this.blocks.set(workBlockId, updated);
    return updated;
  }
  async getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined> {
    return this.blocks.get(workBlockId);
  }
  async listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]> {
    return [...this.blocks.values()].filter((b) => query?.sessionId === undefined || b.sessionId === query.sessionId);
  }
  async listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]> {
    return (await this.listWorkBlocks(query)).map((b) => workBlockToEntity(b, "test"));
  }
  async appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent> {
    const existing = this.events.get(input.eventId);
    if (existing !== undefined) return existing;
    const scope = timelineScope(input.sessionId);
    const next = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, next);
    const event = parseTimelineEvent({ ...input, resourceVersion: String(next), recordedAt: input.recordedAt ?? new Date().toISOString() });
    this.events.set(event.eventId, event);
    return event;
  }
  async getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined> {
    return this.events.get(eventId);
  }
  async listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]> {
    return [...this.events.values()]
      .filter((e) => e.sessionId === query?.sessionId)
      .filter((e) => query?.afterRv === undefined || Number(e.resourceVersion) > Number(query.afterRv))
      .sort((a, b) => Number(a.resourceVersion) - Number(b.resourceVersion));
  }
  async listTimelineEventEntities(query?: TimelineEventQuery): Promise<readonly TimelineEventEntity[]> {
    return (await this.listTimelineEvents(query)).map((e) => timelineEventToEntity(e, "test"));
  }
  async currentTimelineResourceVersion(sessionId?: string): Promise<string> {
    return String(this.counters.get(timelineScope(sessionId)) ?? 0);
  }
  close(): void {}
}
```

- [ ] **Step 4: Implement work block route**

Create `src/server/routes/work-blocks.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { WorkBlockSchema } from "../../core/timeline-schemas.js";
import { WorkBlockStatus } from "../../core/timeline.js";
import type { ServerEnv } from "../deps.js";

const patchSchema = z.object({
  status: z.enum(Object.values(WorkBlockStatus) as [WorkBlockStatus, ...WorkBlockStatus[]]).optional(),
}).passthrough();

export const workBlocks = new Hono<ServerEnv>();

workBlocks.get("/work-blocks", async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const sessionId = c.req.query("sessionId");
  const items = await store.listWorkBlocks({ ...(sessionId === undefined ? {} : { sessionId }) });
  return c.json({ items });
});

workBlocks.get("/work-blocks/:id", async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const block = await store.getWorkBlock(c.req.param("id"));
  return block === undefined ? c.json({ error: { code: "NOT_FOUND", message: "WorkBlock not found" } }, 404) : c.json(block);
});

workBlocks.post("/work-blocks", zValidator("json", WorkBlockSchema), async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const block = await store.putWorkBlock(c.req.valid("json"));
  return c.json(block, 201);
});

workBlocks.patch("/work-blocks/:id", zValidator("json", patchSchema), async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const block = await store.patchWorkBlock(c.req.param("id"), c.req.valid("json"));
  return c.json(block);
});
```

- [ ] **Step 5: Implement timeline route**

Create `src/server/routes/timeline.ts`:

```ts
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "../deps.js";

const timelineQuerySchema = z.object({
  sessionId: z.string().optional(),
  afterRv: z.string().regex(/^[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  includeWorkBlocks: z.coerce.boolean().optional(),
});

export const timeline = new Hono<ServerEnv>();

timeline.get("/timeline", zValidator("query", timelineQuerySchema), async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const query = c.req.valid("query");
  const events = await store.listTimelineEvents(query);
  const workBlocks = query.includeWorkBlocks === true
    ? await store.listWorkBlocks({ sessionId: query.sessionId })
    : undefined;
  return c.json({
    sessionId: query.sessionId,
    events,
    ...(workBlocks === undefined ? {} : { workBlocks }),
    timelineResourceVersion: await store.currentTimelineResourceVersion(query.sessionId),
  });
});

timeline.get("/timeline/events/:eventId", async (c) => {
  const store = c.get("deps").timelineStore;
  if (store === undefined) return c.json({ error: { code: "NOT_CONFIGURED", message: "timelineStore is not configured" } }, 501);
  const event = await store.getTimelineEvent(c.req.param("eventId"));
  return event === undefined ? c.json({ error: { code: "NOT_FOUND", message: "TimelineEvent not found" } }, 404) : c.json(event);
});
```

- [ ] **Step 6: Wire server deps and app**

Modify `src/server/deps.ts`:

```ts
import type { TimelineStore } from "../core/timeline-store.js";

export interface ServerDeps {
  readonly timelineStore?: TimelineStore | undefined;
}
```

Modify `src/server/app.ts`:

```ts
import { timeline } from "./routes/timeline.js";
import { workBlocks } from "./routes/work-blocks.js";

// Mount route groups
app.route("/api", workBlocks);
app.route("/api", timeline);
```

Modify `src/server/operation-adapter.ts`:

```ts
...(deps.timelineStore !== undefined ? { timelineStore: deps.timelineStore } : {}),
```

Modify `src/server/serve.ts`: pass `timelineStore: runtime.timelineStore` in local mode and instantiate `NexusTimelineStore` in Nexus mode.

- [ ] **Step 7: Extend watch route support**

Modify `src/server/routes/watch.ts`:

```ts
const KIND_VALUES = ["Contribution", "Claim", "AgentSession", "WorkBlock", "TimelineEvent"] as const;
const SUPPORTED_KINDS = new Set(["Contribution", "Claim", "WorkBlock", "TimelineEvent"]);
```

Extend `hydrateEntity`:

```ts
if (kind === "WorkBlock") {
  const block = await deps.timelineStore?.getWorkBlock(entityId);
  return block === undefined ? undefined : workBlockToEntity(block, namespace);
}
if (kind === "TimelineEvent") {
  const event = await deps.timelineStore?.getTimelineEvent(entityId);
  return event === undefined ? undefined : timelineEventToEntity(event, namespace);
}
```

Extend `listForKind`:

```ts
case "WorkBlock":
  return deps.timelineStore?.listWorkBlockEntities() ?? [];
case "TimelineEvent":
  return deps.timelineStore?.listTimelineEventEntities() ?? [];
```

- [ ] **Step 8: Run route and watch tests**

Run:

```bash
bun test src/server/routes/timeline.test.ts src/server/routes/work-blocks.test.ts src/server/watch.integration.test.ts src/server/watch.race.test.ts
```

Expected: pass. Add route tests for `/api/list?kind=WorkBlock` and `/api/list?kind=TimelineEvent` if watch integration tests do not cover them.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/server/deps.ts src/server/operation-adapter.ts src/server/app.ts src/server/serve.ts src/server/routes/watch.ts src/server/routes/work-blocks.ts src/server/routes/work-blocks.test.ts src/server/routes/timeline.ts src/server/routes/timeline.test.ts src/server/test-helpers.ts src/core/testing.ts
git commit -m "feat: expose timeline http and watch APIs"
```

## Task 6: Timeline Projector And Operation Wiring

**Files:**
- Create: `src/core/timeline-projector.ts`
- Create: `src/core/timeline-projector.test.ts`
- Modify: `src/core/operations/deps.ts`
- Modify: `src/core/operations/contribute.ts`
- Modify: claim operation files and server claim routes that mutate claims
- Modify: `src/core/operations/cost-tracking.ts` only if usage reports need a shared parser export

- [ ] **Step 1: Write failing projector tests**

Create `src/core/timeline-projector.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ContributionKind, ContributionMode, RelationType, type Contribution } from "./models.js";
import { TimelineEventType } from "./timeline.js";
import { timelineEventsForContribution } from "./timeline-projector.js";

const baseContribution: Contribution = {
  cid: "cid-1",
  manifestVersion: 1,
  kind: ContributionKind.Work,
  mode: ContributionMode.Exploration,
  summary: "Investigated incident",
  artifacts: { report: "blake3:abc" },
  relations: [],
  tags: ["incident"],
  agent: { agentId: "agent-1" },
  createdAt: "2026-05-13T10:00:00.000Z",
};

describe("timeline projector", () => {
  test("projects contribution and artifact events", () => {
    const events = timelineEventsForContribution(baseContribution);
    expect(events.map((e) => e.eventId)).toContain("te:contribution:cid-1:created");
    expect(events.map((e) => e.type)).toContain(TimelineEventType.ContributionCreated);
    expect(events.map((e) => e.type)).toContain(TimelineEventType.ArtifactLinked);
  });

  test("projects ask-user approval request and answer", () => {
    const question: Contribution = {
      ...baseContribution,
      cid: "cid-question",
      kind: ContributionKind.AskUser,
      context: { question_text: "Approve mitigation?" },
    };
    const answer: Contribution = {
      ...baseContribution,
      cid: "cid-answer",
      kind: ContributionKind.Response,
      relations: [{ targetCid: "cid-question", relationType: RelationType.RespondsTo }],
      context: { answer_text: "Approved" },
    };
    expect(timelineEventsForContribution(question)[1]?.type).toBe(TimelineEventType.ApprovalRequested);
    expect(timelineEventsForContribution(answer)[1]?.type).toBe(TimelineEventType.ApprovalDecided);
  });

  test("projects usage reports", () => {
    const usage: Contribution = {
      ...baseContribution,
      cid: "cid-usage",
      kind: ContributionKind.Discussion,
      context: {
        ephemeral: true,
        work_block_id: "wb_1",
        usage_report: { input_tokens: 10, output_tokens: 5, cost_usd: 0.2 },
      },
    };
    const events = timelineEventsForContribution(usage);
    expect(events.some((e) => e.type === TimelineEventType.CostReported && e.workBlockId === "wb_1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run failing projector tests**

Run:

```bash
bun test src/core/timeline-projector.test.ts
```

Expected: fail because `timeline-projector.js` does not exist.

- [ ] **Step 3: Implement projector**

Create `src/core/timeline-projector.ts`:

```ts
import type { Claim, Contribution } from "./models.js";
import { ContributionKind, RelationType } from "./models.js";
import type { TimelineEventInput } from "./timeline-store.js";
import { TimelineEventType } from "./timeline.js";

export function timelineEventsForContribution(c: Contribution): readonly TimelineEventInput[] {
  const workBlockId = typeof c.context?.work_block_id === "string" ? c.context.work_block_id : undefined;
  const base = {
    sessionId: typeof c.context?.session_id === "string" ? c.context.session_id : undefined,
    occurredAt: c.createdAt,
    actor: c.agent,
    workBlockId,
  };
  const events: TimelineEventInput[] = [
    {
      eventId: `te:contribution:${c.cid}:created`,
      ...base,
      type: TimelineEventType.ContributionCreated,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: { cid: c.cid, kind: c.kind, mode: c.mode, summary: c.summary, tags: [...c.tags] },
    },
  ];
  for (const [name, hash] of Object.entries(c.artifacts)) {
    events.push({
      eventId: `te:contribution:${c.cid}:artifact:${name}`,
      ...base,
      type: TimelineEventType.ArtifactLinked,
      targetRefs: [{ kind: "Artifact", id: hash, label: name }],
      payload: { contributionCid: c.cid, name, contentHash: hash },
    });
  }
  if (c.kind === ContributionKind.AskUser || c.context?.ask_user_question === true) {
    events.push({
      eventId: `te:contribution:${c.cid}:approval:requested`,
      ...base,
      type: TimelineEventType.ApprovalRequested,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: { question: c.context?.question_text ?? c.description ?? c.summary },
    });
  }
  if (c.kind === ContributionKind.Response || c.context?.ask_user_answer === true) {
    const questionCid = c.relations.find((r) => r.relationType === RelationType.RespondsTo)?.targetCid;
    events.push({
      eventId: `te:contribution:${c.cid}:approval:decided`,
      ...base,
      type: TimelineEventType.ApprovalDecided,
      targetRefs: [{ kind: "Contribution", id: c.cid }, ...(questionCid === undefined ? [] : [{ kind: "Contribution", id: questionCid }])],
      payload: { answer: c.context?.answer_text ?? c.description ?? c.summary },
    });
  }
  if (c.context?.usage_report !== undefined) {
    events.push({
      eventId: `te:contribution:${c.cid}:cost:reported`,
      ...base,
      type: TimelineEventType.CostReported,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: { usageReport: c.context.usage_report },
    });
  }
  return events;
}

export function timelineEventForClaim(claim: Claim, eventType: TimelineEventType): TimelineEventInput {
  return {
    eventId: `te:claim:${claim.claimId}:${claim.revision ?? 0}:${eventType}`,
    sessionId: typeof claim.context?.session_id === "string" ? claim.context.session_id : undefined,
    type: eventType,
    occurredAt: claim.heartbeatAt,
    actor: claim.agent,
    workBlockId: typeof claim.context?.work_block_id === "string" ? claim.context.work_block_id : undefined,
    targetRefs: [{ kind: "Claim", id: claim.claimId }],
    payload: { claimId: claim.claimId, targetRef: claim.targetRef, status: claim.status },
  };
}
```

- [ ] **Step 4: Wire operation deps**

Modify `src/core/operations/deps.ts`:

```ts
import type { TimelineStore } from "../timeline-store.js";

export interface OperationDeps {
  readonly timelineStore?: TimelineStore | undefined;
}
```

- [ ] **Step 5: Wire contribution timeline appends**

Modify `src/core/operations/contribute.ts` near the existing successful commit path after the contribution is stored:

```ts
if (deps.timelineStore !== undefined) {
  for (const event of timelineEventsForContribution(storedContribution)) {
    await deps.timelineStore.appendTimelineEvent(event);
  }
}
```

Import:

```ts
import { timelineEventsForContribution } from "../timeline-projector.js";
```

Keep the append after successful commit and before returning the result. Since event IDs are deterministic, retries are idempotent.

- [ ] **Step 6: Wire claim lifecycle events**

For claim write paths in core operations and server claim routes, append events only after the claim mutation succeeds:

```ts
await deps.timelineStore?.appendTimelineEvent(
  timelineEventForClaim(updatedClaim, TimelineEventType.ClaimCompleted),
);
```

Use this mapping:

- create claim -> `TimelineEventType.ClaimCreated`
- renew heartbeat -> `TimelineEventType.ClaimLeaseRefreshed`
- complete -> `TimelineEventType.ClaimCompleted`
- release -> `TimelineEventType.ClaimReleased`
- expire -> `TimelineEventType.ClaimExpired`

When a claim context has `work_block_id`, patch the linked work block status to `completed` on claim completion.

- [ ] **Step 7: Run projector and operation tests**

Run:

```bash
bun test src/core/timeline-projector.test.ts src/core/operations/contribute.test.ts src/core/operations/claim.test.ts src/server/routes/claims.test.ts
```

Expected: pass. Add assertions to existing operation tests that a contribution write appends at least one timeline event when `timelineStore` is supplied.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/core/timeline-projector.ts src/core/timeline-projector.test.ts src/core/operations/deps.ts src/core/operations/contribute.ts src/core/operations/contribute.test.ts src/core/operations/claim.test.ts src/server/routes/claims.ts src/server/routes/claims.test.ts
git commit -m "feat: project existing writes into timeline"
```

## Task 7: Providers, Informers, And CLI

**Files:**
- Modify: `src/core/informer.ts`
- Modify: `src/tui/provider.ts`
- Modify: `src/tui/local-provider.ts`
- Modify: `src/tui/remote-provider.ts`
- Modify: `src/tui/provider-shared.ts`
- Create: `src/cli/commands/work-blocks.ts`
- Create: `src/cli/commands/work-blocks.test.ts`
- Create: `src/cli/commands/timeline.ts`
- Create: `src/cli/commands/timeline.test.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Write failing informer/provider type tests**

Add to `src/core/informer.test.ts`:

```ts
test("factory supports WorkBlock and TimelineEvent in remote mode", () => {
  const factory = new InformerFactory({ mode: "remote", baseUrl: "http://localhost", authHeader: "Bearer x" });
  expect(factory.supportsKind("WorkBlock")).toBe(true);
  expect(factory.supportsKind("TimelineEvent")).toBe(true);
});
```

Add provider tests in existing provider test files that assert `getTimeline` and `getWorkBlocks` exist on local and remote providers.

- [ ] **Step 2: Run failing provider tests**

Run:

```bash
bun test src/core/informer.test.ts src/tui/local-provider.test.ts src/tui/remote-provider.test.ts
```

Expected: fail because new provider methods and informer kinds are missing.

- [ ] **Step 3: Extend informer type maps**

Modify `src/core/informer.ts`:

```ts
import type { AgentSessionEntity, ClaimEntity, ContributionEntity, TimelineEventEntity, WorkBlockEntity } from "./entity.js";

export type EntityForKind<K extends WatchKind> = K extends "Contribution"
  ? ContributionEntity
  : K extends "Claim"
    ? ClaimEntity
    : K extends "AgentSession"
      ? AgentSessionEntity
      : K extends "WorkBlock"
        ? WorkBlockEntity
        : K extends "TimelineEvent"
          ? TimelineEventEntity
          : never;

const REMOTE_KINDS: readonly WatchKind[] = ["Contribution", "Claim", "WorkBlock", "TimelineEvent"];
const LOCAL_KINDS: readonly WatchKind[] = ["Contribution", "Claim", "AgentSession", "WorkBlock", "TimelineEvent"];
```

- [ ] **Step 4: Extend provider interface**

Modify `src/tui/provider.ts`:

```ts
import type { SessionTimeline, WorkBlock } from "../core/timeline.js";

getWorkBlocks?(query?: { readonly sessionId?: string | undefined }): Promise<readonly WorkBlock[]>;
getTimeline?(query?: {
  readonly sessionId?: string | undefined;
  readonly afterRv?: string | undefined;
  readonly limit?: number | undefined;
  readonly includeWorkBlocks?: boolean | undefined;
}): Promise<SessionTimeline>;
```

Implement in `LocalProvider` using `timelineStore`. Implement in `RemoteProvider` with fetches to `/api/work-blocks` and `/api/timeline`.

- [ ] **Step 5: Add CLI commands**

Create `src/cli/commands/work-blocks.ts` with a read-only list command that resolves local context and prints JSON by default:

```ts
import type { Command } from "commander";
import { createCliContext } from "../context.js";

export function registerWorkBlocksCommand(program: Command): void {
  program
    .command("work-blocks")
    .description("List WorkBlock records")
    .option("--session <id>", "Filter by session id")
    .action(async (opts: { readonly session?: string }) => {
      const ctx = await createCliContext();
      const items = await ctx.runtime.timelineStore.listWorkBlocks({
        ...(opts.session === undefined ? {} : { sessionId: opts.session }),
      });
      console.log(JSON.stringify({ items }, null, 2));
      ctx.close();
    });
}
```

Create `src/cli/commands/timeline.ts`:

```ts
import type { Command } from "commander";
import { createCliContext } from "../context.js";

export function registerTimelineCommand(program: Command): void {
  program
    .command("timeline")
    .description("Print timeline events")
    .option("--session <id>", "Filter by session id")
    .option("--after-rv <rv>", "Only include events after resource version")
    .option("--limit <n>", "Maximum events", (value) => Number.parseInt(value, 10))
    .option("--include-work-blocks", "Include work block records")
    .action(async (opts: { readonly session?: string; readonly afterRv?: string; readonly limit?: number; readonly includeWorkBlocks?: boolean }) => {
      const ctx = await createCliContext();
      const query = {
        ...(opts.session === undefined ? {} : { sessionId: opts.session }),
        ...(opts.afterRv === undefined ? {} : { afterRv: opts.afterRv }),
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      };
      const events = await ctx.runtime.timelineStore.listTimelineEvents(query);
      const workBlocks = opts.includeWorkBlocks === true
        ? await ctx.runtime.timelineStore.listWorkBlocks({ ...(opts.session === undefined ? {} : { sessionId: opts.session }) })
        : undefined;
      const timelineResourceVersion = await ctx.runtime.timelineStore.currentTimelineResourceVersion(opts.session);
      console.log(JSON.stringify({ sessionId: opts.session, events, ...(workBlocks === undefined ? {} : { workBlocks }), timelineResourceVersion }, null, 2));
      ctx.close();
    });
}
```

Register both in `src/cli/main.ts`.

- [ ] **Step 6: Run provider and CLI tests**

Run:

```bash
bun test src/core/informer.test.ts src/tui/local-provider.test.ts src/tui/remote-provider.test.ts src/cli/commands/work-blocks.test.ts src/cli/commands/timeline.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/core/informer.ts src/core/informer.test.ts src/tui/provider.ts src/tui/local-provider.ts src/tui/local-provider.test.ts src/tui/remote-provider.ts src/tui/remote-provider.test.ts src/tui/provider-shared.ts src/cli/commands/work-blocks.ts src/cli/commands/work-blocks.test.ts src/cli/commands/timeline.ts src/cli/commands/timeline.test.ts src/cli/main.ts
git commit -m "feat: expose timeline to providers and cli"
```

## Task 8: Non-Coding Fixture And Final Verification

**Files:**
- Create: `tests/fixtures/timeline/incident-investigation.json`
- Create: `src/core/timeline-fixture.test.ts`
- Modify: `docs/superpowers/specs/2026-05-13-workblock-session-timeline-design.md` only if implementation changes the documented API

- [ ] **Step 1: Add incident fixture**

Create `tests/fixtures/timeline/incident-investigation.json`:

```json
{
  "sessionId": "incident-2026-05-13-checkout-latency",
  "workBlocks": [
    {
      "workBlockId": "wb_incident_triage",
      "sessionId": "incident-2026-05-13-checkout-latency",
      "goal": "Triage checkout latency report",
      "actor": { "agentId": "incident-lead", "role": "triage" },
      "origin": "triggered",
      "status": "completed",
      "startedAt": "2026-05-13T10:00:00.000Z",
      "updatedAt": "2026-05-13T10:05:00.000Z",
      "completedAt": "2026-05-13T10:05:00.000Z",
      "inputRefs": [{ "kind": "ticket", "id": "INC-1042", "label": "Checkout latency report" }],
      "outputRefs": [{ "kind": "summary", "id": "triage-summary" }],
      "evidenceRefs": [{ "kind": "dashboard", "id": "checkout-latency", "href": "https://example.invalid/dashboards/checkout-latency" }],
      "approvalRefs": [],
      "contributionCids": [],
      "artifactHashes": [],
      "claimIds": [],
      "costSummary": { "inputTokens": 1200, "outputTokens": 300, "costUsd": 0.08, "model": "analysis-model" },
      "revision": 1,
      "createdAt": "2026-05-13T10:00:00.000Z"
    },
    {
      "workBlockId": "wb_incident_mitigation_review",
      "sessionId": "incident-2026-05-13-checkout-latency",
      "goal": "Review proposed mitigation with operator approval",
      "actor": { "agentId": "incident-reviewer", "role": "review" },
      "origin": "agent",
      "status": "waiting_approval",
      "startedAt": "2026-05-13T10:06:00.000Z",
      "updatedAt": "2026-05-13T10:08:00.000Z",
      "inputRefs": [{ "kind": "summary", "id": "triage-summary" }],
      "outputRefs": [],
      "evidenceRefs": [{ "kind": "runbook", "id": "checkout-latency-runbook" }],
      "approvalRefs": [{ "kind": "approval", "id": "approval-mitigation-1" }],
      "contributionCids": [],
      "artifactHashes": [],
      "claimIds": [],
      "revision": 1,
      "createdAt": "2026-05-13T10:06:00.000Z"
    }
  ],
  "events": [
    {
      "eventId": "te_incident_reported",
      "resourceVersion": "1",
      "sessionId": "incident-2026-05-13-checkout-latency",
      "type": "work_block.created",
      "occurredAt": "2026-05-13T10:00:00.000Z",
      "recordedAt": "2026-05-13T10:00:01.000Z",
      "actor": { "agentId": "incident-lead", "role": "triage" },
      "workBlockId": "wb_incident_triage",
      "targetRefs": [{ "kind": "WorkBlock", "id": "wb_incident_triage" }],
      "payload": { "goal": "Triage checkout latency report" }
    },
    {
      "eventId": "te_mitigation_approval_requested",
      "resourceVersion": "2",
      "sessionId": "incident-2026-05-13-checkout-latency",
      "type": "approval.requested",
      "occurredAt": "2026-05-13T10:08:00.000Z",
      "recordedAt": "2026-05-13T10:08:01.000Z",
      "actor": { "agentId": "incident-reviewer", "role": "review" },
      "workBlockId": "wb_incident_mitigation_review",
      "targetRefs": [{ "kind": "approval", "id": "approval-mitigation-1" }],
      "payload": { "question": "Approve mitigation rollout?" }
    },
    {
      "eventId": "te_mitigation_approval_decided",
      "resourceVersion": "3",
      "sessionId": "incident-2026-05-13-checkout-latency",
      "type": "approval.decided",
      "occurredAt": "2026-05-13T10:10:00.000Z",
      "recordedAt": "2026-05-13T10:10:01.000Z",
      "actor": { "agentId": "operator", "role": "operator" },
      "workBlockId": "wb_incident_mitigation_review",
      "targetRefs": [{ "kind": "approval", "id": "approval-mitigation-1" }],
      "payload": { "decision": "approved" }
    }
  ],
  "timelineResourceVersion": "3"
}
```

- [ ] **Step 2: Add fixture parser test**

Create `src/core/timeline-fixture.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseSessionTimeline } from "./timeline-schemas.js";

describe("timeline fixtures", () => {
  test("incident investigation fixture is non-coding and schema-valid", () => {
    const raw = readFileSync(join(process.cwd(), "tests/fixtures/timeline/incident-investigation.json"), "utf8");
    const timeline = parseSessionTimeline(JSON.parse(raw));
    expect(timeline.events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(timeline.workBlocks?.some((b) => b.evidenceRefs.some((ref) => ref.kind === "dashboard"))).toBe(true);
    const serialized = JSON.stringify(timeline);
    expect(serialized).not.toContain("commitHash");
    expect(serialized).not.toContain("pullRequest");
    expect(serialized).not.toContain("programmingLanguage");
  });
});
```

- [ ] **Step 3: Run focused fixture test**

Run:

```bash
bun test src/core/timeline-fixture.test.ts
```

Expected: pass.

- [ ] **Step 4: Run full verification**

Run:

```bash
bun run typecheck
bun run check
bun test
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 8**

```bash
git add tests/fixtures/timeline/incident-investigation.json src/core/timeline-fixture.test.ts docs/superpowers/specs/2026-05-13-workblock-session-timeline-design.md
git commit -m "test: add non-coding timeline fixture"
```

## Self-Review Checklist

- Spec coverage:
  - Core TypeScript/Zod contracts: Tasks 1 and 2.
  - SQLite storage and resource versions: Task 3.
  - Nexus storage and resource versions: Task 4.
  - API and watch support: Task 5.
  - Existing entity mapping: Task 6.
  - Provider, informer, and CLI access: Task 7.
  - Non-coding fixture: Task 8.
- Placeholder scan: no red-flag placeholder wording or unspecified test-writing steps.
- Type consistency:
  - `WorkBlock`, `TimelineEvent`, `SessionTimeline`, `TimelineStore`, `WorkBlockPatch`, and `TimelineEventInput` are introduced before use.
  - `WorkBlock` and `TimelineEvent` are added to `WatchKind` before API/watch/provider tasks use them.
  - Store method names match the design spec and the conformance suite.
