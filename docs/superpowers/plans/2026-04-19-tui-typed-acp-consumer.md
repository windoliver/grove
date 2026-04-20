# TUI Typed ACP Consumer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TUI subscribes to `acp.message` / `acp.result` events produced by the already-shipped publisher (#261), maintains a per-session turn store with close-on-Result dedupe, and renders the typed `Message` union in a new `SessionPanel`. Existing `TracePane` keeps working via a projection adapter into `AgentLogBuffer`.

**Architecture:** A unified `AcpMessageSink` accepts `GroveEvent`s from two transports: in-process handlers registered on `NexusEventBus` for roles the TUI owns, and SSE-delivered inner payloads forwarded by an extended `NexusWsBridge`. The sink routes events into `AcpSessionStore`, which keys turns by `(sessionId, turnId)` and drops messages arriving after a turn's Result. Local-vs-remote routing is gated by the bridge checking the topology's role set so the same event is not ingested twice.

**Tech Stack:** TypeScript, Bun 1.3, `bun test`, Biome, React 19 (for the panel). ACP types and `AcpxTurn` from `src/acp/`. EventBus / Nexus IPC from `src/core/event-bus.ts` / `src/nexus/`.

**Spec:** `docs/superpowers/specs/2026-04-19-tui-typed-acp-consumer-design.md`

---

## File structure

Created:
- `src/tui/data/acp-session-store.ts` — `AcpSessionStore`, `TurnRecord`, `SessionRecord`, `AcpSinkEvent`.
- `src/tui/data/acp-session-store.test.ts`.
- `src/tui/data/acp-message-sink.ts` — `AcpMessageSink` (routes `GroveEvent`s into the store).
- `src/tui/data/acp-message-sink.test.ts`.
- `src/tui/data/session-log-projector.ts` — subscribes to the store, pushes formatted `LogLine`s into per-role `AgentLogBuffer`.
- `src/tui/data/session-log-projector.test.ts`.
- `src/tui/views/session-panel.tsx` — native Message-union renderer.
- `src/tui/views/session-panel.test.ts` — tests the render-data derivation function; no DOM render (matches existing TUI testing style).

Modified:
- `src/tui/nexus-ws-bridge.ts` — add `onAcpEvent` option and the pre-dispatch branch that routes `acp.message` / `acp.result` inner payloads to the callback and skips `runtime.send`.
- `src/tui/nexus-ws-bridge.test.ts` — add coverage for the new branch.
- `src/tui/spawn-manager.ts` — call `acpSessionStore.register/unregister` on spawn/kill. Plumb the store handle through options.
- `src/tui/main.ts` — construct `AcpSessionStore`, `AcpMessageSink`, wire the sink into `NexusEventBus` (one handler per topology role) and the bridge's `onAcpEvent`.

Out of scope:
- Mount point for `SessionPanel` inside `running-view.tsx` is left to a follow-up UI-polish issue — this plan produces the panel component + data wiring but does not decide the tab layout change.

---

## Task 1: Define AcpSinkEvent + TurnRecord + SessionRecord types

**Files:**
- Create: `src/tui/data/acp-session-store.ts` (types only in this task)
- Test: `src/tui/data/acp-session-store.test.ts` (types assertions)

- [ ] **Step 1: Write failing type test**

```typescript
// src/tui/data/acp-session-store.test.ts
import { expect, test } from "bun:test";
import type {
  AcpSinkEvent,
  SessionRecord,
  TurnRecord,
} from "./acp-session-store.js";
import type { Message, Result } from "../../acp/types.js";

test("TurnRecord holds ordered messages and optional close metadata", () => {
  const msg: Message = { kind: "text", turnId: "t1", text: "hi", chunk: true };
  const rec: TurnRecord = {
    turnId: "t1",
    sessionId: "s1",
    messages: [msg],
    startedAt: 1,
  };
  expect(rec.turnId).toBe("t1");
  expect(rec.closedAt).toBeUndefined();
});

test("SessionRecord groups turns by turnId", () => {
  const sess: SessionRecord = {
    sessionId: "s1",
    registeredAt: 1,
    turns: new Map(),
  };
  expect(sess.turns.size).toBe(0);
});

test("AcpSinkEvent discriminates by kind", () => {
  const msgEv: AcpSinkEvent = {
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  };
  const resultEv: AcpSinkEvent = {
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" } satisfies Result,
  };
  expect(msgEv.kind).toBe("message");
  expect(resultEv.kind).toBe("result");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tui/data/acp-session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module (types only)**

```typescript
// src/tui/data/acp-session-store.ts
/**
 * AcpSessionStore — in-memory per-session turn log keyed by turnId.
 *
 * See docs/superpowers/specs/2026-04-19-tui-typed-acp-consumer-design.md.
 */

import type { Message, Result } from "../../acp/types.js";

export interface TurnRecord {
  readonly turnId: string;
  readonly sessionId: string;
  readonly messages: Message[];
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

export type AcpSinkEvent =
  | { kind: "message"; sessionId: string; turnId: string; message: Message }
  | { kind: "result"; sessionId: string; turnId: string; result: Result };
```

- [ ] **Step 4: Run to verify type-level tests pass**

Run: `bun test src/tui/data/acp-session-store.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/acp-session-store.ts src/tui/data/acp-session-store.test.ts
git commit -m "feat(tui): AcpSessionStore types"
```

---

## Task 2: Implement AcpSessionStore (register, ingest, subscribe)

**Files:**
- Modify: `src/tui/data/acp-session-store.ts`
- Modify: `src/tui/data/acp-session-store.test.ts`

- [ ] **Step 1: Add failing behavioral tests**

Append to `src/tui/data/acp-session-store.test.ts`:

```typescript
import { AcpSessionStore } from "./acp-session-store.js";

test("ingest drops events whose sessionId is not registered", () => {
  const store = new AcpSessionStore();
  store.ingest({
    kind: "message",
    sessionId: "s-unreg",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  expect(store.getSession("s-unreg")).toBeUndefined();
});

test("ingest appends messages for a registered session", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  const turn = store.getTurn("s1", "t1");
  expect(turn).toBeDefined();
  expect(turn?.messages).toHaveLength(1);
  expect(store.getSession("s1")?.latestTurnId).toBe("t1");
});

test("ingest closes a turn on result and records stopReason", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "cancelled" },
  });
  const turn = store.getTurn("s1", "t1");
  expect(turn?.closedAt).toBeDefined();
  expect(turn?.stopReason).toBe("cancelled");
});

test("ingest drops messages arriving after the turn's Result", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "late", chunk: true },
  });
  expect(store.getTurn("s1", "t1")?.messages).toHaveLength(0);
});

test("unregister drops the session and its turns", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  store.unregister("s1");
  expect(store.getSession("s1")).toBeUndefined();
});

test("subscribe notifies listeners when a turn gains a message", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  store.subscribe("s1", () => {
    notified += 1;
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  // Batched flush is 16ms; wait for it to fire.
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBeGreaterThanOrEqual(1);
});

test("subscribe batches multiple ingests into a single notification", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  store.subscribe("s1", () => {
    notified += 1;
  });
  for (let i = 0; i < 5; i++) {
    store.ingest({
      kind: "message",
      sessionId: "s1",
      turnId: "t1",
      message: { kind: "text", turnId: "t1", text: String(i), chunk: true },
    });
  }
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBe(1);
});

test("subscribe returns an unsubscribe function", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  let notified = 0;
  const unsub = store.subscribe("s1", () => {
    notified += 1;
  });
  unsub();
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(notified).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tui/data/acp-session-store.test.ts`
Expected: FAIL — `AcpSessionStore` class not exported.

- [ ] **Step 3: Implement `AcpSessionStore`**

Append to `src/tui/data/acp-session-store.ts`:

```typescript
export type SessionListener = (sessionId: string) => void;

const FLUSH_INTERVAL_MS = 16;

export class AcpSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  register(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      registeredAt: Date.now(),
      turns: new Map(),
    });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
    this.dirty.delete(sessionId);
  }

  ingest(event: AcpSinkEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;

    let turn = session.turns.get(event.turnId);
    if (!turn) {
      turn = {
        turnId: event.turnId,
        sessionId: event.sessionId,
        messages: [],
        startedAt: Date.now(),
      };
      session.turns.set(event.turnId, turn);
    }

    if (event.kind === "result") {
      if (turn.closedAt === undefined) {
        turn.closedAt = Date.now();
        turn.stopReason = event.result.stopReason;
        if (event.result.error) turn.error = event.result.error;
      }
    } else {
      if (turn.closedAt !== undefined) return; // late after Result — drop
      turn.messages.push(event.message);
      session.latestTurnId = turn.turnId;
    }

    this.dirty.add(event.sessionId);
    this.scheduleFlush();
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getTurn(sessionId: string, turnId: string): TurnRecord | undefined {
    return this.sessions.get(sessionId)?.turns.get(turnId);
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(sessionId);
    };
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const toNotify = [...this.dirty];
      this.dirty.clear();
      for (const sessionId of toNotify) {
        const set = this.listeners.get(sessionId);
        if (!set) continue;
        for (const listener of set) {
          try {
            listener(sessionId);
          } catch {
            // listener errors never kill the store
          }
        }
      }
    }, FLUSH_INTERVAL_MS);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/tui/data/acp-session-store.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/acp-session-store.ts src/tui/data/acp-session-store.test.ts
git commit -m "feat(tui): AcpSessionStore with close-on-Result dedupe"
```

---

## Task 3: Implement AcpMessageSink (GroveEvent → AcpSinkEvent)

**Files:**
- Create: `src/tui/data/acp-message-sink.ts`
- Test: `src/tui/data/acp-message-sink.test.ts`

- [ ] **Step 1: Write failing sink tests**

```typescript
// src/tui/data/acp-message-sink.test.ts
import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";
import { AcpSessionStore } from "./acp-session-store.js";
import { createAcpMessageSink } from "./acp-message-sink.js";

function messageEvent(sessionId: string, turnId: string, message: Message): GroveEvent {
  return {
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId, turnId, message },
    timestamp: new Date().toISOString(),
  };
}

function resultEvent(sessionId: string, turnId: string, result: Result): GroveEvent {
  return {
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId, turnId, result },
    timestamp: new Date().toISOString(),
  };
}

test("routes acp.message to store.ingest as a message event", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent(
    messageEvent("s1", "t1", { kind: "text", turnId: "t1", text: "hi", chunk: true }),
  );
  expect(store.getTurn("s1", "t1")?.messages).toHaveLength(1);
});

test("routes acp.result to store.ingest as a result event", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent(resultEvent("s1", "t1", { turnId: "t1", stopReason: "end_turn" }));
  expect(store.getTurn("s1", "t1")?.stopReason).toBe("end_turn");
});

test("ignores non-acp event types", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "contribution",
    sourceRole: "coder",
    targetRole: "reviewer",
    payload: { message_id: "x" },
    timestamp: new Date().toISOString(),
  });
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops malformed acp.message payloads (missing sessionId)", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.message",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { turnId: "t1", message: { kind: "text", turnId: "t1", text: "x", chunk: true } },
    timestamp: new Date().toISOString(),
  });
  expect(store.getSession("s1")?.turns.size).toBe(0);
});

test("drops malformed acp.result payloads (missing result field)", () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const sink = createAcpMessageSink(store);
  sink.handleGroveEvent({
    type: "acp.result",
    sourceRole: "coder",
    targetRole: "tui",
    payload: { sessionId: "s1", turnId: "t1" },
    timestamp: new Date().toISOString(),
  });
  expect(store.getTurn("s1", "t1")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tui/data/acp-message-sink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sink**

```typescript
// src/tui/data/acp-message-sink.ts
/**
 * AcpMessageSink — translates GroveEvents whose type is "acp.message" or
 * "acp.result" into AcpSinkEvents and feeds them to an AcpSessionStore.
 *
 * Non-acp events and malformed payloads are silently ignored. This is the
 * only bridge point between the bus-shaped event world and the typed store.
 */

import type { Message, Result } from "../../acp/types.js";
import type { GroveEvent } from "../../core/event-bus.js";
import type { AcpSessionStore } from "./acp-session-store.js";

export interface AcpMessageSink {
  handleGroveEvent(event: GroveEvent): void;
}

export function createAcpMessageSink(store: AcpSessionStore): AcpMessageSink {
  return {
    handleGroveEvent(event: GroveEvent): void {
      if (event.type === "acp.message") {
        const p = event.payload as {
          sessionId?: unknown;
          turnId?: unknown;
          message?: unknown;
        };
        if (
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isMessage(p.message)
        ) {
          return;
        }
        store.ingest({
          kind: "message",
          sessionId: p.sessionId,
          turnId: p.turnId,
          message: p.message,
        });
        return;
      }

      if (event.type === "acp.result") {
        const p = event.payload as {
          sessionId?: unknown;
          turnId?: unknown;
          result?: unknown;
        };
        if (
          typeof p.sessionId !== "string" ||
          typeof p.turnId !== "string" ||
          !isResult(p.result)
        ) {
          return;
        }
        store.ingest({
          kind: "result",
          sessionId: p.sessionId,
          turnId: p.turnId,
          result: p.result,
        });
      }
    },
  };
}

function isMessage(v: unknown): v is Message {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    typeof (v as { turnId?: unknown }).turnId === "string"
  );
}

function isResult(v: unknown): v is Result {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { turnId?: unknown }).turnId === "string" &&
    typeof (v as { stopReason?: unknown }).stopReason === "string"
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/tui/data/acp-message-sink.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/data/acp-message-sink.ts src/tui/data/acp-message-sink.test.ts
git commit -m "feat(tui): AcpMessageSink routes GroveEvents into the store"
```

---

## Task 4: Implement SessionLogProjector (Message → AgentLogBuffer LogLine)

**Files:**
- Create: `src/tui/data/session-log-projector.ts`
- Test: `src/tui/data/session-log-projector.test.ts`

- [ ] **Step 1: Write failing projector tests**

```typescript
// src/tui/data/session-log-projector.test.ts
import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.js";
import { messageToLogLine, resultToLogLine } from "./session-log-projector.js";

test("text message projects to an output LogLine", () => {
  const m: Message = { kind: "text", turnId: "t1", text: "hello", chunk: true };
  const ll = messageToLogLine(m);
  expect(ll).toEqual({ ts: expect.any(Number), line: "hello", type: "output" });
});

test("thinking message projects with a (thinking) prefix", () => {
  const m: Message = { kind: "thinking", turnId: "t1", text: "hmm", chunk: true };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("(thinking) hmm");
  expect(ll?.type).toBe("output");
});

test("tool_call projects to a tool-type LogLine with status", () => {
  const m: Message = {
    kind: "tool_call",
    turnId: "t1",
    toolCall: { id: "tc1", name: "bash", status: "completed", input: {} },
  };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[tool] bash (completed)");
  expect(ll?.type).toBe("tool");
});

test("permission_request projects to a [perm] line", () => {
  const m: Message = {
    kind: "permission_request",
    turnId: "t1",
    request: { id: "p1", tool: "bash", input: {} },
  };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[perm] bash");
});

test("token_usage is skipped in the projection", () => {
  const m: Message = {
    kind: "token_usage",
    turnId: "t1",
    usage: { inputTokens: 1, outputTokens: 2 },
  };
  expect(messageToLogLine(m)).toBeUndefined();
});

test("raw messages project with [raw:<acpMethod>]", () => {
  const m: Message = { kind: "raw", turnId: "t1", acpMethod: "session/update:x", params: {} };
  const ll = messageToLogLine(m);
  expect(ll?.line).toBe("[raw:session/update:x]");
});

test("result projects to a turn-type LogLine with stopReason", () => {
  const r: Result = { turnId: "t1", stopReason: "cancelled" };
  const ll = resultToLogLine(r);
  expect(ll.line).toBe("[cancelled]");
  expect(ll.type).toBe("turn");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tui/data/session-log-projector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the projector**

```typescript
// src/tui/data/session-log-projector.ts
/**
 * SessionLogProjector — turns typed Messages into LogLine entries that
 * feed the existing AgentLogBuffer so TracePane keeps working without a
 * parallel ingestion pipeline for acpx-spawned sessions.
 *
 * Exported as pure functions (plus a glue helper) to keep the store and
 * the buffer decoupled and make every projection unit-testable.
 */

import type { Message, Result } from "../../acp/types.js";
import type { AgentLogBuffer, LogLine } from "./agent-log-buffer.js";
import type { AcpSessionStore } from "./acp-session-store.js";

export function messageToLogLine(message: Message): LogLine | undefined {
  switch (message.kind) {
    case "text":
      return { ts: Date.now(), line: message.text, type: "output" };
    case "thinking":
      return { ts: Date.now(), line: `(thinking) ${message.text}`, type: "output" };
    case "tool_call":
      return {
        ts: Date.now(),
        line: `[tool] ${message.toolCall.name} (${message.toolCall.status})`,
        type: "tool",
      };
    case "permission_request":
      return { ts: Date.now(), line: `[perm] ${message.request.tool}`, type: "tool" };
    case "token_usage":
      return undefined;
    case "raw":
      return { ts: Date.now(), line: `[raw:${message.acpMethod}]`, type: "output" };
  }
}

export function resultToLogLine(result: Result): LogLine {
  return { ts: Date.now(), line: `[${result.stopReason}]`, type: "turn" };
}

/**
 * Bind a store session to a buffer: every new message in the latest turn
 * becomes a LogLine push, and the terminal Result becomes a [stopReason]
 * line. The returned unsubscribe drops the binding.
 *
 * The projector keeps a per-turn cursor so repeat notifications don't
 * double-project already-emitted messages.
 */
export function projectSessionToBuffer(
  store: AcpSessionStore,
  sessionId: string,
  buffer: AgentLogBuffer,
): () => void {
  const cursors = new Map<string, number>(); // turnId → next message index to emit
  const closed = new Set<string>(); // turnIds whose Result line has been emitted

  const drain = (): void => {
    const sess = store.getSession(sessionId);
    if (!sess) return;
    for (const turn of sess.turns.values()) {
      const next = cursors.get(turn.turnId) ?? 0;
      for (let i = next; i < turn.messages.length; i++) {
        const ll = messageToLogLine(turn.messages[i]!);
        if (ll) buffer.push(ll);
      }
      cursors.set(turn.turnId, turn.messages.length);
      if (turn.closedAt !== undefined && !closed.has(turn.turnId)) {
        closed.add(turn.turnId);
        buffer.push(
          resultToLogLine({
            turnId: turn.turnId,
            stopReason: turn.stopReason ?? "end_turn",
            ...(turn.error ? { error: turn.error } : {}),
          }),
        );
      }
    }
  };

  const unsubscribe = store.subscribe(sessionId, drain);
  drain(); // catch up on anything already in the store at bind time
  return unsubscribe;
}
```

- [ ] **Step 4: Add a failing integration test for `projectSessionToBuffer`**

Append to `src/tui/data/session-log-projector.test.ts`:

```typescript
import { AcpSessionStore } from "./acp-session-store.js";
import { AgentLogBuffer } from "./agent-log-buffer.js";
import { projectSessionToBuffer } from "./session-log-projector.js";

test("projectSessionToBuffer pushes messages as they arrive and emits a turn line on close", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const buffer = new AgentLogBuffer("coder", "s1");
  const unsub = projectSessionToBuffer(store, "s1", buffer);

  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
  });
  store.ingest({
    kind: "result",
    sessionId: "s1",
    turnId: "t1",
    result: { turnId: "t1", stopReason: "end_turn" },
  });
  await new Promise((r) => setTimeout(r, 25));

  const lines = buffer.toArray();
  expect(lines.map((l) => l.line)).toEqual(["hi", "[end_turn]"]);
  unsub();
});

test("projectSessionToBuffer does not double-emit on repeated notifications", async () => {
  const store = new AcpSessionStore();
  store.register("s1");
  const buffer = new AgentLogBuffer("coder", "s1");
  projectSessionToBuffer(store, "s1", buffer);

  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "a", chunk: true },
  });
  store.ingest({
    kind: "message",
    sessionId: "s1",
    turnId: "t1",
    message: { kind: "text", turnId: "t1", text: "b", chunk: true },
  });
  await new Promise((r) => setTimeout(r, 25));
  expect(buffer.toArray().map((l) => l.line)).toEqual(["a", "b"]);
});
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `bun test src/tui/data/session-log-projector.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tui/data/session-log-projector.ts src/tui/data/session-log-projector.test.ts
git commit -m "feat(tui): project AcpSessionStore turns into AgentLogBuffer"
```

---

## Task 5: Extend NexusWsBridge with `onAcpEvent` + local-role gate

**Files:**
- Modify: `src/tui/nexus-ws-bridge.ts`
- Modify: `src/tui/nexus-ws-bridge.test.ts`

- [ ] **Step 1: Add failing bridge test**

Open `src/tui/nexus-ws-bridge.test.ts`. Inside the existing `describe` block, add:

```typescript
test("forwards acp.message payloads to onAcpEvent when sourceRole is not a local topology role", async () => {
  const onAcpEvent = mock(() => undefined);
  const bridge = new NexusWsBridge(
    makeBridgeOpts({
      onAcpEvent,
      // topology roles default to coder + reviewer in makeBridgeOpts
    }),
  );

  // Drive handleEvent directly via its public surface through a crafted SSE payload.
  // The bridge reads the VFS path and decodes a { from, payload } envelope.
  // We exercise the branch by calling the private readAndPush indirectly through
  // a synthetic message_delivered event.
  // Simpler path: unit-test the branch by calling the exported helper added in
  // Step 3. For now assert the mock gets called below via the helper.

  // The helper is added in Step 3 — test is placeholder until then.
  expect(typeof bridge).toBe("object");
  expect(onAcpEvent).toBeDefined();
});
```

This is a scaffold; refine in Step 3 after the production change exposes a seam.

- [ ] **Step 2: Add `onAcpEvent` option + local-role set to `NexusWsBridgeOptions`**

Open `src/tui/nexus-ws-bridge.ts`. Extend the interface (append fields after `ipcClient?:`):

```typescript
/**
 * Forwards inner payloads whose `type` is "acp.message" or "acp.result"
 * to a typed consumer (AcpMessageSink). Called only when the event's
 * sourceRole is NOT one of this TUI's local topology roles — see the
 * spec's "Same-process duplication" section: local roles are handled by
 * an in-process NexusEventBus subscription, so SSE forwarding for the
 * same event would double-count.
 */
onAcpEvent?: ((event: GroveEvent) => void) | undefined;
```

- [ ] **Step 3: Add a testable helper — `handleIpcEnvelope`**

Still in `src/tui/nexus-ws-bridge.ts`, extract the existing IPC envelope handling so the acp branch is testable. Inside the class, add (public for tests):

```typescript
/**
 * Dispatch a parsed inbox payload. Returns `"acp"` when the envelope was
 * a typed acp.* event handled via onAcpEvent (and thus should NOT be
 * forwarded to runtime.send), `"ipc"` when the envelope is a regular IPC
 * notification the caller should continue delivering to the agent. Visible
 * for tests.
 */
handleIpcEnvelope(
  innerPayload: unknown,
): "acp" | "ipc" {
  if (!innerPayload || typeof innerPayload !== "object") return "ipc";
  const type = (innerPayload as { type?: unknown }).type;
  if (type !== "acp.message" && type !== "acp.result") return "ipc";

  const envelope = innerPayload as GroveEvent;
  const localRoles = new Set(this.opts.topology.roles.map((r) => r.name));
  if (localRoles.has(envelope.sourceRole)) {
    // Local role — the in-process NexusEventBus handler will ingest this
    // event. Skipping forward avoids double-counting.
    return "acp";
  }
  this.opts.onAcpEvent?.(envelope);
  return "acp";
}
```

- [ ] **Step 4: Call `handleIpcEnvelope` from `readAndPush`**

Inside `readAndPush`, replace the block starting with `const raw = Buffer.from(...)` and the subsequent `runtime.send(session, notification)` invocation with a pre-dispatch to `handleIpcEnvelope`:

Original (current `src/tui/nexus-ws-bridge.ts` around lines 391–456):

```typescript
      const raw = Buffer.from(result.result.data, "base64").toString();
      const msg = JSON.parse(raw) as {
        from?: string;
        sender?: string;
        payload?: Record<string, unknown>;
      };
      // ...summary + runtime.send block follows
```

Replace with:

```typescript
      const raw = Buffer.from(result.result.data, "base64").toString();
      const msg = JSON.parse(raw) as {
        from?: string;
        sender?: string;
        payload?: Record<string, unknown>;
      };

      // Pre-dispatch: if this envelope is a typed acp.* event, hand it to
      // the typed consumer and skip the runtime.send IPC-notification path.
      const outcome = this.handleIpcEnvelope(msg.payload);
      if (outcome === "acp") {
        return;
      }

      // (existing code below — unchanged)
      const msgSender = msg.from ?? msg.sender ?? sender;
      const summary = /* ...unchanged... */;
      // ...rest of existing readAndPush body...
```

- [ ] **Step 5: Replace the scaffold test with a real one**

Replace the test added in Step 1 with:

```typescript
test("handleIpcEnvelope routes acp.message to onAcpEvent when source is remote", () => {
  const onAcpEvent = mock(() => undefined);
  const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
  const outcome = bridge.handleIpcEnvelope({
    type: "acp.message",
    sourceRole: "external-agent", // not in topology
    targetRole: "tui",
    payload: { sessionId: "s1", turnId: "t1", message: { kind: "text", turnId: "t1", text: "hi", chunk: true } },
    timestamp: new Date().toISOString(),
  });
  expect(outcome).toBe("acp");
  expect(onAcpEvent).toHaveBeenCalledTimes(1);
});

test("handleIpcEnvelope drops acp.message when source is a local topology role", () => {
  const onAcpEvent = mock(() => undefined);
  const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
  const outcome = bridge.handleIpcEnvelope({
    type: "acp.message",
    sourceRole: "coder", // local — see makeBridgeOpts
    targetRole: "tui",
    payload: { sessionId: "s1", turnId: "t1", message: { kind: "text", turnId: "t1", text: "hi", chunk: true } },
    timestamp: new Date().toISOString(),
  });
  expect(outcome).toBe("acp");
  expect(onAcpEvent).not.toHaveBeenCalled();
});

test("handleIpcEnvelope returns 'ipc' for non-acp payloads (regression guard)", () => {
  const onAcpEvent = mock(() => undefined);
  const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
  const outcome = bridge.handleIpcEnvelope({
    type: "contribution",
    sourceRole: "coder",
    targetRole: "reviewer",
    payload: { body: "done" },
    timestamp: new Date().toISOString(),
  });
  expect(outcome).toBe("ipc");
  expect(onAcpEvent).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run tests**

Run: `bun test src/tui/nexus-ws-bridge.test.ts`
Expected: all tests pass (including existing ones).

- [ ] **Step 7: Commit**

```bash
git add src/tui/nexus-ws-bridge.ts src/tui/nexus-ws-bridge.test.ts
git commit -m "feat(tui): nexus-ws-bridge forwards typed acp.* events, gates on local roles"
```

---

## Task 6: Hook spawn lifecycle to register/unregister sessions

**Files:**
- Modify: `src/tui/spawn-manager.ts`

- [ ] **Step 1: Add `acpSessionStore` to SpawnManager constructor options**

Open `src/tui/spawn-manager.ts`. Locate the `SpawnManager` class (around line 79) and add an optional constructor option (`acpSessionStore?: AcpSessionStore`). Store it as a private readonly field.

```typescript
import type { AcpSessionStore } from "./data/acp-session-store.js";

// ...inside SpawnManager:
private readonly acpSessionStore?: AcpSessionStore;

// Constructor parameter list: add `acpSessionStore?: AcpSessionStore` alongside
// the existing ones and assign: this.acpSessionStore = opts.acpSessionStore;
```

- [ ] **Step 2: Register on spawn, unregister on kill**

Find the `wsBridge.registerSession(roleId, agentSession)` call at around line 443. Directly after it:

```typescript
this.acpSessionStore?.register(agentSession.id);
```

Find the `wsBridge?.unregisterSession(killedAgentId)` call at around line 478. Directly after it:

```typescript
this.acpSessionStore?.unregister(killedAgentId);
```

- [ ] **Step 3: Run existing spawn-manager tests to make sure nothing regressed**

Run: `bun test src/tui/spawn-manager.test.ts`
Expected: all existing tests pass (the new field is optional).

- [ ] **Step 4: Commit**

```bash
git add src/tui/spawn-manager.ts
git commit -m "feat(tui): spawn-manager register/unregister sessions on AcpSessionStore"
```

---

## Task 7: SessionPanel component + render-data derivation

**Files:**
- Create: `src/tui/views/session-panel.tsx`
- Test: `src/tui/views/session-panel.test.ts` (pure data-derivation test; no DOM render — matches existing TUI testing style)

- [ ] **Step 1: Write failing derivation test**

```typescript
// src/tui/views/session-panel.test.ts
import { expect, test } from "bun:test";
import type { TurnRecord } from "../data/acp-session-store.js";
import { deriveSessionPanelLines, statusBadge } from "./session-panel.js";

test("statusBadge returns the right label for each stopReason", () => {
  expect(statusBadge(undefined)).toBe("● running");
  expect(statusBadge("end_turn")).toBe("✓ end_turn");
  expect(statusBadge("cancelled")).toBe("⊘ cancelled");
  expect(statusBadge("max_tokens")).toBe("⊘ max_tokens");
  expect(statusBadge("error")).toBe("✗ error");
});

test("deriveSessionPanelLines concatenates text chunks and emits one tool line per tool_call", () => {
  const turn: TurnRecord = {
    turnId: "t1",
    sessionId: "s1",
    startedAt: 1,
    messages: [
      { kind: "text", turnId: "t1", text: "Hel", chunk: true },
      { kind: "text", turnId: "t1", text: "lo", chunk: true },
      {
        kind: "tool_call",
        turnId: "t1",
        toolCall: { id: "tc1", name: "bash", status: "completed", input: {} },
      },
      {
        kind: "permission_request",
        turnId: "t1",
        request: { id: "p1", tool: "bash", input: {} },
      },
      { kind: "thinking", turnId: "t1", text: "hmm", chunk: true },
      { kind: "raw", turnId: "t1", acpMethod: "session/update:x", params: {} },
      { kind: "token_usage", turnId: "t1", usage: { inputTokens: 10, outputTokens: 5 } },
    ],
  };
  const lines = deriveSessionPanelLines(turn);
  expect(lines).toEqual([
    { kind: "text", text: "Hello" },
    { kind: "tool", text: "[tool] bash · completed" },
    { kind: "perm", text: "⚑ permission requested: bash" },
    { kind: "thinking", text: "(thinking) hmm" },
    { kind: "raw", text: "[raw: session/update:x]" },
  ]);
});

test("deriveSessionPanelLines returns [] when the turn is empty", () => {
  const turn: TurnRecord = { turnId: "t1", sessionId: "s1", startedAt: 1, messages: [] };
  expect(deriveSessionPanelLines(turn)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tui/views/session-panel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel component + derivation helper**

```tsx
// src/tui/views/session-panel.tsx
/**
 * SessionPanel — native renderer for the typed ACP Message union.
 *
 * Subscribes to an AcpSessionStore for a given sessionId and renders the
 * most recent turn's messages. Status badge reflects the terminal
 * stopReason. Older turns are reachable via scrollback (j/k) — the data
 * model keeps them around; this initial version renders only the latest
 * turn's content to keep the first cut small.
 */

import React, { useEffect, useState } from "react";
import type { Message, Result } from "../../acp/types.js";
import type { AcpSessionStore, TurnRecord } from "../data/acp-session-store.js";
import { theme } from "../theme.js";

export type PanelLineKind = "text" | "thinking" | "tool" | "perm" | "raw";

export interface PanelLine {
  readonly kind: PanelLineKind;
  readonly text: string;
}

/** Pure data derivation, exported for unit tests. */
export function deriveSessionPanelLines(turn: TurnRecord): PanelLine[] {
  const out: PanelLine[] = [];
  let textBuf = "";

  const flushText = (): void => {
    if (textBuf.length > 0) {
      out.push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  for (const message of turn.messages) {
    switch (message.kind) {
      case "text":
        textBuf += message.text;
        break;
      case "tool_call":
        flushText();
        out.push({
          kind: "tool",
          text: `[tool] ${message.toolCall.name} · ${message.toolCall.status}`,
        });
        break;
      case "permission_request":
        flushText();
        out.push({ kind: "perm", text: `⚑ permission requested: ${message.request.tool}` });
        break;
      case "thinking":
        flushText();
        out.push({ kind: "thinking", text: `(thinking) ${message.text}` });
        break;
      case "raw":
        flushText();
        out.push({ kind: "raw", text: `[raw: ${message.acpMethod}]` });
        break;
      case "token_usage":
        // rendered separately in the footer; not a body line
        break;
    }
  }

  flushText();
  return out;
}

export function statusBadge(stopReason: Result["stopReason"] | undefined): string {
  if (stopReason === undefined) return "● running";
  switch (stopReason) {
    case "end_turn":
      return "✓ end_turn";
    case "max_tokens":
      return "⊘ max_tokens";
    case "cancelled":
      return "⊘ cancelled";
    case "error":
      return "✗ error";
  }
}

export interface SessionPanelProps {
  readonly store: AcpSessionStore;
  readonly sessionId: string;
}

export function SessionPanel({ store, sessionId }: SessionPanelProps): React.ReactNode {
  const [, setTick] = useState(0);
  useEffect(() => {
    return store.subscribe(sessionId, () => setTick((t) => t + 1));
  }, [store, sessionId]);

  const session = store.getSession(sessionId);
  const turn =
    session?.latestTurnId !== undefined ? session.turns.get(session.latestTurnId) : undefined;

  const lines = turn ? deriveSessionPanelLines(turn) : [];
  const usage = turn ? findTokenUsage(turn.messages) : undefined;

  return (
    <box flexDirection="column" borderStyle="round" borderColor={theme.focus} paddingX={1}>
      <box flexDirection="row">
        <text color={theme.focus} bold>
          session {sessionId.slice(0, 12)}
        </text>
        <text color={theme.secondary}>
          {" "}
          · turn {turn ? turn.turnId.slice(-8) : "—"}{" "}
        </text>
        <text color={badgeColor(turn?.stopReason)}>{statusBadge(turn?.stopReason)}</text>
        {turn?.error ? (
          <text color={theme.error}>
            {" "}
            {turn.error.code}: {turn.error.message}
          </text>
        ) : null}
      </box>

      {lines.length === 0 ? (
        <text color={theme.secondary}>(no messages yet)</text>
      ) : (
        lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: panel lines have no stable identity
          <text key={i} color={lineColor(line.kind)}>
            {line.text}
          </text>
        ))
      )}

      {usage ? (
        <text color={theme.secondary}>
          usage · in={usage.inputTokens} out={usage.outputTokens}
        </text>
      ) : null}
    </box>
  );
}

function findTokenUsage(messages: readonly Message[]): { inputTokens: number; outputTokens: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === "token_usage") return m.usage;
  }
  return undefined;
}

function lineColor(kind: PanelLineKind): string {
  switch (kind) {
    case "text":
      return theme.text;
    case "tool":
      return theme.focus;
    case "perm":
      return theme.warn;
    case "thinking":
      return theme.disabled;
    case "raw":
      return theme.secondary;
  }
}

function badgeColor(stopReason: Result["stopReason"] | undefined): string {
  if (stopReason === undefined) return theme.focus;
  if (stopReason === "end_turn") return theme.success ?? theme.focus;
  if (stopReason === "error") return theme.error;
  return theme.warn;
}
```

- [ ] **Step 4: Check theme keys**

Run: `rg -n "success|warn|error" src/tui/theme.ts | head`
Expected: confirms `theme.success`, `theme.warn`, `theme.error`, `theme.text`, `theme.focus`, `theme.secondary`, `theme.disabled` all exist. If a key is missing, use `theme.focus` as fallback (existing convention in `trace-pane.tsx`).

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test src/tui/views/session-panel.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add src/tui/views/session-panel.tsx src/tui/views/session-panel.test.ts
git commit -m "feat(tui): SessionPanel renders typed Message union"
```

---

## Task 8: Wire everything in `src/tui/main.ts`

**Files:**
- Modify: `src/tui/main.ts`

- [ ] **Step 1: Construct the store + sink and plug into the bus and bridge**

Open `src/tui/main.ts`. Locate the existing EventBus construction block (around line 370):

```typescript
  let eventBus: import("../core/event-bus.js").EventBus | undefined;
  {
    const nexusUrl = process.env.GROVE_NEXUS_URL;
    const apiKey = process.env.NEXUS_API_KEY;
    if (nexusUrl && apiKey) {
      const { LocalEventBus } = await import("../core/local-event-bus.js");
      eventBus = new LocalEventBus();
      stopCallbacks.push(() => eventBus?.close());
    }
  }
```

Directly after it, add:

```typescript
  // AcpSessionStore + sink wiring.
  const { AcpSessionStore } = await import("./data/acp-session-store.js");
  const { createAcpMessageSink } = await import("./data/acp-message-sink.js");
  const acpSessionStore = new AcpSessionStore();
  const acpSink = createAcpMessageSink(acpSessionStore);

  // In-process subscription: every topology role publishes via the same bus,
  // so one subscription per role covers local agents. Non-acp event types are
  // ignored by the sink (see acp-message-sink.ts).
  if (eventBus) {
    for (const role of topology.roles) {
      eventBus.subscribe(role.name, (ev) => acpSink.handleGroveEvent(ev));
    }
  }
```

- [ ] **Step 2: Pass the store + sink through the rendered app props**

Still in `main.ts`, extend the `appProps` object (~line 386) with:

```typescript
      acpSessionStore,
      acpSink,
```

- [ ] **Step 3: Thread `onAcpEvent` into `NexusWsBridge` construction**

Locate where `NexusWsBridge` is constructed. Per `src/tui/nexus-ws-bridge.test.ts`, bridge construction happens inside `screen-manager.tsx` or wherever it is wired today. Run:

Run: `rg -n "new NexusWsBridge" src/tui`
Expected: one or two call sites.

Pass `onAcpEvent: (ev) => acpSink.handleGroveEvent(ev)` into the options object at each call site. If the bridge is instantiated inside a component deeper in the tree, plumb `acpSink` into that component via the app props added in Step 2.

- [ ] **Step 4: Plumb `acpSessionStore` into `SpawnManager`**

Run: `rg -n "new SpawnManager" src/tui`
Expected: one call site (typically inside `tui-app.tsx` or `screen-manager.tsx`).

Add `acpSessionStore` to the options passed at construction (the field was added in Task 6).

- [ ] **Step 5: Typecheck + run full suite**

Run: `bun run typecheck`
Expected: no errors.

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tui/main.ts src/tui/tui-app.tsx src/tui/screens/screen-manager.tsx
git commit -m "feat(tui): wire AcpSessionStore + sink into main + bridge + spawn"
```

(Stage the exact files that were modified — add only the ones `git status` lists.)

---

## Task 9: Extend E2E to assert TUI renders typed messages

**Files:**
- Modify: existing `tests/e2e/acp-stream-nexus.e2e.test.ts` (created by #261) OR
- Create: `tests/e2e/tui-acp-consumer.e2e.test.ts` — if the existing file's shape does not admit an extra assertion.

- [ ] **Step 1: Locate the existing E2E**

Run: `ls tests/e2e/ 2>/dev/null && rg -l "publishTurnToNexus|acp-stream-nexus" tests/`
Expected: exact path of the scenario shipped with #261.

- [ ] **Step 2: Decide extend vs. add**

If the existing file drives a live agent through `publishTurnToNexus` and asserts against the Nexus HTTP API, add a branch that also:
1. Constructs an `AcpSessionStore` and `AcpMessageSink`.
2. `store.register(session.id)` before the turn starts.
3. Subscribes to the same `NexusEventBus` instance the test uses for publish.
4. After the turn completes, asserts `store.getTurn(session.id, turn.turnId)?.stopReason === "end_turn"` and `messages.length > 0`.

If the existing file's structure makes that awkward, create `tests/e2e/tui-acp-consumer.e2e.test.ts` as a peer with the same Nexus bootstrap and an independent scenario.

- [ ] **Step 3: Write the extension / new file**

Example (new file form; adapt paths to match the real E2E harness):

```typescript
// tests/e2e/tui-acp-consumer.e2e.test.ts
import { expect, test } from "bun:test";
import { AcpxRuntime } from "../../src/core/acpx-runtime.js";
import { NexusIpcClient } from "../../src/nexus/nexus-ipc-client.js";
import { NexusEventBus } from "../../src/nexus/nexus-event-bus.js";
import { publishTurnToNexus } from "../../src/nexus/nexus-agent-publisher.js";
import { AcpSessionStore } from "../../src/tui/data/acp-session-store.js";
import { createAcpMessageSink } from "../../src/tui/data/acp-message-sink.js";

test("TUI AcpSessionStore ingests typed messages from a real agent turn through Nexus", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) return; // skip when acpx not present
  const nexusUrl = process.env.NEXUS_URL ?? "http://localhost:2026";
  const ipc = new NexusIpcClient({ baseUrl: nexusUrl });
  const bus = new NexusEventBus(ipc);

  const store = new AcpSessionStore();
  const sink = createAcpMessageSink(store);
  bus.subscribe("orchestrator", (ev) => sink.handleGroveEvent(ev));

  const session = await rt.spawn("smoke", {
    role: "smoke",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
  });
  store.register(session.id);

  try {
    const turn = await rt.send(session, "reply with: pong");
    await publishTurnToNexus({
      bus,
      sourceRole: "smoke",
      targetRole: "orchestrator",
      sessionId: session.id,
      turnId: turn.turnId,
      messages: turn.messages,
      result: turn.result,
    });

    // Wait for batched flush to settle.
    await new Promise((r) => setTimeout(r, 50));

    const stored = store.getTurn(session.id, turn.turnId);
    expect(stored).toBeDefined();
    expect(stored?.messages.length).toBeGreaterThan(0);
    expect(["end_turn", "error"]).toContain(stored?.stopReason);
  } finally {
    await rt.close(session);
    store.unregister(session.id);
  }
}, 90_000);
```

- [ ] **Step 4: Run**

Start Nexus via the existing harness (see `nexus-stack` skill or project docs). Then:

Run: `bun test tests/e2e/tui-acp-consumer.e2e.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/tui-acp-consumer.e2e.test.ts
git commit -m "test(e2e): TUI typed ACP consumer ingests real agent turn"
```

---

## Task 10: Lint, typecheck, full suite

- [ ] **Step 1: Biome + typecheck**

Run: `bun run lint`
Expected: clean.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 3: If anything fails, fix and commit as a fixup**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from TUI acp consumer wiring"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Unified sink (local + SSE) | Tasks 3, 5, 8 |
| SessionStore with close-on-Result, preserved stopReason | Task 2 |
| `register` / `unregister` from spawn lifecycle | Task 6 |
| AgentLogBuffer projection keeps TracePane working | Task 4 |
| Bridge extension with local-role gate (anti-duplication) | Task 5 |
| Native SessionPanel renderer for Message union | Task 7 |
| Terminal stopReason surfaced (incl. future `publish_failed`) | Task 7 (`statusBadge`, error text render) |
| Unit tests for store, sink, projector | Tasks 2, 3, 4 |
| Bridge regression coverage for non-acp payloads | Task 5 |
| E2E with live Nexus and real agent | Task 9 |
| No polling; SSE + in-process push only | All — no polling added; projector drains on store notify |

**Placeholder scan:** each step has concrete code or a concrete command. No "TBD", no "add appropriate error handling". The only inherently open item is the final wiring in Task 8 Step 3/4, which depends on exact call sites in the existing codebase — the plan includes the discovery command (`rg -n "new NexusWsBridge"`) so the engineer knows where to edit.

**Type consistency:** `AcpSessionStore`, `TurnRecord`, `SessionRecord`, `AcpSinkEvent`, `AcpMessageSink`, `SessionListener`, `PanelLine` names and shapes are stable across tasks. `Message` + `Result` come straight from `src/acp/types.ts` unchanged. `LogLine` shape matches `src/tui/data/agent-log-buffer.ts`.

---

## Open questions before kickoff

1. Has the publisher been wired into the production spawn lifecycle yet, or is it still only called in `publishTurnToNexus` tests? If not wired, Task 9's E2E won't pass end-to-end without a matching publisher-wire step — flag back to the user before starting Task 9.
2. Where exactly should `SessionPanel` mount in the running view? This plan ships the component and data wiring but does not decide the tab layout change.
3. Does `theme.ts` expose `success`/`warn`/`error`? If a key is missing, fall back to `theme.focus` — noted in Task 7 Step 4.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-19-tui-typed-acp-consumer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
