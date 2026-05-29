# Design: AcpxRuntime Supervisor Registry (respawn + auto-resume)

**Date:** 2026-05-29
**Issue:** [windoliver/grove#273](https://github.com/windoliver/grove/issues/273) — `feat(runtime): AcpxRuntime supervisor registry with respawn + auto-resume`
**Related:** [#210](https://github.com/windoliver/grove/issues/210) runtime adapter tests (supervisor is asserted against) · [#261](https://github.com/windoliver/grove/issues/261) typed `AcpxTurn` (supervisor feeds the typed stream) · [#319](https://github.com/windoliver/grove/issues/319) wire-session binding · [grove-direct-acp-runtime](2026-04-21-grove-direct-acp-runtime-design.md) (the `AcpRuntime` this wraps) · [tui-agent-supervision-hero](2026-05-18-tui-agent-supervision-hero-design.md) (#193, consumes health/respawn signals)
**Status:** Draft — awaiting user review

---

## Problem

Grove spawns one acpx child per agent and tracks its lifecycle ad-hoc. When a child dies, nothing detects it as a *recoverable* event: the process just stops emitting, the bound work unit eventually trips a "session lost → Failed" path, and any lease the agent held sits stranded until it expires. acpx exposes no server-side `session/list`, so grove cannot ask "what processes should be alive?" — it must own that inventory itself.

We want a **supervisor**: a grove-owned registry of single-child runtime handles keyed by a stable logical slot, with three guarantees:

1. **Detect** an unexpected child death as a typed, observable event (today it is a silent log line).
2. **Respawn** the child under the same logical identity and continue the event sequence so downstream consumers (Nexus, TUI) do not replay or duplicate events.
3. **Surface** the loss as a condition on the affected work unit instead of letting it strand — and only give up (and release leases) after a bounded retry budget.

---

## Current state (verified against the worktree)

These were confirmed by reading the source, not the issue text. Several issue references describe an *intended* shape that does not exist yet; those deltas are called out in **Issue ↔ reality** below.

- **`src/core/agent-runtime.ts`** — `AgentRuntime` interface: `spawn(role, config) → AgentSession`, `send(session, msg) → AcpxTurn`, `close(session)`, `onIdle(session, cb)`, `listSessions()`, `listSessionEntities()`, `isAvailable()`, and a `sendsInitialPromptOnSpawn` flag. `AgentSession.status` is `"running" | "idle" | "stopped" | "crashed"`.
- **`src/core/acp-runtime.ts`** — `AcpRuntime implements AgentRuntime`. One instance owns **many** children via a private `sessions: Map`. Each child is created by `launchSubprocess()` (`nodeSpawn`, line ~387). The only exit handling is in `dispose()` (intentional teardown, lines ~472–500) via `waitForChildExit`; there is **no listener that fires on *unexpected* exit**, marks the session crashed, or rejects an in-flight `send()`. `AgentDisconnectedError` does not exist anywhere in the codebase. A turn that ends with `stopReason === "error"` flips the session to `crashed` (line ~862), but a hard PID death mid-turn is not surfaced — the turn can hang.
- **`src/acp/types.ts`** — `AcpxTurn { sessionId; turnId; messages: AsyncIterable<Message>; result: Promise<Result>; cancel(); close() }`. `wireSessionId` (the acpx-internal UUID) is learned from the `session/new` handshake (#319) and is unique per process — a respawn MUST re-learn it and never reuse a dead child's binding.
- **`src/nexus/nexus-agent-publisher.ts`** — `publishTurnToNexus(opts)` drains `opts.messages`, emits one `acp.message` per `Message` and a terminal `acp.result`, returns `PublishResult[]`. **There is no sequence number.** Ordering is implicit in iteration order; there is no `seq`/`startSeq` parameter and nothing persists a per-session counter across turns. A re-drain of the same turn would double-publish.
- **`src/core/task-controller.ts`** — a Kubernetes-style reconciler. `DefaultTaskBinder.bind()` is the thing that calls `runtime.spawn()` for an `AgentTask`. `reconcileRunning()` calls `runtime.listSessions()` and, if the bound session is absent or not `running`/`idle`, runs `failLostSession()` → sets `Running=False` + `Failed=True` conditions with `reason: "session-lost"` and moves the task to `phase: Failed`. **This is the real "session lost" surface today, and it is terminal — there is no respawn.**
- **`src/core/agent-task.ts`** — the durable agent-work entity. `AgentTaskStatusRecord` carries a real **stored** `conditions: Condition[]` array (unlike Claims, whose conditions are projected read-side). `AgentTaskConditionType` = `Admitted | Scheduled | Bound | Running | AwaitingReview | Succeeded | Failed | Blocked | Unschedulable | PermitRequired | DoneSignaled`. There is **no `SessionLost` / `Resuming`** type yet. `AgentTaskPhase` = `Pending | PendingBind | Running | AwaitingReview | Succeeded | Failed`.
- **Two spawn paths** both go through the `AgentRuntime` interface: the older `SessionOrchestrator.spawnAgent()` (per role) and the newer `TaskController` / `DefaultTaskBinder` (per `AgentTask`). Anything that decorates `AgentRuntime` is transparent to both.
- **Tests** — `bun test` (bun:test, co-located `*.test.ts`); integration `GROVE_INTEGRATION`/`NEXUS_URL`-gated `*.integration.test.ts`; real-process E2E via `grove up` (never `nexus up` directly — see project memory). No shared "runtime adapter matrix" harness exists yet; the closest runtime tests are `mock-runtime.test.ts`, `acp-runtime.test.ts`, `acp-runtime.spawn.test.ts`, `acp-runtime.integration.test.ts`. `docs/parity-matrix.md` is capability parity, not a runtime-adapter conformance suite.

### Issue ↔ reality deltas (resolved in this design)

| Issue says | Reality | Resolution |
|---|---|---|
| `handle: AcpxRuntime` | class is `AcpRuntime` | Registry holds `AcpRuntime`; "Acpx" kept only in supervisor type names. |
| key includes `slotId` (a grove "slot") | grove has no agent "slot" concept (slots = gossip capacity / TUI insertion points) | `slotId` = a **caller-supplied stable logical key** (recommend the `AgentTask` id where available, else a session-role key). The supervisor treats it as opaque; it only requires stability across respawn. |
| `acpxRecordId` "durable key, survives PID changes" via `session/load` | acpx has no server-side session record; grove-direct-acp **defers `session/load`** (fresh session per spawn) | `acpxRecordId` = **grove-minted UUID**, 1:1 with `slotId`, stable across PID changes, used as the durable handle in logs/events. No `session/load`. |
| step 3 "Attempt `session/load` via `acpxRecordId`" | not wired; explicitly deferred upstream + in grove-direct-acp | **Respawn-as-new.** Every respawn is a fresh `session/new`; conversation state is not restored. Forward-compatible: `acpxRecordId` + seq survive if `session/load` ever lands. |
| step 4 "mark `conditions:[{type:SessionLost…}]` on the **claim**" | Claims have no stored conditions; the real stored-condition surface is **`AgentTask`** | Add a `SessionLost` (and `Resuming`) condition to `AgentTaskConditionType` and set it on the `AgentTask`. Stranded *leases* are released only on permanent death (see Phase 4). |
| `lastSeq` "consumers dedup via `seq`" | no seq exists anywhere | Supervisor introduces and owns a monotonic per-slot `seq`, threaded into the publisher (Phase 3). Until `session/load` exists it is ordering/boundary-marking only; the field is kept for forward-compat. |
| "#210 tests assert against the supervisor" | no adapter-matrix harness exists | Phase 2 **creates** a small shared `runRuntimeAdapterMatrix(label, factory)` and runs `MockRuntime`, `AcpRuntime`, and `AcpxSupervisor` through it — delivering #210 as part of this work. |

---

## Decisions (locked; user delegated all five to "whatever you recommend")

| # | Question | Decision & rationale |
|---|---|---|
| D1 | Deliverable | **Design doc → plan → implement (TDD), staged into sub-issues.** The work is ahead of current code in five load-bearing ways and touches the runtime hot path; a reviewed spec first is cheaper than reworking an implementation. Matches the user's `design-review → per-phase issues` preference. |
| D2 | What is a "slot"? | **`slotId` = caller-supplied stable logical key** (opaque to the supervisor). Recommended value: `AgentTask.spec.id` via `TaskController`, or a `grove-<role>-<n>` session-role key via `SessionOrchestrator`. `acpxRecordId` = supervisor-minted durable UUID, 1:1 with the slot, surviving PID changes. |
| D3 | Ownership model | **Supervisor decorates `AgentRuntime`; one single-child `AcpRuntime` per slot.** The supervisor constructs `new AcpRuntime()` per entry and calls `spawn` on it exactly once → effectively one process per slot, honoring "don't share one instance across slots." `AcpRuntime` internals are left intact (it merely gains a disconnect callback). The decorator multiplexes the `AgentRuntime` interface across entries, so it is a drop-in for both spawn paths and for #210. |
| D4 | Resume semantics | **Respawn-as-new + always surface `SessionLost`.** No `session/load` (consistent with grove-direct-acp). `seq` continues monotonically across the respawn boundary so downstream ordering is unbroken. |
| D5 | `SessionLost` surface | **On the `AgentTask`**, via a new `SessionLost` condition (and a transient `Resuming` condition), set by the **wiring layer** in response to a supervisor-emitted respawn event — the supervisor itself stays decoupled from claims/tasks. Stranded leases are proactively released only when the slot is permanently `dead`. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ grove process                                                         │
│                                                                      │
│  SessionOrchestrator.spawnAgent ─┐                                   │
│  TaskController / DefaultBinder ─┤ both call the AgentRuntime API    │
│                                  ▼                                   │
│                       ┌───────────────────────────┐                 │
│                       │ AcpxSupervisor            │ implements      │
│                       │  (AgentRuntime decorator) │ AgentRuntime    │
│                       │                           │                 │
│                       │  registry: Map<slotId,    │                 │
│                       │            AcpxRegistryEntry>               │
│                       │  ensure / get / stop / list                 │
│                       │  onRespawn(cb)  ──────────┼──► wiring layer  │
│                       └───────────┬───────────────┘   (sets         │
│                                   │ one entry per slot  SessionLost  │
│                                   ▼                     on AgentTask)│
│            ┌──────────────────────┴───────────────────┐            │
│            │ AcpRuntime (single child)  × N slots      │            │
│            │   child ⇄ ClientSideConnection ⇄ AcpxTurn │            │
│            │   onDisconnect(cb)  ◄── NEW death seam     │            │
│            └──────────────────────┬───────────────────┘            │
│                                   │ send() turn drained once by      │
│                                   ▼ supervisor, seq threaded         │
│                          publishTurnToNexus(startSeq) ──► EventBus    │
└──────────────────────────────────────────────────────────────────────┘
```

The supervisor is **runtime-level and decoupled**: it knows about processes, slots, turns, and seq — not about claims, tasks, or conditions. It emits typed respawn-lifecycle events; the wiring layer translates those into `AgentTask` conditions and lease releases. This keeps the supervisor unit-testable with zero store dependencies and puts `SessionLost` where grove actually stores conditions.

### Types (new `src/core/acpx-supervisor.ts`)

```ts
export interface AcpxKey {
  readonly slotId: string;                 // caller-supplied, stable across respawn
  readonly backend: "claude-code" | "codex" | "gemini";
  readonly cwd: string;
  readonly sessionName?: string | undefined;
}

export type AcpxPhase = "starting" | "running" | "resuming" | "dead";

export interface AcpxRegistryEntry {
  readonly key: AcpxKey;
  readonly handle: AcpRuntime;             // owns exactly one child
  readonly acpxRecordId: string;           // supervisor-minted; survives PID changes
  session: AgentSession;                    // current live session (new id per respawn)
  lastSeq: number;                          // monotonic; threaded into the publisher
  lastRequestId?: string | undefined;
  phase: AcpxPhase;
  respawns: number;                         // crash-loop budget counter
}

export type AcpxRespawnEvent =
  | { kind: "resuming"; key: AcpxKey; acpxRecordId: string; deadSessionId: string; respawns: number }
  | { kind: "resumed";  key: AcpxKey; acpxRecordId: string; newSessionId: string; lastSeq: number }
  | { kind: "dead";     key: AcpxKey; acpxRecordId: string; reason: string; respawns: number };

export interface AcpxSupervisor extends AgentRuntime {
  ensure(key: AcpxKey, config: AgentConfig): Promise<AcpxRegistryEntry>;
  get(slotId: string): AcpxRegistryEntry | undefined;
  stop(slotId: string, reason: string): Promise<void>;
  list(): readonly AcpxRegistryEntry[];
  onRespawn(cb: (event: AcpxRespawnEvent) => void): void;
}
```

`extends AgentRuntime` is the decorator façade: `spawn → ensure`, `send → route to the slot's handle`, `close → stop`, `listSessions → list().map(e => e.session)`, `onIdle → delegate to the slot's handle`, `isAvailable → true`. `listSessions()` is **respawn-aware**: during `resuming` it reports the most recent live session, so `TaskController.reconcileRunning` does not spuriously trip `failLostSession`.

### Death-detection seam (in `AcpRuntime`)

```ts
// agent-runtime.ts (or core/errors.ts)
export class AgentDisconnectedError extends Error {
  constructor(readonly info: {
    sessionId: string; role: string;
    exitCode?: number | null; signal?: NodeJS.Signals | null;
    lastRequestId?: string;
  }) { super(`agent ${info.role} (${info.sessionId}) disconnected`); }
}

// AgentRuntime gains an optional hook (no-op default on other runtimes):
onDisconnect?(session: AgentSession, cb: (err: AgentDisconnectedError) => void): void;
```

In `AcpRuntime`, attach a child `"exit"` / connection-EOF listener that, **only when the session was not intentionally `close()`d**, marks the session `crashed`, rejects any in-flight `send()` with `AgentDisconnectedError`, and invokes registered `onDisconnect` callbacks exactly once. Intentional `dispose()`/`close()` must not fire it.

---

## Respawn + auto-resume + seq continuity

On `onDisconnect` for a slot whose `phase === "running"`:

1. `phase = "resuming"`; emit `{ kind: "resuming", deadSessionId, respawns }`.
2. Tear down the dead handle (`handle.close` / dispose).
3. **Crash-loop guard:** if `respawns >= MAX_RESPAWNS`, set `phase = "dead"`, emit `{ kind: "dead", reason }`, stop. Otherwise apply exponential backoff (`BACKOFF_BASE_MS * 2^respawns`, capped), `respawns++`.
4. Construct a **fresh** `new AcpRuntime()`, `spawn` the same `AcpxKey`/config → new `session.id` and a freshly learned `wireSessionId` (never the dead one, per #319).
5. `phase = "running"`; emit `{ kind: "resumed", newSessionId, lastSeq }`.

**Seq continuity.** The supervisor is the **single owner of the turn drain** for its slots. Every `send()` turn is drained via `publishTurnToNexus({ …, startSeq: entry.lastSeq })`; the returned final seq is written back to `entry.lastSeq`. This requires (Phase 3) adding a `startSeq?: number` parameter to `publishTurnToNexus` and stamping `payload.seq` on each event. Across a respawn, `lastSeq` is preserved, so the post-respawn turn continues the sequence with no reset and no gap. An audit of existing `publishTurnToNexus` / `SessionOrchestrator.watchTurn` callers guarantees **exactly one drain per turn** (no double-publish).

---

## SessionLost surfacing (wiring layer)

Add to `AgentTaskConditionType`: `Resuming`, `SessionLost`. The wiring layer (`src/server/task-controller-wiring.ts` and/or `SessionOrchestrator`) subscribes to `supervisor.onRespawn`:

- `resuming` → patch the `AgentTask` bound to that slot: `Resuming = True (reason: "acpx-disconnected")`, keep `phase: Running` (do **not** Fail).
- `resumed` → `Resuming = False`, `SessionLost = True (reason: "respawned", message: "<n> respawns")`, update `status.sessionId` to the new session id, keep `phase: Running`.
- `dead` → fall through to the existing `failLostSession()` path (`Failed`, `reason: "session-lost"`) **and** release any leases the agent held (proactive de-stranding; today they wait for lease expiry).

Because `listSessions()` is respawn-aware, `reconcileRunning` keeps seeing a live session during a transient blip and will not race the supervisor to `Failed`. The `AgentTask`'s stored conditions become the audit trail of respawns, which the #193 supervision surface can render (`thrashing` health already keys off retry counts).

---

## Phase breakdown (each → a sub-issue under #273)

Dependency order: **P1 → P2 → P3 → P4 → P5.** P4 can start once P2 lands; P3 is the only one touching the Nexus publisher.

- **P1 — Death-detection seam.** `AgentDisconnectedError`; `AcpRuntime` unexpected-exit listener; reject in-flight `send`; `onDisconnect` hook; optional `onDisconnect` on `AgentRuntime`. Tests via `launchOverride` / an in-process agent that force-exits. *Done when:* killing a child mid-turn rejects `send` with `AgentDisconnectedError`; `onDisconnect` fires once on crash, never on clean `close`; existing acp-runtime tests stay green.
- **P2 — Supervisor registry core + adapter matrix.** `AcpxSupervisor` (`ensure` idempotent + single-flight, `get`/`stop`/`list`, AgentRuntime façade, respawn-aware `listSessions`). Create `runRuntimeAdapterMatrix(label, factory)` and run `MockRuntime` + `AcpRuntime` + `AcpxSupervisor` through it (delivers #210). *Done when:* same key ⇒ same entry/one child; distinct keys ⇒ distinct children; `stop` terminates + removes; matrix green for all three runtimes.
- **P3 — Respawn + auto-resume + seq.** Subscribe to P1; `running → resuming → running`; fresh runtime per respawn; backoff + `MAX_RESPAWNS → dead`; add `startSeq` to `publishTurnToNexus` + stamp `seq`; supervisor owns the drain and threads `lastSeq`; audit callers for exactly-one-drain. *Done when:* simulated disconnect drives the phase cycle with a new `wireSessionId`; `seq` continues strictly increasing across respawn (asserted against a fake bus); no duplicate events; entry settles `dead` after the cap with backoff respected.
- **P4 — `SessionLost` on AgentTask + wiring.** Add `Resuming`/`SessionLost` condition types; wiring subscribes to `onRespawn` and patches the task; permanent-death releases leases; ensure `reconcileRunning` does not race the supervisor. *Done when:* respawn yields `SessionLost=True` on the task while it stays `Running`; permanent death yields `Failed` + released leases; condition-projection tests updated.
- **P5 — Orchestrator adoption + real-process E2E.** Route `SessionOrchestrator.spawnAgent` (and the TaskController binder) through `supervisor.ensure`; remove any double-drain. New `GROVE_INTEGRATION` E2E (pattern of `tests/e2e/*-tmux.ts`): launch a real agent via `grove up`, `kill -9` its acpx child, assert respawn within backoff, `SessionLost` visible on the task via the entity/TUI path (no manual probe), monotonic `seq` with no reset, agent continues. Validate against **Nexus stores, not local SQLite**; no manual `send-keys`.

---

## Testing strategy

- **Unit (TDD, per phase):** in-process / `launchOverride` agents + a fake `EventBus`; no real subprocesses. Cover death detection, registry lifecycle, respawn + seq continuity, condition patching.
- **Adapter conformance:** `runRuntimeAdapterMatrix` over Mock/Acp/Supervisor (#210).
- **Integration / E2E:** kill-PID respawn under `grove up` against Nexus (P5), `GROVE_INTEGRATION`-gated.

## Risks & mitigations

- **Double-drain / double-publish** (seq reset, duplicated events) → supervisor is the single drain owner; thread `startSeq`; audit all `publishTurnToNexus`/`watchTurn` callers for exactly-one-drain.
- **Reusing a dead `wireSessionId`** (#319 contamination) → respawn always builds a fresh runtime/`session/new`; never copy the dead binding.
- **Respawn storm** on a crash-looping backend → backoff + `MAX_RESPAWNS` → `dead` + operator surface; never respawn-storm.
- **Orphaned children** if the grove process dies (acpx has no `session/list`) → grove inventory is authoritative; persist enough of the registry to reconcile/reap on restart (follow-up; noted as OQ).
- **`reconcileRunning` vs supervisor race** → respawn-aware `listSessions()` + `Resuming` condition keep the controller from premature `Failed`.
- **Resource growth** (one process per slot) → note capacity implications; a concurrent-slot cap is a follow-up.

## Out of scope

- ACP `session/load` / `session/fork` (upstream-unsupported; explicit non-goal). Design stays forward-compatible.
- Sharing one acpx instance across slots (non-goal).
- Cross-host / gossip-capacity "slots" supervision (unrelated concept).
- Persisting the registry across grove restarts (orphan reaping) — noted as an open question, not built here.

## Open questions (for review)

- **OQ1 — slot key source.** Confirm `AgentTask.spec.id` as the canonical `slotId` from `TaskController`, and the `grove-<role>-<n>` form from `SessionOrchestrator`. A role working N independent tasks ⇒ N slots/processes — confirm that's intended.
- **OQ2 — orchestrator adoption scope.** Is P5 (making `SessionOrchestrator`/`TaskController` actually spawn through the supervisor) part of #273, or a follow-up once P1–P4 land behind the runtime seam?
- **OQ3 — `seq` placement.** Stamp `seq` in the payload of every `acp.message`/`acp.result`, or only at turn boundaries? (Plan assumes per-event.) Confirm consumers want per-event seq now vs. forward-compat only.
- **OQ4 — registry persistence / orphan reaping** across grove restarts: in scope later, or rely on lease expiry + manual reap? (Plan defers.)
- **OQ5 — feature flag.** Gate adoption behind a `GROVE_SUPERVISOR=1`-style flag for one release (mirroring the `GROVE_RUNTIME` cutover), defaulting off until the E2E is green?
