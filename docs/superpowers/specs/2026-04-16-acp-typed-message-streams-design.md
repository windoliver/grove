# Design: ACP Typed Message Streams

**Date:** 2026-04-16
**Source:** Issue [#202](https://github.com/windoliver/grove/issues/202) — adopt unified backend interface, native skill injection, and repo cache.
**Scope:** This spec covers **only the first of three sub-specs** from #202: structured ACP message streams through the agent runtime and Nexus IPC. Native skill injection (#202 pattern 2) and bare-clone repo cache (#202 pattern 3) are deferred to follow-on specs.

## Problem

Grove's `AgentRuntime` / `AcpxRuntime` today exposes an `onOutput(chunk)` callback that delivers raw acpx stdout as text. Downstream consumers (TUI, Nexus IPC bus, log writers) must re-parse pretty-rendered output to recover tool calls, thinking blocks, or turn boundaries. This is lossy, provider-sensitive, and blocks structured features (TUI DAG view, tool-call timelines, queryable replay) called out in `project_tui_ux_gaps`.

acpx already supports `--format json --json-strict`, emitting raw ACP JSON-RPC NDJSON. We should consume that directly and expose typed messages end-to-end.

## Goals

- Replace `onOutput` raw-chunk plumbing with typed `Message` / `Result` streams.
- Consume acpx NDJSON centrally; never reparse downstream.
- Persist typed records in Nexus store with enough fidelity for replay.
- Keep unknown ACP updates forward-compatible via a `raw` escape hatch.

## Non-goals

- Backend abstraction for non-acpx providers (#202 pattern 1 full scope).
- Skill injection (#202 pattern 2).
- Repo / worktree cache (#202 pattern 3).
- TUI view changes beyond consuming the new stream shape — new DAG/tool-call UI is its own issue.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Message variants | Full set (text, thinking, tool_call, permission_request, token_usage, raw) + provider escape hatch. |
| Parser location | Single parser module in `src/acp/parser.ts` (pure, no I/O). `AcpxRuntime` owns one parser instance per session and wires it to acpx stdout. |
| Backward compat | `onOutput` removed. All consumers migrated in one PR. |
| Nexus IPC shape | Typed `Message` records published end-to-end. Breaking change for IPC readers; Grove owns both ends. |
| Persistence | Full fidelity during live session; compact chunks + tool-call events into final snapshot on `stopReason`. |
| Tool-call lifecycle | Hybrid: append event log during turn, fold into single `ToolCall` record on turn end. |
| Architectural shape | Approach 2: per-turn stream. `AgentRuntime.send()` returns an `AcpxTurn` (one per prompt) that owns `messages` + `result`. `AgentSession` stays as session metadata. Parser lives in `src/acp/`. |

## Architecture

```
Caller (TUI, CLI, tests)
  └─► runtime.spawn(role, config) → AgentSession          (metadata — unchanged shape)
  └─► runtime.send(session, prompt) → AcpxTurn            (per-turn stream)
        ├─ messages: AsyncIterable<Message>
        ├─ result:   Promise<Result>
        ├─ cancel(), close()
        │
  src/core/agent-runtime.ts   — interface: send → AcpxTurn
  src/core/acpx-runtime.ts    — launches acpx with --format json --json-strict per turn
  src/acp/                    — types, parser, turn, compact
  src/nexus/nexus-event-bus.ts — publishes typed Messages via IPC
  Nexus store                 — indexed by sessionId/turnId/toolCallId
```

Boundaries:
- `src/acp/` is pure — no process spawn, no IPC. Takes a readable NDJSON stream, emits typed events. Unit-testable in isolation.
- `AcpxRuntime` knows how to spawn acpx and wire its stdout into an `AcpxTurn`.
- Nexus IPC bus is a consumer of `session.messages`, not a co-owner of parsing.

## Types (`src/acp/types.ts`)

```typescript
export type Message =
  | { kind: "text"; turnId: string; text: string; chunk: boolean }
  | { kind: "thinking"; turnId: string; text: string; chunk: boolean }
  | { kind: "tool_call"; turnId: string; toolCall: ToolCall }
  | { kind: "permission_request"; turnId: string; request: PermissionRequest }
  | { kind: "token_usage"; turnId: string; usage: TokenUsage }
  | { kind: "raw"; turnId: string; acpMethod: string; params: unknown };

export type ToolCall = {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  input: unknown;
  output?: unknown;
  diff?: string;
  error?: string;
};

export type Result = {
  turnId: string;
  stopReason: "end_turn" | "max_tokens" | "cancelled" | "error";
  error?: { code: string; message: string };
};

export type PermissionRequest = {
  id: string;
  tool: string;
  input: unknown;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
};

export type AcpxTurn = {
  sessionId: string;
  turnId: string;
  messages: AsyncIterable<Message>;
  result: Promise<Result>;
  cancel(): Promise<void>;
  close(): Promise<void>;
};
```

Notes:
- `chunk: true` marks incremental text/thinking; compactor folds by `turnId` on `stopReason`.
- `raw` catches ACP update kinds the parser doesn't model yet.
- `AsyncIterable` backpressures naturally.
- `turnId` is synthesized by the session from the ACP JSON-RPC request id that initiated the turn (`session/prompt`). Every update tied to that request shares one `turnId`; the final `result` closes it.

## Data flow

Live path (during turn):

```
acpx stdout (NDJSON)
  → src/acp/parser.ts  (splits on \n, JSON.parse, maps session/update)
  → AcpxTurn.messages
      ├─► TUI (live render)
      └─► NexusEventBus → Nexus store
              turns[turnId]         assistant text accumulates
              toolCalls[toolCallId] status + output updated
              events[]              append-only live log
```

End of turn:

```
acpx emits result with stopReason
  → parser emits Result, closes messages iterator
  → AcpxTurn.result resolves
  → src/acp/compact.ts folds:
      - text/thinking chunks by turnId → single assistant message
      - tool-call events → final ToolCall record
      - events[] pruned per retention policy
  → Nexus store commits compacted snapshot
```

Cancel path:

```
caller.cancel() → AcpxRuntime writes ACP session/cancel to acpx stdin
                → acpx emits result with stopReason:"cancelled"
                → same compaction path
```

Invariants:
- Parser is pure & synchronous per line. No I/O after construction.
- Compaction is idempotent.
- `messages` iterator closes exactly once, after `Result` is emitted.

## Error handling

| Mode | Behavior |
|---|---|
| Malformed NDJSON line | Log with sessionId + raw line, emit `Message{kind:"raw", acpMethod:"_parseError"}`, continue. Never throws. |
| Unknown `session/update` variant | Emit `Message{kind:"raw"}`. Forward-compat. |
| acpx process crash mid-turn | Runtime detects EOF without result. `session.result` resolves to `{stopReason:"error", error:{code:"acpx_exit", message: stderr tail}}`. Iterator closes. |
| Provider-level ACP error | Map JSON-RPC error → `Result{stopReason:"error", error:{code, message}}`. Compaction runs normally. |
| IPC publish failure | No silent retry. `messages` still yields. Session exposes `ipcHealthy:false`. Caller decides. |
| Nexus store write failure | Store retries per existing policy; if it gives up, event dropped from store but iterator continues. |
| Compaction failure | Log, keep raw event log, surface `compactionFailed` on turn record. TUI falls back to rendering from events. |
| Slow consumer / backpressure | `AsyncIterable` backpressures. Catastrophic stall: log, drop non-primary consumer (IPC), keep main iterator alive. |
| Cancel races with completion | `cancel()` idempotent. If `result` already resolved, no-op. Otherwise send ACP `session/cancel`; first stopReason to arrive wins. |

Principles:
- One bad line never kills a session.
- No silent buffering — failures surface on the session object or in logs.
- Compaction is best-effort. Live event log is ground truth during active session.

## Testing

**Unit** (no I/O):
- `src/acp/parser.test.ts` — golden NDJSON fixtures → expected Message sequence. Every variant, malformed lines, unknown kinds.
- `src/acp/compact.test.ts` — event log → snapshot. Idempotency (run twice, identical output).
- `src/acp/types.test.ts` — runtime validators if present.

**Component** (isolated, no acpx):
- `src/core/acpx-session.test.ts` — synthetic `Readable` of NDJSON into `AcpxTurn`. Verify iterator + result. Cover cancel, EOF-without-result, crash mid-turn.

**Integration** (real acpx):
- `src/core/acpx-runtime.integration.test.ts` — spawn `acpx codex exec "..."` or dry-run fixture agent. Verify end-to-end typed stream. Gated on acpx presence.

**E2E** (Nexus-backed):
- TUI E2E migrates — structured messages verified via Nexus API, not local SQLite.
- New scenario: tool-call live-update rendering during spawned agent turn.

**Fixtures:**
- `tests/fixtures/acp/` — captured `acpx --format json` output per provider (claude, codex, gemini). Regenerate only on ACP spec change.

**Non-negotiables:**
- No mocked Nexus in E2E.
- No "done" claim until full E2E passes with live agent.

## Migration

Because `onOutput` is removed (not deprecated), the rollout is a single PR that:

1. Adds `src/acp/` (types, parser, turn, compact) + unit tests.
2. Extends `AgentRuntime` interface: `send` returns `AcpxTurn`; drops `onOutput`. `spawn` keeps current `AgentSession` metadata return. Mirror change in `TmuxRuntime`, `SubprocessRuntime`, `MockRuntime` (mock emits canned Messages).
3. Updates `AcpxRuntime.sendAsync` to spawn acpx with `--format json --json-strict` and construct an `AcpxTurn` from the child stdout.
4. Migrates `onOutput` callers. Audit in this worktree: only `AcpxRuntime` itself currently consumes `onOutput` (log writer). No TUI/Nexus subscribers exist today — structured publish to Nexus IPC is net-new plumbing.
5. Adds Nexus store schema + publish path for typed Messages via `NexusEventBus`.
6. Lands captured fixtures, integration + E2E suites.

## Open questions for implementation plan

- Exact Nexus store schema diff (new tables vs. JSON blob on turn rows).
- Retention policy for `events[]` after compaction.
- Whether `MockRuntime` needs to simulate chunk timing for TUI tests.
- acpx version floor (need a version that stabilized `--json-strict`).

## References

- Issue #202 — unified backend, skills, repo cache proposal.
- acpx README + CLI docs — `--format json --json-strict` NDJSON output.
- `project_tui_ux_gaps` memory — TUI DAG view + tool-call timeline unblocked by this work.
- `feedback_e2e_use_nexus` memory — E2E hits real Nexus, no SQLite shortcut.
- `feedback_no_workarounds` memory — no claim of done without E2E.
