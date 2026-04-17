# ACP Typed Message Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw `onOutput` chunk streaming in `AgentRuntime` with typed `Message`/`Result` streams sourced from acpx `--format json --json-strict` NDJSON, and publish typed records through `NexusEventBus`.

**Architecture:** A pure `src/acp/` module (types + parser + compact + turn) wraps acpx stdout into an `AcpxTurn` returned by `AgentRuntime.send()`. `AcpxRuntime` launches acpx with JSON output per turn, constructs the turn from child stdout, and hooks it into Nexus IPC publish. `AgentSession` keeps its current metadata shape.

**Tech Stack:** TypeScript, Bun 1.3, `bun test`, Biome, tsup. Node `child_process.spawn`, ACP JSON-RPC NDJSON. Nexus IPC over `NexusIpcClient`.

**Spec:** `docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md`

---

## File structure

Created:
- `src/acp/types.ts` — `Message`, `Result`, `ToolCall`, `TokenUsage`, `PermissionRequest`, `AcpxTurn`.
- `src/acp/parser.ts` — pure NDJSON → `Message` stream transformer.
- `src/acp/compact.ts` — folds live event log into compacted turn snapshot.
- `src/acp/turn.ts` — `AcpxTurn` implementation (wraps a `Readable`, exposes iterable + promise).
- `src/acp/parser.test.ts`, `src/acp/compact.test.ts`, `src/acp/turn.test.ts`.
- `tests/fixtures/acp/codex-simple.ndjson`, `claude-tool-call.ndjson`, `gemini-thinking.ndjson` — captured samples.
- `src/core/acpx-runtime.integration.test.ts` — real-acpx smoke.
- `src/nexus/nexus-agent-publisher.ts` — subscribes to `AcpxTurn.messages` and publishes typed events via `NexusEventBus`.

Modified:
- `src/core/agent-runtime.ts` — `send` return type changes to `Promise<AcpxTurn>`; `onOutput` removed.
- `src/core/acpx-runtime.ts` — `sendAsync` rewritten to spawn with `--format json --json-strict` and return `AcpxTurn`.
- `src/core/tmux-runtime.ts`, `src/core/subprocess-runtime.ts`, `src/core/mock-runtime.ts` — `send` returns `AcpxTurn`.
- `src/core/event-bus.ts` — adds `GroveEvent` variants for typed `Message`/`Result` payloads (or reuses existing `payload: unknown`).
- `src/nexus/nexus-event-bus.ts` — unchanged contract; it is a consumer target for the new publisher.

---

## Task 1: Define ACP types

**Files:**
- Create: `src/acp/types.ts`
- Test: `src/acp/types.test.ts`

- [ ] **Step 1: Write the failing type test**

```typescript
// src/acp/types.test.ts
import { expect, test } from "bun:test";
import type { Message, Result, ToolCall } from "./types.ts";

test("Message union discriminates by kind", () => {
  const m: Message = { kind: "text", turnId: "t1", text: "hi", chunk: true };
  expect(m.kind).toBe("text");
  if (m.kind === "text") expect(m.text).toBe("hi");
});

test("ToolCall status covers full lifecycle", () => {
  const tc: ToolCall = { id: "tc1", name: "bash", status: "pending", input: {} };
  const next: ToolCall = { ...tc, status: "completed", output: "ok" };
  expect(next.status).toBe("completed");
});

test("Result stopReason includes cancelled and error", () => {
  const r: Result = { turnId: "t1", stopReason: "cancelled" };
  expect(r.stopReason).toBe("cancelled");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/acp/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types**

```typescript
// src/acp/types.ts
/**
 * Typed ACP message streams. See
 * docs/superpowers/specs/2026-04-16-acp-typed-message-streams-design.md.
 */

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

export type Result = {
  turnId: string;
  stopReason: "end_turn" | "max_tokens" | "cancelled" | "error";
  error?: { code: string; message: string };
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/acp/types.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/acp/types.ts src/acp/types.test.ts
git commit -m "feat(acp): add typed message stream types"
```

---

## Task 2: Capture ACP NDJSON fixtures

**Files:**
- Create: `tests/fixtures/acp/codex-simple.ndjson`
- Create: `tests/fixtures/acp/claude-tool-call.ndjson`
- Create: `tests/fixtures/acp/gemini-thinking.ndjson`
- Create: `tests/fixtures/acp/README.md`

- [ ] **Step 1: Capture a codex simple echo turn**

Run (requires acpx + codex installed):
```bash
mkdir -p tests/fixtures/acp
acpx --format json --json-strict codex exec 'echo hi' > tests/fixtures/acp/codex-simple.ndjson
```

Expected: file contains JSON-RPC lines such as:
```
{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

- [ ] **Step 2: Capture a claude tool-call turn**

```bash
acpx --format json --json-strict claude exec 'read /etc/hostname' > tests/fixtures/acp/claude-tool-call.ndjson
```

Expected: file contains `session/update` frames with `sessionUpdate:"tool_call"` and a final `result`.

- [ ] **Step 3: Capture a gemini thinking turn**

```bash
acpx --format json --json-strict gemini exec 'think: 2+2' > tests/fixtures/acp/gemini-thinking.ndjson
```

- [ ] **Step 4: Author `tests/fixtures/acp/README.md`**

```markdown
# ACP NDJSON fixtures

Captured from `acpx --format json --json-strict`. Regenerate only when ACP
spec evolves or acpx output shape changes.

Regenerate:
```bash
acpx --format json --json-strict codex  exec 'echo hi'        > codex-simple.ndjson
acpx --format json --json-strict claude exec 'read /etc/hostname' > claude-tool-call.ndjson
acpx --format json --json-strict gemini exec 'think: 2+2'     > gemini-thinking.ndjson
```
```

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/acp/
git commit -m "test(acp): capture NDJSON fixtures for parser tests"
```

---

## Task 3: Implement parser

**Files:**
- Create: `src/acp/parser.ts`
- Test: `src/acp/parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

```typescript
// src/acp/parser.test.ts
import { expect, test } from "bun:test";
import { parseAcpLine, AcpParser } from "./parser.ts";
import type { Message, Result } from "./types.ts";

test("parseAcpLine yields text chunk Message for agent_message_chunk text", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    },
  });
  const out = parseAcpLine(line, "t1");
  expect(out.kind).toBe("message");
  if (out.kind === "message") {
    expect(out.message.kind).toBe("text");
  }
});

test("parseAcpLine yields Result on JSON-RPC result frame with stopReason", () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } });
  const out = parseAcpLine(line, "t1");
  expect(out.kind).toBe("result");
  if (out.kind === "result") {
    expect(out.result.stopReason).toBe("end_turn");
  }
});

test("parseAcpLine emits raw for unknown sessionUpdate kind", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionUpdate: "future_thing", content: { foo: 1 } },
  });
  const out = parseAcpLine(line, "t1");
  expect(out.kind).toBe("message");
  if (out.kind === "message") {
    expect(out.message.kind).toBe("raw");
  }
});

test("parseAcpLine emits raw/_parseError on malformed JSON", () => {
  const out = parseAcpLine("{not json", "t1");
  expect(out.kind).toBe("message");
  if (out.kind === "message" && out.message.kind === "raw") {
    expect(out.message.acpMethod).toBe("_parseError");
  }
});

test("AcpParser streams messages from a Readable and resolves result", async () => {
  const { Readable } = await import("node:stream");
  const fixture = await Bun.file("tests/fixtures/acp/codex-simple.ndjson").text();
  const stream = Readable.from([fixture]);
  const parser = new AcpParser({ sessionId: "s1", turnId: "t1", stream });
  const messages: Message[] = [];
  for await (const m of parser.messages) messages.push(m);
  const result: Result = await parser.result;
  expect(messages.length).toBeGreaterThan(0);
  expect(result.stopReason).toBe("end_turn");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/acp/parser.test.ts`
Expected: FAIL — parser not implemented.

- [ ] **Step 3: Implement parser**

```typescript
// src/acp/parser.ts
/**
 * Pure NDJSON → typed Message parser. No I/O beyond reading the given stream.
 *
 * Emits one Message per parsed line. Malformed lines yield a raw Message with
 * acpMethod:"_parseError" — one bad line never kills a session.
 */

import type { Readable } from "node:stream";
import type { Message, Result, ToolCall } from "./types.ts";

export type ParsedLine =
  | { kind: "message"; message: Message }
  | { kind: "result"; result: Result };

/** Parse a single NDJSON line into a Message or Result. Always returns; never throws. */
export function parseAcpLine(line: string, turnId: string): ParsedLine {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return {
      kind: "message",
      message: { kind: "raw", turnId, acpMethod: "_parseError", params: line },
    };
  }

  if (!isRecord(frame)) {
    return {
      kind: "message",
      message: { kind: "raw", turnId, acpMethod: "_nonObject", params: frame },
    };
  }

  // JSON-RPC result frame: { id, result: { stopReason } }
  if ("result" in frame && isRecord(frame.result) && "stopReason" in frame.result) {
    const stop = frame.result.stopReason;
    return {
      kind: "result",
      result: {
        turnId,
        stopReason: normalizeStopReason(stop),
      },
    };
  }

  // JSON-RPC error frame
  if ("error" in frame && isRecord(frame.error)) {
    const err = frame.error;
    return {
      kind: "result",
      result: {
        turnId,
        stopReason: "error",
        error: {
          code: typeof err.code === "string" ? err.code : String(err.code),
          message: typeof err.message === "string" ? err.message : "",
        },
      },
    };
  }

  // session/update frames
  if (frame.method === "session/update" && isRecord(frame.params)) {
    const p = frame.params;
    switch (p.sessionUpdate) {
      case "agent_message_chunk":
        return {
          kind: "message",
          message: toTextOrThinking(p.content, turnId, false),
        };
      case "agent_thought_chunk":
        return {
          kind: "message",
          message: toTextOrThinking(p.content, turnId, true),
        };
      case "tool_call":
      case "tool_call_update":
        return {
          kind: "message",
          message: { kind: "tool_call", turnId, toolCall: toToolCall(p) },
        };
      case "permission_request":
        return {
          kind: "message",
          message: {
            kind: "permission_request",
            turnId,
            request: {
              id: String(p.id ?? ""),
              tool: String(p.tool ?? ""),
              input: p.input,
            },
          },
        };
      case "token_usage":
        return {
          kind: "message",
          message: {
            kind: "token_usage",
            turnId,
            usage: {
              inputTokens: Number((p.usage as { inputTokens?: number } | undefined)?.inputTokens ?? 0),
              outputTokens: Number((p.usage as { outputTokens?: number } | undefined)?.outputTokens ?? 0),
            },
          },
        };
      default:
        return {
          kind: "message",
          message: {
            kind: "raw",
            turnId,
            acpMethod: `session/update:${String(p.sessionUpdate)}`,
            params: p,
          },
        };
    }
  }

  // Anything else (other JSON-RPC methods, notifications)
  return {
    kind: "message",
    message: {
      kind: "raw",
      turnId,
      acpMethod: typeof frame.method === "string" ? frame.method : "_unknown",
      params: frame,
    },
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function toTextOrThinking(
  content: unknown,
  turnId: string,
  thinking: boolean,
): Message {
  const text =
    isRecord(content) && typeof content.text === "string" ? content.text : "";
  return thinking
    ? { kind: "thinking", turnId, text, chunk: true }
    : { kind: "text", turnId, text, chunk: true };
}

function toToolCall(p: Record<string, unknown>): ToolCall {
  return {
    id: String(p.toolCallId ?? p.id ?? ""),
    name: String(p.toolName ?? p.name ?? ""),
    status: normalizeToolStatus(p.status),
    input: p.input,
    output: p.output,
    diff: typeof p.diff === "string" ? p.diff : undefined,
    error: typeof p.error === "string" ? p.error : undefined,
  };
}

function normalizeToolStatus(s: unknown): ToolCall["status"] {
  if (s === "pending" || s === "in_progress" || s === "completed" || s === "failed") return s;
  return "in_progress";
}

function normalizeStopReason(s: unknown): Result["stopReason"] {
  if (s === "end_turn" || s === "max_tokens" || s === "cancelled" || s === "error") return s;
  return "end_turn";
}

/** Streams Messages from a Readable of NDJSON bytes. */
export class AcpParser {
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;

  constructor(opts: { sessionId: string; turnId: string; stream: Readable }) {
    const { turnId, stream } = opts;
    let resultResolve: (r: Result) => void;
    this.result = new Promise<Result>((res) => {
      resultResolve = res;
    });

    this.messages = (async function* () {
      let buf = "";
      for await (const chunk of stream) {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length === 0) continue;
          const parsed = parseAcpLine(line, turnId);
          if (parsed.kind === "message") {
            yield parsed.message;
          } else {
            resultResolve(parsed.result);
            return;
          }
        }
      }
      // EOF without explicit result — synthesize error Result.
      resultResolve({
        turnId,
        stopReason: "error",
        error: { code: "acpx_exit", message: "stream closed before result" },
      });
    })();
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/acp/parser.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/acp/parser.ts src/acp/parser.test.ts
git commit -m "feat(acp): pure NDJSON → typed Message parser"
```

---

## Task 4: Implement compactor

**Files:**
- Create: `src/acp/compact.ts`
- Test: `src/acp/compact.test.ts`

- [ ] **Step 1: Write failing compact tests**

```typescript
// src/acp/compact.test.ts
import { expect, test } from "bun:test";
import { compactTurn } from "./compact.ts";
import type { Message, Result } from "./types.ts";

test("compactTurn folds text chunks into a single assistant message", () => {
  const msgs: Message[] = [
    { kind: "text", turnId: "t1", text: "Hel", chunk: true },
    { kind: "text", turnId: "t1", text: "lo", chunk: true },
  ];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const snap = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(snap.assistantText).toBe("Hello");
});

test("compactTurn folds tool-call lifecycle into final ToolCall record", () => {
  const msgs: Message[] = [
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "pending", input: {} } },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "in_progress", input: {} } },
    { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash", status: "completed", input: {}, output: "ok" } },
  ];
  const snap = compactTurn({ turnId: "t1", messages: msgs, result: { turnId: "t1", stopReason: "end_turn" } });
  expect(snap.toolCalls).toHaveLength(1);
  expect(snap.toolCalls[0]?.status).toBe("completed");
  expect(snap.toolCalls[0]?.output).toBe("ok");
});

test("compactTurn is idempotent", () => {
  const msgs: Message[] = [{ kind: "text", turnId: "t1", text: "Hi", chunk: true }];
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  const a = compactTurn({ turnId: "t1", messages: msgs, result });
  const b = compactTurn({ turnId: "t1", messages: msgs, result });
  expect(a).toEqual(b);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/acp/compact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement compact**

```typescript
// src/acp/compact.ts
/**
 * Fold a live event log (Messages + Result) into a compacted turn snapshot.
 * Idempotent: running twice on the same input yields the same output.
 */

import type { Message, Result, ToolCall, TokenUsage } from "./types.ts";

export interface TurnSnapshot {
  turnId: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  stopReason: Result["stopReason"];
  error?: Result["error"];
}

export function compactTurn(input: {
  turnId: string;
  messages: readonly Message[];
  result: Result;
}): TurnSnapshot {
  let assistantText = "";
  let thinkingText = "";
  const toolCallMap = new Map<string, ToolCall>();
  let usage: TokenUsage | undefined;

  for (const m of input.messages) {
    switch (m.kind) {
      case "text":
        assistantText += m.text;
        break;
      case "thinking":
        thinkingText += m.text;
        break;
      case "tool_call": {
        const existing = toolCallMap.get(m.toolCall.id);
        toolCallMap.set(m.toolCall.id, { ...existing, ...m.toolCall });
        break;
      }
      case "token_usage":
        usage = m.usage;
        break;
      default:
        // raw, permission_request — not included in snapshot summary
        break;
    }
  }

  return {
    turnId: input.turnId,
    assistantText,
    thinkingText,
    toolCalls: [...toolCallMap.values()],
    usage,
    stopReason: input.result.stopReason,
    error: input.result.error,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/acp/compact.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/acp/compact.ts src/acp/compact.test.ts
git commit -m "feat(acp): idempotent turn compactor"
```

---

## Task 5: Implement AcpxTurn wrapper

**Files:**
- Create: `src/acp/turn.ts`
- Test: `src/acp/turn.test.ts`

- [ ] **Step 1: Write failing turn tests**

```typescript
// src/acp/turn.test.ts
import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { AcpxTurnImpl } from "./turn.ts";
import type { Message } from "./types.ts";

function makeStream(lines: string[]): Readable {
  return Readable.from([lines.join("\n") + "\n"]);
}

test("AcpxTurn yields messages and resolves result from a stream", async () => {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: makeStream(lines),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;
  expect(got).toHaveLength(1);
  expect(r.stopReason).toBe("end_turn");
});

test("cancel() calls cancelFn and the later result wins", async () => {
  let cancelCalled = false;
  const lines = [JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "cancelled" } })];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: makeStream(lines),
    cancelFn: async () => {
      cancelCalled = true;
    },
  });
  await turn.cancel();
  for await (const _ of turn.messages) { /* drain */ }
  const r = await turn.result;
  expect(cancelCalled).toBe(true);
  expect(r.stopReason).toBe("cancelled");
});

test("EOF without result yields error Result", async () => {
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([""]),
    cancelFn: async () => undefined,
  });
  for await (const _ of turn.messages) { /* drain */ }
  const r = await turn.result;
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("acpx_exit");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/acp/turn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AcpxTurn**

```typescript
// src/acp/turn.ts
/**
 * AcpxTurn — owns a single prompt's message stream and final result.
 * Constructed by AcpxRuntime from the acpx child's stdout Readable.
 */

import type { Readable } from "node:stream";
import { AcpParser } from "./parser.ts";
import type { AcpxTurn, Message, Result } from "./types.ts";

export class AcpxTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private cancelled = false;

  constructor(opts: {
    sessionId: string;
    turnId: string;
    stdout: Readable;
    cancelFn: () => Promise<void>;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    const parser = new AcpParser({
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      stream: opts.stdout,
    });
    this.messages = parser.messages;
    this.result = parser.result;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await this.cancelFn();
  }

  async close(): Promise<void> {
    // Parser closes when stdout EOFs; nothing extra to release here.
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/acp/turn.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/acp/turn.ts src/acp/turn.test.ts
git commit -m "feat(acp): AcpxTurn wrapper over child stdout"
```

---

## Task 6: Extend AgentRuntime interface

**Files:**
- Modify: `src/core/agent-runtime.ts`

- [ ] **Step 1: Update interface**

Replace lines 39–55 of `src/core/agent-runtime.ts` with:

```typescript
/** Runtime for managing agent lifecycle. */
export interface AgentRuntime {
  /** Spawn a new agent session. */
  spawn(role: string, config: AgentConfig): Promise<AgentSession>;
  /** Send a prompt and return the typed turn stream. */
  send(session: AgentSession, message: string): Promise<import("../acp/types.ts").AcpxTurn>;
  /** Gracefully close an agent session. */
  close(session: AgentSession): Promise<void>;
  /** Register a callback for when an agent becomes idle. */
  onIdle(session: AgentSession, callback: () => void): void;
  /** List all active sessions. */
  listSessions(): Promise<readonly AgentSession[]>;
  /** Check if the runtime's dependencies are available. */
  isAvailable(): Promise<boolean>;
}
```

Note: `onOutput` is removed. All existing implementations currently break type-check — fixed in the next tasks.

- [ ] **Step 2: Run typecheck to see downstream breakage**

Run: `bun run tsc --noEmit 2>&1 | head -40`
Expected: errors pointing to `acpx-runtime.ts`, `tmux-runtime.ts`, `subprocess-runtime.ts`, `mock-runtime.ts` because `send` return type changed.

- [ ] **Step 3: Commit (temporarily broken typecheck is fine; fixed across next tasks)**

Do NOT commit yet — commit after Task 7 when all runtimes compile.

---

## Task 7: Update AcpxRuntime.sendAsync

**Files:**
- Modify: `src/core/acpx-runtime.ts`

- [ ] **Step 1: Write failing component test**

```typescript
// src/core/acpx-runtime.component.test.ts (new)
import { expect, test } from "bun:test";
import { AcpxRuntime } from "./acpx-runtime.ts";

test("send returns an AcpxTurn with messages iterable and result promise", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) {
    // Skip when acpx not installed — CI integration test covers this.
    return;
  }
  const session = await rt.spawn("coder", {
    role: "coder",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
  });
  try {
    const turn = await rt.send(session, "echo hi");
    let count = 0;
    for await (const _ of turn.messages) count += 1;
    const r = await turn.result;
    expect(count).toBeGreaterThan(0);
    expect(["end_turn", "error"]).toContain(r.stopReason);
  } finally {
    await rt.close(session);
  }
});
```

- [ ] **Step 2: Run to verify it fails (or skips)**

Run: `bun test src/core/acpx-runtime.component.test.ts`
Expected: FAIL or skip depending on acpx presence. If FAIL due to current implementation, proceed.

- [ ] **Step 3: Replace `sendAsync` and `send` in `src/core/acpx-runtime.ts`**

Locate lines 261–374 (`sendAsync`) and lines 376–415 (`send`). Replace with the block below. Also remove `onOutput` (lines 463–467) and the `outputCallbacks` field (line 53).

```typescript
  /**
   * Fire a prompt. Returns an AcpxTurn that streams typed Messages and
   * resolves with the final Result.
   */
  private startTurn(entry: AcpxSessionEntry, message: string): import("../acp/types.ts").AcpxTurn {
    const turnId = `${entry.sessionName}-${Date.now().toString(36)}-${this.nextId++}`;
    entry.session = { ...entry.session, status: "running" };

    // Wrap message with system-reminder (kept from prior implementation).
    const wrappedMessage = `<system-reminder>
SUBMITTING WORK:
1. Edit files, then: git add -A && git commit -m "description"
2. Get hash: git rev-parse HEAD
3. grove_submit_work({ summary: "what you did", commitHash: "<hash>", agent: { role: "${entry.session.role}" } })

REVIEWING WORK:
1. When notified: read files from the Workspace path in the notification (e.g., cat /path/to/coder-workspace/app.js)
2. Review the actual code at that path
3. grove_submit_review({ targetCid: "<cid from notification>", summary: "feedback", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "${entry.session.role}" } })

Without calling these tools, other agents cannot see your work.

RULES ABOUT grove_done:
- grove_done ends the ENTIRE session. Do NOT call it prematurely.
- CODER: After grove_submit_work, STOP and WAIT. NEVER call grove_done.
- REVIEWER requesting changes: After grove_submit_review, STOP and WAIT.
- REVIEWER approving: Call grove_submit_review, THEN grove_done. This ends the session.
</system-reminder>
${message}`;

    if (entry.logStream) {
      const ts = new Date().toISOString();
      entry.logStream.write(`\n[${ts}] >>> PROMPT >>>\n${message}\n[${ts}] <<< END PROMPT <<<\n`);
    }

    const child = nodeSpawn(
      "acpx",
      [
        "--format",
        "json",
        "--json-strict",
        "--approve-all",
        entry.agent,
        "-s",
        entry.sessionName,
        wrappedMessage,
      ],
      {
        cwd: entry.cwd,
        env: entry.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    entry.activeProc = child;

    // Mirror stdout to log file for forensics.
    if (entry.logStream && child.stdout) {
      child.stdout.on("data", (c: Buffer) => entry.logStream?.write(c));
    }
    if (entry.logStream && child.stderr) {
      child.stderr.on("data", (c: Buffer) =>
        entry.logStream?.write(`[stderr] ${c.toString()}`),
      );
    }

    child.on("close", (code) => {
      entry.activeProc = null;
      if (code === 0) {
        entry.session = { ...entry.session, status: "idle" };
        for (const cb of entry.idleCallbacks) {
          try { cb(); } catch { /* ignore */ }
        }
      } else {
        entry.session = { ...entry.session, status: "crashed" };
      }
    });

    const { AcpxTurnImpl } = require("../acp/turn.ts") as typeof import("../acp/turn.ts");
    return new AcpxTurnImpl({
      sessionId: entry.sessionName,
      turnId,
      stdout: child.stdout!,
      cancelFn: async () => {
        // ACP session/cancel — write to stdin if adapter supports it, else SIGINT.
        try { child.kill("SIGINT"); } catch { /* ignore */ }
      },
    });
  }

  async send(session: AgentSession, message: string): Promise<import("../acp/types.ts").AcpxTurn> {
    let entry = this.sessions.get(session.id);
    if (!entry) {
      const agent = session.agent ?? this.agent;
      this.spawnedAgents.add(agent);
      entry = {
        session,
        agent,
        sessionName: session.id,
        cwd: process.cwd(),
        env: { ...process.env },
        idleCallbacks: [],
        idleTimer: null,
        activeProc: null,
        logStream: null,
        logFile: this.logDir ? join(this.logDir, `${session.role}-reattach.log`) : null,
      };
      if (entry.logFile) {
        entry.logStream = createWriteStream(entry.logFile, { flags: "a" });
      }
      this.sessions.set(session.id, entry);
    }
    return this.startTurn(entry, message);
  }
```

Also remove the `outputCallbacks` field from `AcpxSessionEntry` (line 53) and its initialiser (line 237 and 395), and delete the `onOutput` method (lines 463–467).

In `spawn` (line 246–251), replace:

```typescript
    if (!config.waitForPush) {
      const initialMessage = config.goal ?? config.prompt;
      if (initialMessage) {
        this.sendAsync(entry, initialMessage);
      }
    }
```

with:

```typescript
    if (!config.waitForPush) {
      const initialMessage = config.goal ?? config.prompt;
      if (initialMessage) {
        // Fire initial turn; drop the AcpxTurn (callers get future turns via send()).
        void this.startTurn(entry, initialMessage);
      }
    }
```

- [ ] **Step 4: Run typecheck + test**

Run: `bun run tsc --noEmit 2>&1 | grep acpx-runtime`
Expected: no errors in acpx-runtime.

Run: `bun test src/acp/`
Expected: all acp tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runtime.ts src/core/acpx-runtime.ts src/core/acpx-runtime.component.test.ts
git commit -m "feat(acpx): send returns AcpxTurn; spawn acpx with --format json"
```

---

## Task 8: Update MockRuntime

**Files:**
- Modify: `src/core/mock-runtime.ts`

- [ ] **Step 1: Write failing test first**

```typescript
// src/core/mock-runtime.test.ts (new or append)
import { expect, test } from "bun:test";
import { MockRuntime } from "./mock-runtime.ts";

test("MockRuntime.send returns a drainable AcpxTurn with canned messages", async () => {
  const rt = new MockRuntime();
  const s = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  rt.enqueueMessages(s.id, [
    { kind: "text", turnId: "auto", text: "ok", chunk: true },
  ]);
  rt.enqueueResult(s.id, { turnId: "auto", stopReason: "end_turn" });
  const turn = await rt.send(s, "hi");
  const got = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;
  expect(got).toHaveLength(1);
  expect(r.stopReason).toBe("end_turn");
});
```

- [ ] **Step 2: Run to fail**

Run: `bun test src/core/mock-runtime.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Update MockRuntime**

Replace `send` (line 37–39) and add queue helpers. Full new file contents:

```typescript
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.ts";
import type { AcpxTurn, Message, Result } from "../acp/types.ts";

export class MockRuntime implements AgentRuntime {
  readonly spawnCalls: Array<{ role: string; config: AgentConfig }> = [];
  readonly sendCalls: Array<{ sessionId: string; message: string }> = [];
  readonly closeCalls: Array<{ sessionId: string }> = [];

  private sessions = new Map<string, AgentSession>();
  private idleCallbacks = new Map<string, (() => void)[]>();
  private msgQueues = new Map<string, Message[]>();
  private resultQueues = new Map<string, Result[]>();
  private nextId = 0;
  private _isAvailable = true;

  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    this.spawnCalls.push({ role, config });
    const id = `mock-${role}-${this.nextId++}`;
    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
    };
    this.sessions.set(id, session);
    this.idleCallbacks.set(id, []);
    return session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    this.sendCalls.push({ sessionId: session.id, message });
    const queued = this.msgQueues.get(session.id) ?? [];
    const resultQ = this.resultQueues.get(session.id) ?? [];
    const messages = (async function* () { for (const m of queued) yield m; })();
    const result = Promise.resolve(
      resultQ.shift() ?? { turnId: "mock", stopReason: "end_turn" as const },
    );
    return {
      sessionId: session.id,
      turnId: "mock",
      messages,
      result,
      cancel: async () => undefined,
      close: async () => undefined,
    };
  }

  async close(session: AgentSession): Promise<void> {
    this.closeCalls.push({ sessionId: session.id });
    const s = this.sessions.get(session.id);
    if (s) this.sessions.set(session.id, { ...s, status: "stopped" });
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const callbacks = this.idleCallbacks.get(session.id);
    if (callbacks) callbacks.push(callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()];
  }

  async isAvailable(): Promise<boolean> {
    return this._isAvailable;
  }

  triggerIdle(sessionId: string): void {
    const callbacks = this.idleCallbacks.get(sessionId);
    if (callbacks) for (const cb of callbacks) cb();
  }

  setSessionStatus(sessionId: string, status: AgentSession["status"]): void {
    const s = this.sessions.get(sessionId);
    if (s) this.sessions.set(sessionId, { ...s, status });
  }

  getSessionMetadata(
    sessionId: string,
  ): Pick<AgentSession, "platform" | "model" | "agent"> | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return { platform: s.platform, model: s.model, agent: s.agent };
  }

  enqueueMessages(sessionId: string, msgs: Message[]): void {
    const q = this.msgQueues.get(sessionId) ?? [];
    q.push(...msgs);
    this.msgQueues.set(sessionId, q);
  }

  enqueueResult(sessionId: string, r: Result): void {
    const q = this.resultQueues.get(sessionId) ?? [];
    q.push(r);
    this.resultQueues.set(sessionId, q);
  }

  reset(): void {
    this.spawnCalls.length = 0;
    this.sendCalls.length = 0;
    this.closeCalls.length = 0;
    this.sessions.clear();
    this.idleCallbacks.clear();
    this.msgQueues.clear();
    this.resultQueues.clear();
    this.nextId = 0;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/core/mock-runtime.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/mock-runtime.ts src/core/mock-runtime.test.ts
git commit -m "feat(mock-runtime): return AcpxTurn with queueable canned messages"
```

---

## Task 9: Update TmuxRuntime and SubprocessRuntime

**Files:**
- Modify: `src/core/tmux-runtime.ts`
- Modify: `src/core/subprocess-runtime.ts`

Both runtimes do not produce ACP output. They must still satisfy the interface — return an `AcpxTurn` that yields no messages and resolves a benign result.

- [ ] **Step 1: Update `src/core/subprocess-runtime.ts`**

Replace `send` (lines 67–74) with:

```typescript
  async send(session: AgentSession, message: string): Promise<import("../acp/types.ts").AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (entry?.proc.stdin) {
      const result = entry.proc.stdin.write(`${message}\n`);
      if (result instanceof Promise) await result;
      const flush = entry.proc.stdin.flush();
      if (flush instanceof Promise) await flush;
    }
    return emptyTurn(session.id);
  }
```

Add helper at top of file:

```typescript
import type { AcpxTurn } from "../acp/types.ts";

function emptyTurn(sessionId: string): AcpxTurn {
  return {
    sessionId,
    turnId: `${sessionId}-noacp`,
    messages: (async function* () { /* empty */ })(),
    result: Promise.resolve({ turnId: "noacp", stopReason: "end_turn" as const }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}
```

- [ ] **Step 2: Update `src/core/tmux-runtime.ts`**

Replace `send` (lines 94–107) with:

```typescript
  async send(session: AgentSession, message: string): Promise<import("../acp/types.ts").AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (entry) {
      try {
        execSync(
          `tmux -L grove send-keys -t ${shellEscape(session.id)} ${shellEscape(message)} Enter`,
          { encoding: "utf-8", stdio: "pipe" },
        );
      } catch {
        entry.session = { ...entry.session, status: "crashed" };
      }
    }
    return emptyTurn(session.id);
  }
```

Add the same `emptyTurn` helper at the top of `tmux-runtime.ts` (or extract to `src/acp/empty-turn.ts` and import in both — do that if a third caller appears).

- [ ] **Step 3: Run typecheck**

Run: `bun run tsc --noEmit 2>&1 | grep -E "(tmux|subprocess)-runtime" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add src/core/tmux-runtime.ts src/core/subprocess-runtime.ts
git commit -m "feat(runtime): tmux + subprocess return empty AcpxTurn"
```

---

## Task 10: Nexus typed publisher

**Files:**
- Create: `src/nexus/nexus-agent-publisher.ts`
- Test: `src/nexus/nexus-agent-publisher.test.ts`

- [ ] **Step 1: Write failing publisher test**

```typescript
// src/nexus/nexus-agent-publisher.test.ts
import { expect, test } from "bun:test";
import { NexusEventBus } from "./nexus-event-bus.ts";
import { publishTurnToNexus } from "./nexus-agent-publisher.ts";
import type { Message, Result } from "../acp/types.ts";

test("publishTurnToNexus emits one GroveEvent per Message plus a final result event", async () => {
  const bus = new NexusEventBus(undefined);
  const published: unknown[] = [];
  bus.subscribe("orchestrator", (e) => published.push(e.payload));
  const messages: Message[] = [
    { kind: "text", turnId: "t1", text: "hi", chunk: true },
  ];
  const msgIter = (async function* () { for (const m of messages) yield m; })();
  const result: Result = { turnId: "t1", stopReason: "end_turn" };
  await publishTurnToNexus({
    bus,
    sourceRole: "coder",
    targetRole: "orchestrator",
    sessionId: "s1",
    turnId: "t1",
    messages: msgIter,
    result: Promise.resolve(result),
  });
  expect(published).toHaveLength(2);
});
```

- [ ] **Step 2: Run to fail**

Run: `bun test src/nexus/nexus-agent-publisher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement publisher**

```typescript
// src/nexus/nexus-agent-publisher.ts
/**
 * Subscribes to an AcpxTurn and publishes each Message + final Result as
 * GroveEvents via a NexusEventBus.
 */

import type { EventBus } from "../core/event-bus.ts";
import type { Message, Result } from "../acp/types.ts";

export async function publishTurnToNexus(opts: {
  bus: EventBus;
  sourceRole: string;
  targetRole: string;
  sessionId: string;
  turnId: string;
  messages: AsyncIterable<Message>;
  result: Promise<Result>;
}): Promise<void> {
  for await (const message of opts.messages) {
    await opts.bus.publish({
      sourceRole: opts.sourceRole,
      targetRole: opts.targetRole,
      payload: {
        kind: "acp.message",
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        message,
      },
    });
  }
  const result = await opts.result;
  await opts.bus.publish({
    sourceRole: opts.sourceRole,
    targetRole: opts.targetRole,
    payload: {
      kind: "acp.result",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      result,
    },
  });
}
```

- [ ] **Step 4: Run to pass**

Run: `bun test src/nexus/nexus-agent-publisher.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/nexus/nexus-agent-publisher.ts src/nexus/nexus-agent-publisher.test.ts
git commit -m "feat(nexus): typed AcpxTurn → NexusEventBus publisher"
```

---

## Task 11: Integration test (real acpx)

**Files:**
- Create: `src/core/acpx-runtime.integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/core/acpx-runtime.integration.test.ts
import { expect, test } from "bun:test";
import { AcpxRuntime } from "./acpx-runtime.ts";

test("AcpxRuntime spawns acpx codex, streams typed messages, resolves result", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) {
    console.warn("[skip] acpx not installed");
    return;
  }
  const session = await rt.spawn("smoke", {
    role: "smoke",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
  });
  try {
    const turn = await rt.send(session, "what is 2+2? reply with a single number.");
    let sawText = false;
    for await (const m of turn.messages) {
      if (m.kind === "text") sawText = true;
    }
    const r = await turn.result;
    expect(sawText).toBe(true);
    expect(["end_turn", "error"]).toContain(r.stopReason);
  } finally {
    await rt.close(session);
  }
}, 60_000);
```

- [ ] **Step 2: Run**

Run: `bun test src/core/acpx-runtime.integration.test.ts`
Expected: pass when acpx + codex CLI available, otherwise skip.

- [ ] **Step 3: Commit**

```bash
git add src/core/acpx-runtime.integration.test.ts
git commit -m "test(acpx): real-acpx integration smoke for typed stream"
```

---

## Task 12: E2E through Nexus

**Files:**
- Create: `tests/e2e/acp-stream-nexus.e2e.test.ts` (location and runner align with existing E2E suite — verify before writing)

- [ ] **Step 1: Locate existing Nexus E2E harness**

Run: `bun run -e "await Bun.file('tests/e2e/README.md').exists()"`. If absent, search: `rg -l "nexus" tests/`.

Expected: find an existing E2E setup that starts Nexus via the `nexus-stack` skill or a fixture script. Reuse it.

- [ ] **Step 2: Write E2E scenario**

```typescript
// tests/e2e/acp-stream-nexus.e2e.test.ts
import { expect, test } from "bun:test";
import { AcpxRuntime } from "../../src/core/acpx-runtime.ts";
import { NexusEventBus } from "../../src/nexus/nexus-event-bus.ts";
import { NexusIpcClient } from "../../src/nexus/nexus-ipc-client.ts";
import { publishTurnToNexus } from "../../src/nexus/nexus-agent-publisher.ts";

test("spawned agent turn publishes typed messages into Nexus", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) return;
  const ipc = new NexusIpcClient({ baseUrl: process.env.NEXUS_URL ?? "http://localhost:8080" });
  const bus = new NexusEventBus(ipc);
  const session = await rt.spawn("smoke", {
    role: "smoke",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
  });
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
    // Verify via Nexus API — query IPC history for this turnId.
    const res = await fetch(
      `${process.env.NEXUS_URL ?? "http://localhost:8080"}/api/v2/ipc/history?turnId=${encodeURIComponent(turn.turnId)}`,
    );
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThan(0);
  } finally {
    await rt.close(session);
  }
}, 90_000);
```

- [ ] **Step 3: Confirm Nexus endpoint path**

The IPC history URL above is illustrative. Before running, verify the actual path against the running Nexus instance (try `/api/v2/ipc/events`, `/api/v2/ipc/history`, or whatever the current Nexus version exposes). Adjust the test to whatever the real endpoint returns.

- [ ] **Step 4: Run**

Start Nexus:
```bash
# Use the nexus-stack skill or equivalent fixture script.
```
Run: `bun test tests/e2e/acp-stream-nexus.e2e.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/acp-stream-nexus.e2e.test.ts
git commit -m "test(e2e): acp stream publishes typed messages into Nexus"
```

---

## Task 13: Remove dead `onOutput` code + lint

**Files:**
- Modify: any remaining `onOutput` references

- [ ] **Step 1: Verify no stale references**

Run: `rg -n "onOutput" src tests 2>&1`
Expected: no matches (or matches only in migration history files — remove any stragglers).

- [ ] **Step 2: Run full test suite + biome**

Run: `bun test && bun run biome check src tests`
Expected: all tests pass; biome clean.

- [ ] **Step 3: Run typecheck**

Run: `bun run tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit cleanup (if any)**

```bash
git add -A
git commit -m "chore: remove stale onOutput references"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Replace `onOutput` with typed streams | Tasks 5–9, 13 |
| Consume acpx NDJSON centrally | Tasks 3, 7 |
| Persist typed records in Nexus | Task 10 (publish); store schema changes deferred to follow-up — see Open Questions |
| Forward-compat `raw` escape hatch | Task 3 |
| AcpxTurn per prompt | Tasks 5–7 |
| AgentSession metadata unchanged | Task 6 (only `send` signature changes) |
| Unit tests for parser, compact, types, turn | Tasks 1, 3, 4, 5 |
| Component tests for AcpxRuntime | Task 7 |
| Integration test real acpx | Task 11 |
| E2E Nexus-backed | Task 12 |
| Fixtures | Task 2 |

Gaps flagged:
- Nexus store schema change is not yet a task — Task 10 publishes events; whether the store needs new columns/tables (vs. storing payload as JSON blob) depends on the current Nexus store shape. Before starting this plan, confirm with the user whether we ship schema change in this plan or defer to a follow-up issue.

**Placeholder scan:** Every step carries concrete code or a concrete command. No "TBD" or "handle edge cases". Illustrative Nexus URL in Task 12 is flagged for verification in Step 3 — not a placeholder in the sense of "fill in later", but a real "verify against running system" step.

**Type consistency:** `AcpxTurn` shape referenced in Tasks 5, 6, 7, 8, 9, 10 matches the `types.ts` definition from Task 1. `Message` kinds used in tests match the union. `parseAcpLine` signature matches its usage in Task 3. `AcpParser` constructor args match in Task 3 and the `AcpxTurnImpl` usage in Task 5.

---

## Open questions before kickoff

1. **Nexus store schema** — will typed events be stored as opaque JSON payload, or do we want `turn_id`/`tool_call_id` indexed columns? If indexed, add a schema-migration task here before Task 10.
2. **acpx version floor** — `isAvailable` already gates on 0.5.3 for `sessions new` reliability; confirm `--json-strict` is present there or bump floor.
3. **GitHub issues per task** — per `feedback_design_review_to_actions`, convert each numbered task (or task cluster) into its own GitHub issue after plan approval.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-16-acp-typed-message-streams.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
