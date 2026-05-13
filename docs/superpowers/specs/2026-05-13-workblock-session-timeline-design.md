# WorkBlock And SessionTimeline - Design

- **Issue**: [#375](https://github.com/windoliver/grove/issues/375)
- **Date**: 2026-05-13
- **Status**: Approved by user
- **Related**: [#193](https://github.com/windoliver/grove/issues/193), [#191](https://github.com/windoliver/grove/issues/191), [#282](https://github.com/windoliver/grove/issues/282), [#339](https://github.com/windoliver/grove/issues/339), [#376](https://github.com/windoliver/grove/issues/376), [#378](https://github.com/windoliver/grove/issues/378), [#379](https://github.com/windoliver/grove/issues/379)

## Goal

Add first-class durable models for generic agent work:

- `WorkBlock`: an inspectable segment of work with goal, actor, status, timing,
  inputs, outputs, evidence, approvals, cost, and links to existing Grove
  resources.
- `TimelineEvent`: an append-only event spine with stable event IDs and
  persistent resource versions for missed-event resume.
- `SessionTimeline`: an ordered read view over timeline events, optionally
  expanded with referenced work blocks and related entities.

This is a full-scope implementation in one PR. It includes TypeScript and Zod
contracts, local SQLite storage, Nexus storage, HTTP API routes, watch protocol
support, projection from existing entities, non-coding fixtures, and focused
tests.

## Non-goals

- Replacing immutable contributions. Contributions remain the content-addressed
  published work DAG.
- Replacing claims. Claims remain lease-based coordination objects.
- Building the final operator timeline UI. The PR exposes enough provider and
  informer support for TUI and CLI consumers, but the full visual supervision
  surface belongs to follow-up TUI issues.
- Implementing the full `AgentTask`, `RunHealth`, or `AutonomyProfile` models.
  Timeline events reserve links to those models so #376, #378, and #379 can
  attach later.
- Persisting raw transcript events from `src/trajectory`. Trajectory remains a
  post-hoc transcript index and checker; timeline events are runtime domain
  events.

## Context

Grove currently has three separate representations of work:

- `Contribution`: immutable published work in the DAG.
- `Claim`: mutable lease coordination for live work.
- `AgentSession` and session records: runtime process/session metadata.

The TUI and diagnostics surface also need an operator-facing view of what work
happened, what is happening, why it happened, what evidence supports it, where
approval was needed, and what it cost. Logs, DAG nodes, and chat turns do not
give that shape by themselves.

The foundation already exists:

- `Entity<Kind, Spec, Status>` wrappers in `src/core/entity.ts`.
- `WatchHub`, `WatchKind`, list-watch resume, and informer caches.
- SQLite and Nexus split stores with store-level write callbacks.
- `TrajectoryEventType` families that already reserve names such as
  `WORK_BLOCK_STARTED`, `TASK_SCHEDULED`, `PERMISSION_DECISION`,
  `HEALTH_DEGRADED`, and `CONTRIBUTION_CHANGED`.

This design adds canonical runtime models while keeping trajectory as a
separate transcript/checking projection.

## Core Model

### WorkBlock

`WorkBlock` is the durable unit operators inspect. It is intentionally generic
and does not require code, commits, pull requests, files, or tests.

```ts
export const WorkBlockStatus = {
  Pending: "pending",
  Running: "running",
  Blocked: "blocked",
  WaitingApproval: "waiting_approval",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export const WorkBlockOrigin = {
  Manual: "manual",
  Agent: "agent",
  Scheduled: "scheduled",
  Triggered: "triggered",
} as const;

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
```

`workBlockId` is generated as `wb_<uuid>`. `revision` starts at `1` and
increments on every status or metadata patch. `WorkBlockEntity.resourceVersion`
is `String(revision)`.

`ResourceRef` is shared by work blocks and events:

```ts
export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string | undefined;
  readonly href?: string | undefined;
}
```

The `kind` field is open so future objects such as `AgentTask`, `RunHealth`,
external tickets, documents, dashboards, and scheduled jobs can link without a
schema migration.

`CostSummary` is deliberately small and additive:

```ts
export interface CostSummary {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly model?: string | undefined;
}
```

### TimelineEvent

`TimelineEvent` is append-only. It is the durable replay and resume spine for a
session timeline.

```ts
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
```

`eventId` is stable and generated as `te_<uuid>`. `resourceVersion` is a
persistent monotonic string per `(namespace, sessionId-or-global)` timeline:

- SQLite stores it as an integer sequence in a `timeline_cursors` table.
- Nexus stores it with an ETag compare-and-swap counter file under the timeline
  namespace.

Clients resume timeline reads with `afterRv`. The server returns all events
where `resourceVersion > afterRv` in numeric order.

### Timeline Event Types

Use lowercase dot-separated event names for runtime domain events. The
trajectory checker can map these to its uppercase `TrajectoryEventType` names
when needed.

Initial event names:

- `work_block.created`
- `work_block.started`
- `work_block.status_changed`
- `work_block.completed`
- `work_block.failed`
- `agent_session.started`
- `agent_session.status_changed`
- `agent_session.stopped`
- `claim.created`
- `claim.lease_refreshed`
- `claim.completed`
- `claim.released`
- `claim.expired`
- `contribution.created`
- `artifact.linked`
- `approval.requested`
- `approval.decided`
- `cost.reported`
- `plan.task_created`
- `plan.task_status_changed`
- `run.health_degraded`
- `run.health_recovered`

The names avoid coding-only terms. A research synthesis and an incident
investigation can use the same event vocabulary as a coding workflow.

```ts
export type TimelineEventType =
  | "work_block.created"
  | "work_block.started"
  | "work_block.status_changed"
  | "work_block.completed"
  | "work_block.failed"
  | "agent_session.started"
  | "agent_session.status_changed"
  | "agent_session.stopped"
  | "claim.created"
  | "claim.lease_refreshed"
  | "claim.completed"
  | "claim.released"
  | "claim.expired"
  | "contribution.created"
  | "artifact.linked"
  | "approval.requested"
  | "approval.decided"
  | "cost.reported"
  | "plan.task_created"
  | "plan.task_status_changed"
  | "run.health_degraded"
  | "run.health_recovered";
```

### SessionTimeline

`SessionTimeline` is a read model, not a stored aggregate:

```ts
export interface SessionTimeline {
  readonly sessionId?: string | undefined;
  readonly events: readonly TimelineEvent[];
  readonly workBlocks?: readonly WorkBlock[] | undefined;
  readonly timelineResourceVersion: string;
}
```

The API can return events only or include expanded work blocks. This prevents a
large timeline document from being rewritten on every event and keeps watch
payloads small.

## Entity And Watch Integration

Add two new entity projections in `src/core/entity.ts`:

- `WorkBlockEntity = Entity<"WorkBlock", WorkBlockSpec, WorkBlockStatusBody>`
- `TimelineEventEntity = Entity<"TimelineEvent", TimelineEventSpec, Record<string, never>>`

Extend `WatchKind`:

```ts
export type WatchKind =
  | "Contribution"
  | "Claim"
  | "AgentSession"
  | "WorkBlock"
  | "TimelineEvent";
```

Remote and local informer support both add `WorkBlock` and `TimelineEvent`.
`TimelineEvent` is append-only, so watch events for it are `ADDED` only.
`WorkBlock` emits `ADDED`, `MODIFIED`, and `DELETED` when a backend supports
deletion or cleanup.

The existing watch RV and `entity.resourceVersion` distinction remains:

- Watch RV: per `(namespace, kind)` counter in `WatchHub`, used by
  `/api/list` and `/api/watch`.
- Entity resource version: per-row revision for `WorkBlock`, persistent
  timeline sequence for `TimelineEvent`.

## Stores

Add a new protocol in `src/core/timeline-store.ts`:

```ts
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
  patchWorkBlock(
    workBlockId: string,
    patch: WorkBlockPatch,
  ): Promise<WorkBlock>;
  getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined>;
  listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]>;
  listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]>;
  appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent>;
  getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined>;
  listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]>;
  listTimelineEventEntities(
    query?: TimelineEventQuery,
  ): Promise<readonly TimelineEventEntity[]>;
  currentTimelineResourceVersion(sessionId?: string): Promise<string>;
  close(): void;
}
```

Use one store instead of separate `WorkBlockStore` and `TimelineEventStore`
because status patches and event appends often need to happen in one backend
transaction.

### SQLite Schema

Add DDL to `src/local/sqlite-store.ts` and bump `CURRENT_SCHEMA_VERSION`.

```text
work_blocks(
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
)

timeline_cursors(
  scope TEXT PRIMARY KEY,
  current_rv INTEGER NOT NULL DEFAULT 0
)

timeline_events(
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
)
```

Indexes:

- `idx_work_blocks_session_status` on `(session_id, status, updated_at)`
- `idx_work_blocks_actor` on `(actor_id, updated_at)`
- `idx_timeline_events_scope_rv` on `(scope, resource_version)`
- `idx_timeline_events_work_block` on `(work_block_id, resource_version)`
- `idx_timeline_events_type` on `(type, recorded_at)`

SQLite appends increment the cursor inside the same transaction that inserts
the event. Work block status patches and their timeline event can be committed
atomically.

### Nexus Storage

Add `NexusTimelineStore` with paths:

```text
/zones/{zoneId}/work-blocks/{workBlockId}.json
/zones/{zoneId}/indexes/work-blocks/session/{sessionId}/{updatedAt}-{workBlockId}.json
/zones/{zoneId}/indexes/work-blocks/status/{status}/{updatedAt}-{workBlockId}.json
/zones/{zoneId}/timeline/cursors/{scope}.json
/zones/{zoneId}/timeline/events/{scope}/{rv}-{eventId}.json
/zones/{zoneId}/timeline/by-id/{eventId}.json
```

`scope` is `global` when `sessionId` is absent, otherwise
`session/{encodedSessionId}`. The cursor file is updated with an ETag
compare-and-swap loop:

1. Read current counter and ETag.
2. Write `counter + 1` with `ifMatch`.
3. Retry on conflict with bounded backoff.
4. Write event body and by-id marker in one batch.

This gives Nexus the same persistent resume semantics as SQLite.

## API Routes

Add `src/server/routes/work-blocks.ts`:

- `GET /api/work-blocks`
- `GET /api/work-blocks/:id`
- `POST /api/work-blocks`
- `PATCH /api/work-blocks/:id`

Add `src/server/routes/timeline.ts`:

- `GET /api/timeline?sessionId=&afterRv=&limit=&includeWorkBlocks=`
- `GET /api/timeline/events/:eventId`

Response shape:

```json
{
  "sessionId": "grove-session",
  "events": [],
  "workBlocks": [],
  "timelineResourceVersion": "42"
}
```

Extend `/api/list`, `/api/watch`, and `/api/watch/notify` to support
`WorkBlock` and `TimelineEvent`. `listForKind` delegates to
`timelineStore.listWorkBlockEntities()` and
`timelineStore.listTimelineEventEntities()`.

## Runtime And Dependency Wiring

Extend `OperationDeps`, `ServerDeps`, MCP deps, and local runtime deps with
`timelineStore?: TimelineStore`.

`createLocalRuntime()` constructs `SqliteTimelineStore` from the shared
database. In local mode, `createWatchHubRecorder` gains `workBlock()` and
`timelineEvent()` methods and wires `SqliteTimelineStore.onWorkBlockWrite` and
`onTimelineEventWrite` to `WatchHub.recordWrite`.

In Nexus mode, `serve.ts` constructs `NexusTimelineStore` with the same
`NexusWatchPublisher` used by contribution and claim stores.

`toOperationDeps()` forwards `timelineStore` and records timeline entity writes
through the same watch subscriber dedupe path.

## Projection Rules

Create `src/core/timeline-projector.ts`. Projection is explicit and shared by
HTTP, MCP, CLI, and local store callbacks.

Initial mappings:

- `Contribution` writes append `contribution.created`.
- Contribution artifacts append `artifact.linked` events when artifact refs are
  present.
- Contribution context with `ask_user_question` or kind `ask_user` appends
  `approval.requested`.
- Contribution context with `ask_user_answer` or kind `response` appends
  `approval.decided`.
- Usage report context appends `cost.reported` and updates linked work block
  `costSummary` when `work_block_id` exists in context.
- Plan contribution creation or update emits `plan.task_created` and
  `plan.task_status_changed` by diffing the previous plan context when a
  `derives_from` relation points at another plan.
- Claim create, renew, complete, release, and expire append claim lifecycle
  events and update related work blocks when a `work_block_id` is present in
  claim context.
- Agent runtime session changes append `agent_session.*` events when runtime
  callbacks are available. Remote `AgentSession` watch support remains gated on
  the same store availability as existing session work.

Projection must be idempotent. Event IDs for derived events are deterministic:

```text
te:contribution:{cid}:created
te:contribution:{cid}:artifact:{name}
te:claim:{claimId}:{revision}:{eventType}
te:plan:{cid}:task:{taskId}:{status}
```

Direct manual work-block API events use random `te_<uuid>` IDs because they do
not have an existing source-resource key.

## How The Models Differ

`Contribution` is immutable published work. It answers "what artifact or
message was produced" and participates in the contribution graph.

`Claim` is mutable coordination. It answers "who currently owns this target"
and uses leases to prevent duplicate work.

`WorkBlock` is durable operator progress. It answers "what unit of work was or
is being performed" and gathers inputs, outputs, evidence, approvals, and cost.

`TimelineEvent` is append-only history. It answers "what happened, in what
order, and where should a client resume".

`SessionTimeline` is a read view over the event spine. It is not an aggregate
that rewrites history.

## Client And Provider Support

Extend these surfaces enough for consumers to use the new data:

- `RemoteProvider`: `getWorkBlocks`, `getTimeline`, and informer support for
  `WorkBlock` and `TimelineEvent`.
- `LocalProvider`: same methods backed by `TimelineStore`.
- `InformerFactory`: support the new kinds in local and remote mode.
- `EntityStore` typing: map `WorkBlock` and `TimelineEvent` to their entity
  shapes.
- CLI: add read-only commands `grove work-blocks list` and `grove timeline`.
  `grove timeline` accepts `--session`, `--after-rv`, `--limit`, and
  `--include-work-blocks`.

No final TUI timeline panel is required in this PR. Existing panels can use
the provider methods after this lands.

## Fixtures

Add `tests/fixtures/timeline/incident-investigation.json` with a non-coding
workflow:

- Incident reported.
- Triage block starts.
- Evidence collection block records dashboard and log refs.
- Mitigation review waits for approval.
- Approval decision recorded.
- Customer communication or final summary block completes.

The fixture must not require commit hashes, code paths, pull requests, tests,
or programming-language fields.

A research synthesis fixture is a good follow-up candidate, but the incident
investigation fixture is the required non-coding acceptance fixture for this
PR.

## Testing

Use Bun tests.

Core tests:

- Zod schema accepts complete and minimal valid `WorkBlock`, `TimelineEvent`,
  and `SessionTimeline` values.
- Zod schema rejects non-JSON payloads, invalid status, negative costs, and
  malformed timestamps.
- Entity adapters set IDs, conditions, observed generation, metadata, and
  resource versions correctly.
- Projectors produce deterministic event IDs and idempotently skip duplicates.
- Plan diff projection emits task status changes only for changed tasks.

Store tests:

- SQLite store persists work blocks and timeline events across reopen.
- SQLite resource versions increment atomically and resume with `afterRv`.
- SQLite patch plus event append can be committed atomically.
- Nexus store uses CAS cursor retries and returns events in resource-version
  order.
- Nexus store conformance covers get, list, patch, append, and resume.

Watch and API tests:

- `/api/list?kind=WorkBlock` and `/api/watch?kind=WorkBlock` use the existing
  list-watch handshake.
- `/api/list?kind=TimelineEvent` and `/api/watch?kind=TimelineEvent` replay
  append-only events after `resumeFrom`.
- `/api/timeline?afterRv=` returns only newer events and the current timeline
  resource version.
- `/api/watch/notify` hydrates canonical `WorkBlock` and `TimelineEvent`
  entities before broadcasting.

Fixture tests:

- Incident investigation fixture parses through Zod and stores successfully.
- Timeline contains approval, evidence, cost, and completion events without
  coding-only required fields.

Integration tests:

- Contribution write creates `contribution.created`.
- Ask-user request and answer create approval events.
- Usage report creates cost event and updates linked work-block cost summary.
- Claim complete creates claim and work-block status events when linked.

## Rollout

The PR should land in this order:

1. Core contracts, schemas, entity adapters, and tests.
2. SQLite timeline store, migrations, and conformance tests.
3. Nexus timeline store, paths, CAS counter, and conformance tests.
4. API routes and watch kind support.
5. Projector wiring from existing operations and store callbacks.
6. Provider/informer support.
7. Fixtures and end-to-end route tests.

## Risks

The largest risk is duplicate derived events from multiple write paths. Use
deterministic event IDs for projections and make `appendTimelineEvent`
idempotent by `eventId`.

The second risk is Nexus counter contention. The CAS loop uses bounded retry
and returns a clear transient error after exhaustion. Timeline appends are not
in the hot path like token streaming, so the retry cost is acceptable.

The third risk is over-scoping UI. This design intentionally stops at provider,
informer, and route support. It creates the data model needed by the future
operator surface without forcing the visual redesign into the same PR.

## Acceptance Mapping

- TypeScript/Zod contracts: `src/core/timeline.ts` and
  `src/core/timeline-schemas.ts`.
- Mapping existing entities: `src/core/timeline-projector.ts` plus operation
  and store callback wiring.
- Stable IDs and resource versions: deterministic or UUID event IDs plus
  persistent per-session timeline RV counters.
- Non-coding fixture: incident investigation timeline fixture.
- Documentation of distinctions: "How The Models Differ" section above and
  exported model doc comments.
