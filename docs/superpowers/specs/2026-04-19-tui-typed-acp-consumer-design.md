# Design: TUI Typed ACP Message Consumer

**Date:** 2026-04-19
**Issue:** [#314](https://github.com/windoliver/grove/issues/314) — `feat(tui): consume typed acp.message/acp.result events from Nexus EventBus`
**Parent:** #202 (sub-spec 1 of 3). Depends on #261.

## Problem

Sub-spec 1 delivered the producer side: `AgentRuntime.send` returns an `AcpxTurn`, `publishTurnToNexus` drains every turn and emits typed `acp.message` + terminal `acp.result` through `NexusEventBus`. Verified end-to-end against a real Nexus inbox (#261).

The TUI does not yet subscribe. Session rendering polls per-agent log files via `AgentLogBuffer.pollLogFile` — bypasses the typed stream. `NexusWsBridge` recognises `message_delivered` SSE events but routes them to the IPC-notification path, not a typed consumer.

## Goals

- TUI becomes a first-class consumer of the typed stream. A new `SessionPanel` renders exactly what the agent emits.
- Subscription works for both same-process (local `NexusEventBus` handler) and cross-process (Nexus SSE) event delivery.
- `turnId`-correlated dedupe drops late `acp.message` events that arrive after a turn's `acp.result`.
- Terminal `stopReason` — including future synthetic codes like `publish_failed` surfaced as `{stopReason:"error", error:{code:"publish_failed"}}` — is treated authoritatively.

## Non-goals

- DAG / xray view (tracked in #311).
- OpenTUI component migration (#212).
- Permission-approval interactive UX.
- Structured persistence of per-turn state — lives in memory; publisher side owns Nexus persistence.
- Removing log-file polling entirely. Log polling stays for tmux/subprocess runtimes that don't emit typed events; `AgentLogBuffer` also receives a projection of typed messages so `TracePane` keeps working for acpx sessions without parallel ingestion.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Subscription transport | Unified sink: both in-process `NexusEventBus` handler and SSE path via `NexusWsBridge` route into the same `AcpMessageSink`. |
| Rendering surface | `SessionStore` is the source of truth. New `SessionPanel` renders the Message union natively. A `session-log-projector` adapts typed messages into the existing `AgentLogBuffer` so `TracePane` keeps working without a parallel ingestion pipeline. |
| Turn-lifecycle dedupe | Close-on-Result: any `acp.message` with a `turnId` whose `TurnRecord.closedAt` is already set is dropped. `stopReason` is preserved on the closed turn so rendering can style `cancelled`/`error`/`publish_failed` distinctly. |
| Render scope | New `SessionPanel` native to the Message union. `TracePane` continues via the projector. No third mode. |
| Session registration | Explicit `sessionStore.register(sessionId)` / `unregister(sessionId)` called from the spawn lifecycle. Events for unregistered sessionIds drop at ingest. Mirrors `NexusWsBridge.registerSession(role, session)`. |

## Architecture

```
Producer (shipped — #261)
  AcpxRuntime → AcpxTurn → publishTurnToNexus → NexusEventBus.publish
                                                      │
                                                      ├─► local handlers (same-process TUI)
                                                      └─► NexusIpcClient.send → Nexus inbox
                                                                                    │
                                                                                    SSE notify
                                                                                    │
Consumer (this issue — #314)                                                        ▼
  AcpMessageSink  ◄──── NexusEventBus.subscribe(role, h)                  NexusWsBridge
                  ◄──── NexusWsBridge.onAcpEvent(ev)                      (extended)
         │
         ▼
  SessionStore
    register(sessionId) / unregister(sessionId)
    ingest(event)   ─ close-on-Result, preserves stopReason
    subscribe(sessionId, listener)
         │
         ├─► SessionPanel (new view — renders Message union natively)
         └─► session-log-projector → AgentLogBuffer  (TracePane keeps working)
```

### Created

- `src/tui/data/session-store.ts` — `SessionStore` + `TurnRecord` + `SessionRecord`.
- `src/tui/data/acp-message-sink.ts` — `AcpMessageSink` that routes `GroveEvent`s into the store.
- `src/tui/data/session-log-projector.ts` — adapter from `Message` to `AgentLogBuffer.push`.
- `src/tui/views/session-panel.tsx` — native Message-union renderer.
- Tests: `session-store.test.ts`, `acp-message-sink.test.ts`, `session-log-projector.test.ts`, `session-panel.test.tsx`.

### Modified

- `src/tui/nexus-ws-bridge.ts` — accept `onAcpEvent` option; detect inner payloads with `type: "acp.message"` / `"acp.result"` and forward to the sink instead of the `runtime.send` IPC-notification path.
- `src/tui/spawn-manager.ts` — call `sessionStore.register(session.id)` after a session spawns, `unregister` on close.
- `src/tui/app.tsx` — construct `SessionStore` + `AcpMessageSink`, subscribe the sink to `NexusEventBus` for each topology role, pass `onAcpEvent` to `NexusWsBridge`.

## Types

```typescript
// src/tui/data/session-store.ts
import type { Message, Result } from "../../acp/types.js";

export interface TurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly messages: Message[];        // append-only while the turn is open
  readonly startedAt: number;
  closedAt?: number;
  stopReason?: Result["stopReason"];
  error?: Result["error"];
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly registeredAt: number;
  readonly turns: Map<string, TurnRecord>;
  latestTurnId?: string;
}

export type SessionListener = (sessionId: string) => void;

export class SessionStore {
  register(sessionId: string): void;
  unregister(sessionId: string): void;
  ingest(event: AcpSinkEvent): void;
  getSession(sessionId: string): SessionRecord | undefined;
  getTurn(sessionId: string, turnId: string): TurnRecord | undefined;
  subscribe(sessionId: string, listener: SessionListener): () => void;
  // Batched flush (~16ms) matches AgentLogBuffer cadence.
}
```

```typescript
// src/tui/data/acp-message-sink.ts
import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";

export type AcpSinkEvent =
  | { kind: "message"; sessionId: string; turnId: string; message: Message }
  | { kind: "result";  sessionId: string; turnId: string; result:  Result  };

export interface AcpMessageSink {
  handleGroveEvent(event: GroveEvent): void;
}

export function createAcpMessageSink(store: SessionStore): AcpMessageSink;
```

## Data flow

### Live path during a turn

```
Agent emits message/result
  → publisher.publishTurnToNexus() → NexusEventBus.publish(groveEvent)
        │
        ├─► local handler path: acpSink.handleGroveEvent(groveEvent)
        │     → validate payload (sessionId, turnId)
        │     → store.ingest({ kind, sessionId, turnId, message|result })
        │
        └─► Nexus inbox → SSE notify → NexusWsBridge.handleEvent()
              → readAndPush reads VFS payload
              → if inner payload.type ∈ {"acp.message","acp.result"} →
                 opts.onAcpEvent(innerPayload) → acpSink.handleGroveEvent(innerPayload)
              → else → existing IPC-notification path (runtime.send)
```

### Ingest rules (`SessionStore.ingest`)

1. `sessionId` not registered → drop silently (debug log `acp_event_unregistered`).
2. event is `result` → locate or create `TurnRecord`; set `closedAt = Date.now()`, `stopReason`, `error`. Notify subscribers.
3. event is `message` → locate or create `TurnRecord`:
   - If `TurnRecord.closedAt` set → drop (debug log `acp_late_after_result`). This is the issue's late-message contract.
   - Otherwise append to `messages`; update `latestTurnId`; notify (batched).
4. Notifications batch at `~16ms` to match `AgentLogBuffer`; avoids React re-render storms during chunky text streams.

### Cancel path

User keypress → existing spawn-manager cancel → `turn.cancel()` → acpx emits `session/cancel` ACK → publisher emits `acp.result{stopReason:"cancelled"}` → sink closes the turn via rule (2). No separate TUI cancel wiring inside `SessionStore`.

## Same-process duplication

In same-process mode, `NexusEventBus.publish` fires local handlers *and* sends through `NexusIpcClient`. The Nexus inbox then SSE-notifies the TUI's `NexusWsBridge`, which would deliver the same event a second time — once via the local handler, once via SSE.

Publisher today does not stamp a per-event sequence number, so the sink cannot dedupe by identity. Mitigation:

- Wiring constraint: if a role is local to this TUI, subscribe to `NexusEventBus` *or* forward via SSE — not both. The TUI already knows which roles it owns (topology). Local roles route via the in-process subscription; remote roles route via SSE. The bridge's `onAcpEvent` is gated on `!topology.isLocalRole(innerPayload.sourceRole)`.
- Document as a known caveat in the spec. A future follow-up may add publisher sequence numbers so the sink can dedupe defensively.

## Error handling

| Mode | Behavior |
|---|---|
| Malformed `GroveEvent` payload (no sessionId / turnId) | Drop. Debug log `acp_event_malformed`. |
| `sessionId` not registered | Drop silently. Expected when multiple agents share the bus. |
| Late message after Result | Drop. Debug log `acp_late_after_result`. Matches issue contract. |
| `stopReason === "error"` with any error code (including future `publish_failed`) | Render authoritatively. No retry. Surface as `✗ error` badge with code + message. |
| Duplicate delivery (same event via local and SSE) | Wiring constraint routes each event through exactly one path. Stray duplicates, if they occur, render twice — flagged as follow-up pending publisher sequence numbers. |
| SSE reconnect | Existing bridge loop reconnects; missed `acp.*` events during outage are lost. Acceptable for this issue — the typed stream is live render, not source of record. |
| Component unmount during active turn | `SessionPanel`'s `useEffect` cleanup unsubscribes; the turn keeps streaming into `SessionStore`. Re-mount picks up current `TurnRecord`. |
| `sessionStore.unregister` during active turn | Drop all turns for the sessionId. Subscribers receive one final notify with `undefined` session. Matches spawn-manager's session-close semantics. |

Principles:

- One bad event never kills rendering.
- No silent buffering outside `TurnRecord.messages`; drops are logged at debug level.
- `TurnRecord.messages` is append-only during the open window, immutable after close (aside from `stopReason`/`error` on the close transition).

## Rendering

### SessionPanel layout

```
╭─ session <short-sid> · turn <short-tid>  [● running | ✓ end_turn | ⊘ cancelled | ✗ error: publish_failed] ─╮
│ <assistant text, chunks concatenated inline>                                                               │
│ [tool] bash · completed                                                                                    │
│ [tool] Read src/auth.ts · in_progress                                                                      │
│ <thinking: dimmed>                                                                                         │
│ [raw: session/update:future_thing]                                                                         │
│ ⚑ permission requested: bash                                                                               │
│                                                                                                            │
│ usage · in=412 out=88                                                                                      │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- Status badge driven by `stopReason`. Uses existing theme (`theme.focus` for running, `theme.success`, `theme.warn`, `theme.error`).
- Scrollback: latest 200 messages default; j/k scroll; auto-scroll pinned when at bottom (same idiom as `TracePane`).
- Empty state: `(no messages yet)`.

### AgentLogBuffer projection

`session-log-projector.ts` subscribes to each registered sessionId and pushes one `LogLine` per Message into the role's `AgentLogBuffer`:

| Message kind | LogLine |
|---|---|
| `text` | `{ line: text, type: "output" }` |
| `thinking` | `{ line: `(thinking) ${text}`, type: "output" }` |
| `tool_call` | `{ line: `[tool] ${name} (${status})`, type: "tool" }` |
| `permission_request` | `{ line: `[perm] ${tool}`, type: "tool" }` |
| `token_usage` | skipped (rendered in panel footer only) |
| `raw` | `{ line: `[raw:${acpMethod}]`, type: "output" }` |
| Result | `{ line: `[${stopReason}]`, type: "turn" }` |

This keeps `TracePane` (k9s-style split pane) working without touching its render logic. For tmux/subprocess runtimes that emit no typed events, existing log-file polling remains the only source.

## Testing

### Unit (no I/O)

- `session-store.test.ts`
  - register/unregister lifecycle.
  - ingest of message and result events; multi-turn state.
  - close-on-Result drops late messages.
  - subscribe notifications fire; batched flush coalesces bursts.
  - unregister during active turn drops the session.
- `acp-message-sink.test.ts`
  - routes `acp.message` / `acp.result` GroveEvents to `store.ingest`.
  - drops malformed events (missing sessionId/turnId).
  - drops events for unregistered sessions.
- `session-log-projector.test.ts`
  - each Message kind produces the specified LogLine shape.
  - Result produces a turn-typed LogLine with stopReason.

### Component

- `session-panel.test.tsx`
  - renders text / thinking / tool_call / permission_request / raw / token_usage.
  - status badge reflects each stopReason including `error.code === "publish_failed"`.
  - updates on SessionStore notification.

### Integration (bridge wiring)

- Extend `nexus-ws-bridge.test.ts` to assert:
  - `acp.message` / `acp.result` inner payloads route through `onAcpEvent`.
  - They skip the `runtime.send` IPC-notification path.
  - `message_delivered` for non-acp payloads still reaches `runtime.send` (regression guard).

### E2E (Nexus-backed)

- Extend `tests/e2e/acp-stream-nexus.e2e.test.ts` (or sibling) to spawn a real agent with `acpx` available, drive one turn, and assert the TUI SessionPanel renders typed messages. Gated on `acpx` + running Nexus per existing E2E convention.
- Non-negotiable per `feedback_e2e_use_nexus`: verification runs against the live Nexus instance, not a local SQLite fallback.

## Migration

Single PR:

1. Add `src/tui/data/session-store.ts`, `acp-message-sink.ts`, `session-log-projector.ts` with unit tests.
2. Add `src/tui/views/session-panel.tsx` with component test.
3. Extend `NexusWsBridge` with `onAcpEvent`; update its tests.
4. Hook `spawn-manager` to call `sessionStore.register/unregister`.
5. Wire `app.tsx` — construct store + sink, subscribe to `NexusEventBus` per topology role, pass `onAcpEvent` to the bridge, mount `SessionPanel` in the running view's session tab.
6. Extend the Nexus E2E scenario to cover TUI rendering.

No breaking change for non-acp runtimes — `TracePane` continues via log polling when no typed events arrive.

## Open questions for implementation plan

- `topology.isLocalRole(role)` helper — does it exist today? If not, add it (small) and use it to gate `onAcpEvent` routing.
- Does `app.tsx` already own the `NexusEventBus` instance that spawned agents use? If not, plumbing step (share the instance) lands here.
- Exact mount point for `SessionPanel` inside `running-view.tsx` — as a new tab, an overlay, or replacing a placeholder. Determine during plan drafting.

## References

- Issue #314 — this issue.
- Publisher: `src/nexus/nexus-agent-publisher.ts`.
- Event bus: `src/nexus/nexus-event-bus.ts`, `src/core/event-bus.ts`.
- SSE bridge: `src/tui/nexus-ws-bridge.ts`.
- Parent spec: `docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md`.
- Parent plan: `docs/superpowers/plans/2026-04-16-acp-typed-message-streams.md`.
- `feedback_e2e_use_nexus` memory — E2E must hit real Nexus.
- `feedback_no_polling_ipc` memory — SSE push only, no polling.
- `feedback_no_workarounds` memory — no "done" claim without full E2E.
