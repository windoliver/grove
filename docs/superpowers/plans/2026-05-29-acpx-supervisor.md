# AcpxSupervisor Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a grove-owned registry of single-child `AcpRuntime` handles with death-detection, respawn, best-effort auto-resume (respawn-as-new), and `SessionLost` surfacing on `AgentTask`, then adopt it in `selectRuntime` — closing issue [#273](https://github.com/windoliver/grove/issues/273).

**Architecture:** A new `AcpxSupervisor` decorates the `AgentRuntime` interface, owning one single-child `AcpRuntime` per logical slot. `AcpRuntime` gains a death-detection seam (`onDisconnect` + `AgentDisconnectedError`) fed by a new exit signal on `LaunchResult`. The supervisor stamps a monotonic per-slot `seq` by **wrapping each child runtime's ACP event sink** (`setAcpEventSink`) — the verified production event path is `AcpRuntime.emitAcpEvent` → eventSink → `AcpSessionStore` (`src/tui/spawn-manager.ts:297`); `publishTurnToNexus` has **no production caller** today, so seq lives at the eventSink, not the publisher. A thin wiring layer translates supervisor respawn events into `AgentTask` conditions (`Resuming`/`SessionLost`). `selectRuntime` wraps the constructed runtime in the supervisor behind `GROVE_SUPERVISOR`.

**Tech Stack:** Bun 1.3.x, `bun:test`, TypeScript strict (no `any`/`!`/`@ts-ignore`, `import type`, `.js` import extensions, `as const` over enums, explicit return types on exports), Biome. Design doc: `docs/superpowers/specs/2026-05-29-acpx-supervisor-design.md`.

**Conventions (verified):** Tests co-located `*.test.ts`, `import { describe, expect, test } from "bun:test";`. Run a single file with `bun test path/to/file.test.ts`. Full suite: `bun test --timeout 60000`. Typecheck: `bun run typecheck`. Lint: `bun run check`. In-process ACP agents use the `makeInProcessAgent` helper pattern (`src/core/acp-runtime.spawn.test.ts:27`).

---

## File Structure

**Create:**
- `src/core/acpx-supervisor.ts` — `AcpxSupervisor`, `AcpxKey`, `AcpxRegistryEntry`, `AcpxRespawnEvent`, `AcpxSupervisorOptions`.
- `src/core/acpx-supervisor.test.ts` — registry lifecycle (P2).
- `src/core/acpx-supervisor.respawn.test.ts` — respawn + seq continuity (P3).
- `src/core/acpx-test-support.ts` — shared in-process + disconnectable `LaunchOverride` helpers (extracted from the spawn test).
- `src/core/runtime-adapter-matrix.ts` — shared `runRuntimeAdapterMatrix(label, factory)` (#210, P2).
- `src/core/runtime-adapter-matrix.test.ts` — runs the matrix over Mock + Acp + Supervisor.
- `src/core/acp-runtime.disconnect.test.ts` — death-detection seam (P1).
- `src/server/acpx-supervisor-wiring.ts` — subscribes `onRespawn` → patches `AgentTask` (P4).
- `src/server/acpx-supervisor-wiring.test.ts` — wiring tests (P4).
- `tests/e2e/acpx-supervisor-respawn-tmux.ts` — real-process kill-PID E2E (P5).

**Modify:**
- `src/core/agent-runtime.ts` — export `AgentDisconnectedError`; add optional `onDisconnect?` to `AgentRuntime`.
- `src/core/acp-runtime.ts` — extend `LaunchResult` with exit signal; wire `launchSubprocess` child `exit`; add `onDisconnect`; reject in-flight `send` on unexpected exit; add optional `seq?` to `AcpRuntimeEvent`.
- `src/core/select-runtime.ts` — wrap the runtime in `AcpxSupervisor` behind `GROVE_SUPERVISOR` (P5).
- `src/core/agent-task.ts` — add `Resuming`, `SessionLost` to `AgentTaskConditionType`.
- `src/core/task-controller.ts` — export `upsertCondition` for reuse by the wiring layer.
- `src/core/acp-runtime.spawn.test.ts` — import the extracted in-process helper from `acpx-test-support.ts`.

---

## Phase 1 — Death-detection seam in `AcpRuntime`

**Why first:** the supervisor's respawn trigger (P3) subscribes to this. Today `launchSubprocess` keeps `child` local and returns only `{ clientStream, dispose }` (`src/core/acp-runtime.ts:34-37, 343-502`); the only exit handling is `dispose()`'s `waitForChildExit` during intentional teardown. The session entry never observes an *unexpected* exit. We add an exit signal to `LaunchResult` and a runtime-level `onDisconnect`.

### Task 1.1: `AgentDisconnectedError`

**Files:**
- Modify: `src/core/agent-runtime.ts`
- Test: `src/core/acp-runtime.disconnect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/acp-runtime.disconnect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentDisconnectedError } from "./agent-runtime.js";

describe("AgentDisconnectedError", () => {
  test("carries session/role/exit info and a readable message", () => {
    const err = new AgentDisconnectedError({
      sessionId: "grove-coder-0--abc",
      role: "coder",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.info.sessionId).toBe("grove-coder-0--abc");
    expect(err.info.role).toBe("coder");
    expect(err.info.signal).toBe("SIGKILL");
    expect(err.message).toContain("coder");
    expect(err.message).toContain("grove-coder-0--abc");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/acp-runtime.disconnect.test.ts`
Expected: FAIL — `AgentDisconnectedError` is not exported from `agent-runtime.js`.

- [ ] **Step 3: Add the class + interface hook**

Append to `src/core/agent-runtime.ts`:

```ts
/** Thrown when an agent subprocess exits unexpectedly (not via close()). */
export class AgentDisconnectedError extends Error {
  constructor(
    readonly info: {
      readonly sessionId: string;
      readonly role: string;
      readonly exitCode?: number | null | undefined;
      readonly signal?: NodeJS.Signals | null | undefined;
      readonly lastRequestId?: string | undefined;
    },
  ) {
    super(`agent ${info.role} (${info.sessionId}) disconnected`);
    this.name = "AgentDisconnectedError";
  }
}
```

Add the optional hook to the `AgentRuntime` interface (after `onIdle`):

```ts
  /**
   * Register a callback for unexpected agent death (subprocess exit / connection
   * EOF that did not originate from close()). Optional: runtimes without
   * subprocess lifecycles (MockRuntime) may omit it.
   */
  onDisconnect?(session: AgentSession, callback: (err: AgentDisconnectedError) => void): void;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/acp-runtime.disconnect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runtime.ts src/core/acp-runtime.disconnect.test.ts
git commit -m "feat(runtime): AgentDisconnectedError + onDisconnect hook (#273)"
```

### Task 1.2: Exit signal on `LaunchResult` + disconnect detection

**Files:**
- Modify: `src/core/acp-runtime.ts` (`LaunchResult`, `launchSubprocess`, `AcpSessionEntry`, `spawn`, `send`, `onDisconnect`)
- Test: `src/core/acp-runtime.disconnect.test.ts`

**Background:** The in-process test agent (`makeInProcessAgent`, `src/core/acp-runtime.spawn.test.ts:27`) returns a `LaunchResult` with no child process. To test disconnect without real subprocesses, `LaunchResult` gains an optional `onExit(listener)` registration; `launchSubprocess` wires it to the real child's `"exit"`, and the test stub exposes a manual trigger.

- [ ] **Step 1: Write the failing test**

Add to `src/core/acp-runtime.disconnect.test.ts`:

```ts
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { AcpRuntime, type LaunchOverride, type LaunchResult } from "./acp-runtime.js";

function makeDisconnectableAgent(): {
  launchOverride: LaunchOverride;
  triggerExit: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void;
} {
  const exitListeners: Array<
    (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void
  > = [];
  const launchOverride: LaunchOverride = async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const agentStream = ndJsonStream(toClient.writable, toAgent.readable);
    const clientStream = ndJsonStream(toAgent.writable, toClient.readable);
    const agent: Agent = {
      async initialize() {
        return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
      },
      async newSession() {
        return { sessionId: `wire-${exitListeners.length}` };
      },
      async prompt() {
        await new Promise(() => undefined); // never resolves until disconnect
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async authenticate() {
        return {};
      },
    };
    void new AgentSideConnection(() => agent, agentStream);
    const result: LaunchResult = {
      clientStream,
      dispose: async () => {},
      onExit: (listener) => exitListeners.push(listener),
    };
    return result;
  };
  return {
    launchOverride,
    triggerExit: (info) => {
      for (const l of exitListeners) l(info);
    },
  };
}

describe("AcpRuntime disconnect detection", () => {
  test("onDisconnect fires once with AgentDisconnectedError on unexpected exit", async () => {
    const { launchOverride, triggerExit } = makeDisconnectableAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", { role: "coder", command: "codex", cwd: process.cwd() });

    const seen: AgentDisconnectedError[] = [];
    rt.onDisconnect(session, (err) => seen.push(err));

    triggerExit({ exitCode: null, signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AgentDisconnectedError);
    expect(seen[0]?.info.role).toBe("coder");
    expect(seen[0]?.info.signal).toBe("SIGKILL");
    expect((await rt.listSessions())[0]?.status).toBe("crashed");
  });

  test("onDisconnect does NOT fire on intentional close()", async () => {
    const { launchOverride, triggerExit } = makeDisconnectableAgent();
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", { role: "coder", command: "codex", cwd: process.cwd() });
    const seen: AgentDisconnectedError[] = [];
    rt.onDisconnect(session, (err) => seen.push(err));

    await rt.close(session);
    triggerExit({ exitCode: 0, signal: null }); // exit AFTER close — must be ignored
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/acp-runtime.disconnect.test.ts`
Expected: FAIL — `onExit` not on `LaunchResult`; `rt.onDisconnect` not a function.

- [ ] **Step 3: Extend `LaunchResult` and wire the child exit**

In `src/core/acp-runtime.ts`, extend the interface (around line 34):

```ts
export interface LaunchResult {
  readonly clientStream: Stream;
  readonly dispose: () => Promise<void>;
  /**
   * Register a listener fired when the underlying agent process exits.
   * Real subprocesses wire this to the child's "exit" event; in-process test
   * launchers expose a manual trigger. Optional for backward compatibility.
   */
  readonly onExit?: (
    listener: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void,
  ) => void;
}
```

In `launchSubprocess` (just before `const dispose = async () => {` at line ~472), collect listeners and wire the child:

```ts
  const exitListeners: Array<
    (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void
  > = [];
  child.once("exit", (code, signal) => {
    for (const l of exitListeners) l({ exitCode: code, signal });
  });
```

and change the final `return { clientStream, dispose };` (line ~501) to:

```ts
  return {
    clientStream,
    dispose,
    onExit: (listener) => exitListeners.push(listener),
  };
```

- [ ] **Step 4: Implement `onDisconnect` + crash handling in `AcpRuntime`**

Add two fields to `AcpSessionEntry` (around line 84, after `closed`):

```ts
  disconnectCallbacks: ((err: AgentDisconnectedError) => void)[];
  rejectInFlight: ((err: AgentDisconnectedError) => void) | null;
```

Merge the import at line 28: `import { AgentDisconnectedError, type AgentConfig, type AgentRuntime, type AgentSession } from "./agent-runtime.js";`

Initialize the two new fields in the `this.sessions.set(id, {...})` block in `spawn()` (around line 791): add `disconnectCallbacks: [], rejectInFlight: null,`.

In `spawn()`, immediately after `this.fireSessionWrite("ADDED", session);` (line ~802), register the exit handler:

```ts
    launched.onExit?.((info) => {
      const current = this.sessions.get(id);
      if (!current || current.closed) return; // intentional close() sets closed=true first
      const err = new AgentDisconnectedError({
        sessionId: id,
        role,
        exitCode: info.exitCode,
        signal: info.signal,
      });
      current.session = withSessionStatus(current.session, "crashed", err.message);
      this.fireSessionWrite("MODIFIED", current.session);
      current.rejectInFlight?.(err);
      for (const cb of current.disconnectCallbacks) {
        try {
          cb(err);
        } catch {
          /* ignore */
        }
      }
    });
```

Add the public method next to `onIdle` (around line 985):

```ts
  onDisconnect(session: AgentSession, callback: (err: AgentDisconnectedError) => void): void {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.disconnectCallbacks.push(callback);
  }
```

Wire `rejectInFlight` so a mid-turn death rejects the in-flight prompt. In `send()`'s `mine` IIFE (the `try` at line ~908), race the prompt against a disconnect rejecter:

```ts
      const disconnectRace = new Promise<never>((_, reject) => {
        entry.rejectInFlight = (err) => reject(err);
      });
      try {
        const ok = await Promise.race([
          entry.connection.prompt({
            sessionId: entry.wireSessionId,
            prompt: [{ type: "text", text: message }],
          }),
          disconnectRace,
        ]);
        finishTurn({ turnId, stopReason: ok.stopReason });
      } catch (err) {
        const m = acpErrorMessage(err);
        finishTurn({ turnId, stopReason: "error", error: { code: "prompt_rejected", message: m } });
      } finally {
        entry.rejectInFlight = null;
        if (entry.currentTurn === turn) entry.currentTurn = null;
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      }
```

(This replaces the existing `try/catch/finally` body; keep the idle-callback loop intact.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/core/acp-runtime.disconnect.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Regression — existing runtime tests stay green**

Run: `bun test src/core/acp-runtime.spawn.test.ts src/core/acp-runtime.test.ts`
Expected: PASS (close() still bounded; status transitions intact; the `close cancels an in-flight prompt` test still resolves `cancelled`).

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck && bun run check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/acp-runtime.ts src/core/acp-runtime.disconnect.test.ts
git commit -m "feat(runtime): detect unexpected acpx exit, reject in-flight send (#273)"
```

---

## Phase 2 — Supervisor registry core + adapter matrix

### Task 2.1: Extract shared in-process launch helper

**Files:**
- Create: `src/core/acpx-test-support.ts`
- Modify: `src/core/acp-runtime.spawn.test.ts`

- [ ] **Step 1: Extract**

Move the `AgentStubHandlers` type and the body of `makeInProcessAgent` (`src/core/acp-runtime.spawn.test.ts:15-76`) into `src/core/acpx-test-support.ts`, exported as:

```ts
export interface AgentStubHandlers { /* ...verbatim from the spawn test... */ }
export function makeInProcessAgent(handlers?: AgentStubHandlers): {
  launchOverride: LaunchOverride;
  ref: { agentSide: AgentSideConnection | null };
};
/** Convenience: just the override, for tests that don't need the agent ref. */
export function makeInProcessLaunchOverride(handlers?: AgentStubHandlers): LaunchOverride {
  return makeInProcessAgent(handlers).launchOverride;
}
```

In `acp-runtime.spawn.test.ts`, delete the moved code and `import { makeInProcessAgent } from "./acpx-test-support.js";`.

- [ ] **Step 2: Run the moved tests**

Run: `bun test src/core/acp-runtime.spawn.test.ts`
Expected: PASS (unchanged behavior, now importing the helper).

- [ ] **Step 3: Commit**

```bash
git add src/core/acpx-test-support.ts src/core/acp-runtime.spawn.test.ts
git commit -m "test(runtime): extract in-process ACP launch helper (#273)"
```

### Task 2.2: Shared runtime adapter matrix (#210)

**Files:**
- Create: `src/core/runtime-adapter-matrix.ts`
- Create: `src/core/runtime-adapter-matrix.test.ts`

- [ ] **Step 1: Write the matrix harness**

Create `src/core/runtime-adapter-matrix.ts`:

```ts
import { expect, test } from "bun:test";
import type { AgentRuntime } from "./agent-runtime.js";

/**
 * Shared conformance matrix every AgentRuntime must satisfy (#210). Call inside
 * a describe() block. The factory must return a fresh, isolated runtime per call.
 */
export function runRuntimeAdapterMatrix(label: string, factory: () => AgentRuntime): void {
  const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

  test(`${label}: spawn returns a running session`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    expect(s.role).toBe("coder");
    expect(s.status).toBe("running");
    await rt.close(s);
  });

  test(`${label}: listSessions reflects spawn then close`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    expect((await rt.listSessions()).some((x) => x.id === s.id)).toBe(true);
    await rt.close(s);
    expect((await rt.listSessions()).some((x) => x.id === s.id)).toBe(false);
  });

  test(`${label}: distinct spawns get distinct ids`, async () => {
    const rt = factory();
    const a = await rt.spawn("coder", cfg);
    const b = await rt.spawn("coder", cfg);
    expect(a.id).not.toBe(b.id);
    await rt.close(a);
    await rt.close(b);
  });

  test(`${label}: send returns a typed AcpxTurn that resolves`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    const turn = await rt.send(s, "hello");
    expect(turn.sessionId).toBeDefined();
    for await (const _ of turn.messages) {
      /* drain */
    }
    const result = await turn.result;
    expect(typeof result.stopReason).toBe("string");
    await rt.close(s);
  });

  test(`${label}: close is idempotent`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    await rt.close(s);
    await rt.close(s); // must not throw
    expect(true).toBe(true);
  });

  test(`${label}: listSessionEntities returns AgentSession entities`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    const entities = await rt.listSessionEntities();
    expect(entities.every((e) => e.kind === "AgentSession")).toBe(true);
    await rt.close(s);
  });
}
```

- [ ] **Step 2: Run matrix against Mock + Acp**

Create `src/core/runtime-adapter-matrix.test.ts`:

```ts
import { describe } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { makeInProcessLaunchOverride } from "./acpx-test-support.js";
import { MockRuntime } from "./mock-runtime.js";
import { runRuntimeAdapterMatrix } from "./runtime-adapter-matrix.js";

describe("runtime adapter matrix", () => {
  runRuntimeAdapterMatrix("MockRuntime", () => new MockRuntime());
  runRuntimeAdapterMatrix(
    "AcpRuntime",
    () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
  );
});
```

Run: `bun test src/core/runtime-adapter-matrix.test.ts`
Expected: PASS (all rows for Mock + Acp).

- [ ] **Step 3: Commit**

```bash
git add src/core/runtime-adapter-matrix.ts src/core/runtime-adapter-matrix.test.ts
git commit -m "test(runtime): shared runtime adapter conformance matrix (#210, #273)"
```

### Task 2.3: `AcpxSupervisor` registry core

**Files:**
- Create: `src/core/acpx-supervisor.ts`
- Create: `src/core/acpx-supervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/acpx-supervisor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { makeInProcessLaunchOverride } from "./acpx-test-support.js";
import { AcpxSupervisor, type AcpxKey } from "./acpx-supervisor.js";

function makeSupervisor(): AcpxSupervisor {
  return new AcpxSupervisor({
    runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
  });
}

const key: AcpxKey = { slotId: "task-1", backend: "codex", cwd: process.cwd() };
const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

describe("AcpxSupervisor registry", () => {
  test("ensure spawns one entry and is idempotent for the same slot", async () => {
    const sup = makeSupervisor();
    const a = await sup.ensure(key, cfg);
    const b = await sup.ensure(key, cfg);
    expect(b).toBe(a);
    expect(sup.list()).toHaveLength(1);
    expect(a.phase).toBe("running");
    expect(a.acpxRecordId).toBeDefined();
    await sup.stop(key.slotId, "test cleanup");
  });

  test("concurrent ensure for the same slot coalesces to one entry", async () => {
    const sup = makeSupervisor();
    const [a, b] = await Promise.all([sup.ensure(key, cfg), sup.ensure(key, cfg)]);
    expect(a).toBe(b);
    expect(sup.list()).toHaveLength(1);
    await sup.stop(key.slotId, "cleanup");
  });

  test("distinct slots get distinct entries and children", async () => {
    const sup = makeSupervisor();
    const a = await sup.ensure(key, cfg);
    const b = await sup.ensure({ ...key, slotId: "task-2" }, cfg);
    expect(a.acpxRecordId).not.toBe(b.acpxRecordId);
    expect(a.session.id).not.toBe(b.session.id);
    expect(sup.list()).toHaveLength(2);
    await sup.stop("task-1", "cleanup");
    await sup.stop("task-2", "cleanup");
  });

  test("get returns the entry; stop terminates and removes it", async () => {
    const sup = makeSupervisor();
    await sup.ensure(key, cfg);
    expect(sup.get(key.slotId)).toBeDefined();
    await sup.stop(key.slotId, "done");
    expect(sup.get(key.slotId)).toBeUndefined();
    expect(sup.list()).toHaveLength(0);
  });

  test("AgentRuntime façade: spawn routes to ensure, listSessions reflects entries", async () => {
    const sup = makeSupervisor();
    const session = await sup.spawn("coder", cfg);
    expect((await sup.listSessions()).some((s) => s.id === session.id)).toBe(true);
    await sup.close(session);
    expect((await sup.listSessions()).some((s) => s.id === session.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/acpx-supervisor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry core**

Create `src/core/acpx-supervisor.ts`:

```ts
import type { AcpxTurn } from "../acp/types.js";
import { AcpRuntime, type AcpRuntimeEvent, type AcpRuntimeEventSink } from "./acp-runtime.js";
import {
  AgentDisconnectedError,
  type AgentConfig,
  type AgentRuntime,
  type AgentSession,
} from "./agent-runtime.js";
import type { AgentSessionEntity } from "./entity.js";

export interface AcpxKey {
  readonly slotId: string;
  readonly backend: "claude-code" | "codex" | "gemini";
  readonly cwd: string;
  readonly sessionName?: string | undefined;
}

export type AcpxPhase = "starting" | "running" | "resuming" | "dead";

export interface AcpxRegistryEntry {
  readonly key: AcpxKey;
  handle: AcpRuntime;
  readonly acpxRecordId: string;
  session: AgentSession;
  lastSeq: number;
  lastRequestId?: string | undefined;
  phase: AcpxPhase;
  respawns: number;
}

export type AcpxRespawnEvent =
  | { kind: "resuming"; key: AcpxKey; acpxRecordId: string; deadSessionId: string; respawns: number }
  | { kind: "resumed"; key: AcpxKey; acpxRecordId: string; newSessionId: string; lastSeq: number }
  | { kind: "dead"; key: AcpxKey; acpxRecordId: string; reason: string; respawns: number };

export interface AcpxSupervisorOptions {
  readonly runtimeFactory?: () => AcpRuntime;
  readonly maxRespawns?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly mintRecordId?: (() => string) | undefined;
}

const DEFAULT_MAX_RESPAWNS = 5;
const DEFAULT_BACKOFF_BASE_MS = 250;

export class AcpxSupervisor implements AgentRuntime {
  readonly sendsInitialPromptOnSpawn = true;

  private readonly registry = new Map<string, AcpxRegistryEntry>();
  private readonly inflight = new Map<string, Promise<AcpxRegistryEntry>>();
  private readonly configs = new Map<string, AgentConfig>();
  private readonly respawnListeners: ((e: AcpxRespawnEvent) => void)[] = [];
  private readonly runtimeFactory: () => AcpRuntime;
  private readonly maxRespawns: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mintRecordId: () => string;
  private downstreamSink: AcpRuntimeEventSink | undefined;
  private counter = 0;

  constructor(options: AcpxSupervisorOptions = {}) {
    this.runtimeFactory = options.runtimeFactory ?? (() => new AcpRuntime());
    this.maxRespawns = options.maxRespawns ?? DEFAULT_MAX_RESPAWNS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.mintRecordId = options.mintRecordId ?? (() => `acpx-rec-${this.counter++}`);
  }

  onRespawn(cb: (event: AcpxRespawnEvent) => void): void {
    this.respawnListeners.push(cb);
  }

  private emit(event: AcpxRespawnEvent): void {
    for (const l of this.respawnListeners) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  }

  async ensure(key: AcpxKey, config: AgentConfig): Promise<AcpxRegistryEntry> {
    const existing = this.registry.get(key.slotId);
    if (existing && existing.phase !== "dead") return existing;
    const pending = this.inflight.get(key.slotId);
    if (pending) return pending;
    const promise = this.spawnEntry(key, config).finally(() => this.inflight.delete(key.slotId));
    this.inflight.set(key.slotId, promise);
    return promise;
  }

  private async spawnEntry(key: AcpxKey, config: AgentConfig): Promise<AcpxRegistryEntry> {
    const handle = this.runtimeFactory();
    const session = await handle.spawn(config.role, config);
    const entry: AcpxRegistryEntry = {
      key,
      handle,
      acpxRecordId: this.mintRecordId(),
      session,
      lastSeq: 0,
      phase: "running",
      respawns: 0,
    };
    this.registry.set(key.slotId, entry);
    this.configs.set(key.slotId, config);
    this.wireSink(entry);
    this.attachDisconnect(entry);
    return entry;
  }

  // seq stamping (Phase 3, Task 3.1) wraps the child sink here.
  private wireSink(entry: AcpxRegistryEntry): void {
    entry.handle.setAcpEventSink((event: AcpRuntimeEvent) => {
      const seq = entry.lastSeq;
      entry.lastSeq += 1;
      this.downstreamSink?.({ ...event, seq });
    });
  }

  private attachDisconnect(entry: AcpxRegistryEntry): void {
    entry.handle.onDisconnect?.(entry.session, (err) => {
      void this.handleDisconnect(entry, err);
    });
  }

  // Respawn logic lands in Phase 3. For P2, a disconnect just marks the slot dead.
  private async handleDisconnect(
    entry: AcpxRegistryEntry,
    _err: AgentDisconnectedError,
  ): Promise<void> {
    entry.phase = "dead";
    this.emit({
      kind: "dead",
      key: entry.key,
      acpxRecordId: entry.acpxRecordId,
      reason: "disconnected",
      respawns: entry.respawns,
    });
  }

  get(slotId: string): AcpxRegistryEntry | undefined {
    return this.registry.get(slotId);
  }

  list(): readonly AcpxRegistryEntry[] {
    return [...this.registry.values()];
  }

  async stop(slotId: string, _reason: string): Promise<void> {
    const entry = this.registry.get(slotId);
    if (!entry) return;
    this.registry.delete(slotId);
    this.configs.delete(slotId);
    await entry.handle.close(entry.session);
  }

  // --- AgentRuntime façade ---

  private slotIdForSession(sessionId: string): string | undefined {
    for (const [slotId, entry] of this.registry) {
      if (entry.session.id === sessionId) return slotId;
    }
    return undefined;
  }

  setAcpEventSink(sink: AcpRuntimeEventSink | undefined): void {
    this.downstreamSink = sink;
  }

  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const key: AcpxKey = {
      slotId: `${role}-${this.counter++}`,
      backend: platformToBackend(config.platform),
      cwd: config.cwd,
    };
    const entry = await this.ensure(key, config);
    return entry.session;
  }

  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    if (!entry) throw new Error(`AcpxSupervisor.send: no slot for session ${session.id}`);
    return entry.handle.send(entry.session, message);
  }

  async close(session: AgentSession): Promise<void> {
    const slotId = this.slotIdForSession(session.id);
    if (slotId) await this.stop(slotId, "close");
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    entry?.handle.onIdle(entry.session, callback);
  }

  onDisconnect(session: AgentSession, callback: (err: AgentDisconnectedError) => void): void {
    const slotId = this.slotIdForSession(session.id);
    const entry = slotId ? this.registry.get(slotId) : undefined;
    entry?.handle.onDisconnect?.(entry.session, callback);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.registry.values()].map((e) => e.session);
  }

  async listSessionEntities(): Promise<readonly AgentSessionEntity[]> {
    const all = await Promise.all(
      [...this.registry.values()].map((e) => e.handle.listSessionEntities()),
    );
    return all.flat();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function platformToBackend(platform: AgentConfig["platform"]): AcpxKey["backend"] {
  if (platform === "claude-code") return "claude-code";
  if (platform === "gemini") return "gemini";
  return "codex";
}
```

> Note: `wireSink` references `entry.lastSeq` for seq (full respawn-continuity test lands in Task 3.x). It is included now so the sink is wired from the start; P2 tests don't assert seq yet.

- [ ] **Step 4: Add optional `seq` to `AcpRuntimeEvent`**

In `src/core/acp-runtime.ts`, add `readonly seq?: number | undefined;` to BOTH variants of the `AcpRuntimeEvent` union (the `"message"` and `"result"` objects, lines ~53-65). This lets the supervisor stamp seq without breaking existing sinks (field is optional).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/core/acpx-supervisor.test.ts`
Expected: PASS.

- [ ] **Step 6: Add supervisor to the adapter matrix**

Append to `src/core/runtime-adapter-matrix.test.ts` inside the describe, and add `import { AcpxSupervisor } from "./acpx-supervisor.js";`:

```ts
  runRuntimeAdapterMatrix(
    "AcpxSupervisor",
    () =>
      new AcpxSupervisor({
        runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
      }),
  );
```

Run: `bun test src/core/runtime-adapter-matrix.test.ts`
Expected: PASS for Mock, Acp, AcpxSupervisor (#210 satisfied).

- [ ] **Step 7: Typecheck + lint + commit**

```bash
bun run typecheck && bun run check
git add src/core/acpx-supervisor.ts src/core/acpx-supervisor.test.ts src/core/runtime-adapter-matrix.test.ts src/core/acp-runtime.ts
git commit -m "feat(runtime): AcpxSupervisor registry core + matrix row (#273)"
```

---

## Phase 3 — Respawn + auto-resume + seq continuity

**Seq mechanism (verified production path):** there is **no production caller of `publishTurnToNexus`**; agent output reaches consumers via `AcpRuntime.emitAcpEvent` → the eventSink set at `src/tui/spawn-manager.ts:297`. So the supervisor stamps `seq` in `wireSink` (Task 2.3) by wrapping each child's `setAcpEventSink`. Because `entry.lastSeq` lives on the registry entry and is carried across respawn, the sequence never resets. Phase 3 makes respawn real and proves seq continuity.

### Task 3.1: `makeDisconnectableLaunchOverride` shared helper

**Files:**
- Modify: `src/core/acpx-test-support.ts`

- [ ] **Step 1: Add the helper**

Generalize Task 1.2's `makeDisconnectableAgent` into `src/core/acpx-test-support.ts`:

```ts
export function makeDisconnectableLaunchOverride(): {
  launchOverride: LaunchOverride;
  onTrigger: (cb: (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void) => void;
};
```

It returns a `launchOverride` whose every spawned process registers an exit trigger, and `onTrigger(cb)` lets the test capture each trigger as runtimes are created (so the respawn tests can fire the Nth child's exit). The prompt handler never resolves (so a kill is the only way a turn ends).

- [ ] **Step 2: Commit**

```bash
git add src/core/acpx-test-support.ts
git commit -m "test(runtime): disconnectable launch override helper (#273)"
```

### Task 3.2: Respawn cycle + backoff + dead cap

**Files:**
- Modify: `src/core/acpx-supervisor.ts`
- Create: `src/core/acpx-supervisor.respawn.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/acpx-supervisor.respawn.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { makeDisconnectableLaunchOverride } from "./acpx-test-support.js";
import { AcpxSupervisor, type AcpxKey, type AcpxRespawnEvent } from "./acpx-supervisor.js";

const key: AcpxKey = { slotId: "task-1", backend: "codex", cwd: process.cwd() };
const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

function build(maxRespawns = 5) {
  const triggers: Array<(info: { signal: NodeJS.Signals }) => void> = [];
  const sup = new AcpxSupervisor({
    maxRespawns,
    backoffBaseMs: 0,
    sleep: async () => {},
    runtimeFactory: () => {
      const { launchOverride, onTrigger } = makeDisconnectableLaunchOverride();
      onTrigger((t) => triggers.push(t));
      return new AcpRuntime({ launchOverride });
    },
  });
  return { sup, triggers };
}

describe("AcpxSupervisor respawn", () => {
  test("disconnect drives running -> resuming -> running with a fresh session", async () => {
    const { sup, triggers } = build();
    const events: AcpxRespawnEvent[] = [];
    sup.onRespawn((e) => events.push(e));
    const entry = await sup.ensure(key, cfg);
    const firstSessionId = entry.session.id;

    triggers[0]?.({ signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 30));

    const after = sup.get(key.slotId);
    expect(after?.phase).toBe("running");
    expect(after?.session.id).not.toBe(firstSessionId);
    expect(events.map((e) => e.kind)).toEqual(["resuming", "resumed"]);
    await sup.stop(key.slotId, "cleanup");
  });

  test("lastSeq is preserved across respawn (no reset)", async () => {
    const { sup, triggers } = build();
    const entry = await sup.ensure(key, cfg);
    entry.lastSeq = 42;
    triggers[0]?.({ signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sup.get(key.slotId)?.lastSeq).toBe(42);
    await sup.stop(key.slotId, "cleanup");
  });

  test("after maxRespawns the slot becomes dead", async () => {
    const { sup, triggers } = build(2);
    const events: AcpxRespawnEvent[] = [];
    sup.onRespawn((e) => events.push(e));
    await sup.ensure(key, cfg);
    for (let i = 0; i < 3; i++) {
      triggers[triggers.length - 1]?.({ signal: "SIGKILL" });
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(sup.get(key.slotId)?.phase).toBe("dead");
    expect(events.some((e) => e.kind === "dead")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/core/acpx-supervisor.respawn.test.ts`
Expected: FAIL — `handleDisconnect` only marks dead (no resume).

- [ ] **Step 3: Implement respawn in `handleDisconnect`**

Replace the P2 stub with:

```ts
  private async handleDisconnect(
    entry: AcpxRegistryEntry,
    _err: AgentDisconnectedError,
  ): Promise<void> {
    if (entry.phase !== "running") return;
    const config = this.configs.get(entry.key.slotId);
    if (!config) return;

    entry.phase = "resuming";
    this.emit({
      kind: "resuming",
      key: entry.key,
      acpxRecordId: entry.acpxRecordId,
      deadSessionId: entry.session.id,
      respawns: entry.respawns,
    });

    try {
      await entry.handle.close(entry.session);
    } catch {
      /* dead child; ignore */
    }

    if (entry.respawns >= this.maxRespawns) {
      entry.phase = "dead";
      this.emit({
        kind: "dead",
        key: entry.key,
        acpxRecordId: entry.acpxRecordId,
        reason: `exceeded maxRespawns=${this.maxRespawns}`,
        respawns: entry.respawns,
      });
      return;
    }

    await this.sleep(this.backoffBaseMs * 2 ** entry.respawns);
    entry.respawns += 1;

    // Respawn WITHIN the shared runtime (Phase 2 adopted one shared AcpRuntime
    // for all slots — see the design doc's "Implementation note"). A fresh
    // sharedRuntime.spawn() does a fresh session/new ⇒ a NEW wireSessionId,
    // never the dead one (#319). The handle stays `this.sharedRuntime`; only
    // entry.session is replaced. routeEvent() demuxes events by the new
    // session id, so seq stamping continues from the preserved entry.lastSeq
    // with no reset. Re-register onDisconnect for the new session.
    const session = await this.sharedRuntime.spawn(config.role, config);
    entry.session = session;
    entry.phase = "running";
    this.attachDisconnect(entry);
    this.emit({
      kind: "resumed",
      key: entry.key,
      acpxRecordId: entry.acpxRecordId,
      newSessionId: session.id,
      lastSeq: entry.lastSeq,
    });
  }
```

(Mutating `entry` in place keeps `lastSeq`/`acpxRecordId`/`respawns`. There is NO `entry.handle` swap and NO `wireSink` call — the shared runtime's single sink + `routeEvent`/`entryForSession` already re-stamp seq for the new session id from the preserved `entry.lastSeq`.)

- [ ] **Step 4: Run**

Run: `bun test src/core/acpx-supervisor.respawn.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Regression**

Run: `bun test src/core/acpx-supervisor.test.ts src/core/runtime-adapter-matrix.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bun run typecheck && bun run check
git add src/core/acpx-supervisor.ts src/core/acpx-supervisor.respawn.test.ts
git commit -m "feat(runtime): supervisor respawn + auto-resume + backoff (#273)"
```

### Task 3.3: Seq continuity across turns + respawn (eventSink)

**Files:**
- Test: `src/core/acpx-supervisor.respawn.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that installs a downstream sink via `sup.setAcpEventSink`, drives a turn that emits messages through the in-process agent (use `makeInProcessAgent` with an `onPrompt` that calls `agentSide.sessionUpdate(...)`), captures `event.seq`, then triggers a respawn and drives another turn — asserting seq is strictly increasing with **no reset** across the respawn boundary.

```ts
test("seq is monotonic across turns and respawns (eventSink)", async () => {
  const seqs: number[] = [];
  // build a supervisor whose runtimeFactory returns AcpRuntime over a
  // disconnectable+promptable in-process agent; sup.setAcpEventSink((e) => { if (e.seq !== undefined) seqs.push(e.seq); });
  // turn 1 emits 2 messages -> seq 0,1,2 (incl result event)
  // trigger disconnect; await respawn
  // turn 2 emits 1 message  -> seq continues (3,4...), never resets to 0
  // expect(seqs).toEqual([...strictly increasing...]);
});
```

Fill the body following Task 2.3's `wireSink` (every `AcpRuntimeEvent` forwarded carries an incrementing `seq`). The in-process agent helper must support both `onPrompt` emission and exit triggering — compose `makeInProcessAgent` handlers with the disconnect trigger, or extend `makeDisconnectableLaunchOverride` to accept an `onPrompt`.

- [ ] **Step 2: Run to verify it fails, then confirm it passes**

The `wireSink` from Task 2.3 already stamps seq; this test proves continuity. If it fails, the bug is that respawn replaces the entry's seq — verify `handleDisconnect` mutates in place (does not reset `lastSeq`).

Run: `bun test src/core/acpx-supervisor.respawn.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/acpx-supervisor.respawn.test.ts
git commit -m "test(runtime): seq continuity across turns + respawn (#273)"
```

---

## Phase 4 — `SessionLost` condition on `AgentTask` + wiring

### Task 4.1: New condition types

**Files:**
- Modify: `src/core/agent-task.ts`
- Test: `src/core/agent-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { AgentTaskConditionType } from "./agent-task.js";
test("AgentTaskConditionType includes Resuming and SessionLost", () => {
  expect(AgentTaskConditionType.Resuming).toBe("Resuming");
  expect(AgentTaskConditionType.SessionLost).toBe("SessionLost");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/core/agent-task.test.ts`
Expected: FAIL — properties undefined.

- [ ] **Step 3: Add the types**

In `src/core/agent-task.ts`, add to the `AgentTaskConditionType` const (after `DoneSignaled`, line ~26):

```ts
  Resuming: "Resuming",
  SessionLost: "SessionLost",
```

- [ ] **Step 4: Run + commit**

Run: `bun test src/core/agent-task.test.ts` → PASS.

```bash
git add src/core/agent-task.ts src/core/agent-task.test.ts
git commit -m "feat(core): Resuming + SessionLost AgentTask conditions (#273)"
```

### Task 4.2: Export `upsertCondition` for reuse

**Files:**
- Modify: `src/core/task-controller.ts`

- [ ] **Step 1:** Change `function upsertCondition(` (line ~500) to `export function upsertCondition(`. Run `bun test src/core/task-controller.test.ts` to confirm no regression.

- [ ] **Step 2: Commit**

```bash
git add src/core/task-controller.ts
git commit -m "refactor(core): export upsertCondition for reuse (#273)"
```

### Task 4.3: Wiring — respawn events → AgentTask conditions

**Files:**
- Create: `src/server/acpx-supervisor-wiring.ts`
- Create: `src/server/acpx-supervisor-wiring.test.ts`

Slot → task mapping: `slotId === task.spec.id`. The patch goes through `AgentTaskStore.patchAgentTaskStatus` (`task-controller.ts:144`), reusing the exported `upsertCondition`.

- [ ] **Step 1: Write the failing test**

Create `src/server/acpx-supervisor-wiring.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTaskConditionType } from "../core/agent-task.js";
import type { AcpxRespawnEvent } from "../core/acpx-supervisor.js";
import { wireSupervisorToTasks } from "./acpx-supervisor-wiring.js";

function fakeStore() {
  const patches: Array<{ id: string; patch: any }> = [];
  return {
    patches,
    store: {
      async patchAgentTaskStatus(id: string, patch: any) {
        patches.push({ id, patch });
      },
      async getAgentTask(id: string) {
        return {
          spec: { id, generation: 1 },
          status: { phase: "Running", conditions: [], observedGeneration: 1 },
        };
      },
    },
  };
}

function fakeSupervisor() {
  const listeners: ((e: AcpxRespawnEvent) => void)[] = [];
  return { onRespawn: (cb: (e: AcpxRespawnEvent) => void) => listeners.push(cb), fire: (e: AcpxRespawnEvent) => listeners.forEach((l) => l(e)) };
}

const baseKey = { slotId: "task-1", backend: "codex" as const, cwd: "." };

describe("acpx supervisor → AgentTask wiring", () => {
  test("resuming sets Resuming=True and keeps the task Running (no phase change)", async () => {
    const { patches, store } = fakeStore();
    const sup = fakeSupervisor();
    wireSupervisorToTasks({ supervisor: sup, taskStore: store, now: () => 0 });
    sup.fire({ kind: "resuming", key: baseKey, acpxRecordId: "r1", deadSessionId: "s0", respawns: 0 });
    await new Promise((r) => setTimeout(r, 0));
    const conds = patches[0]?.patch.conditions as Array<{ type: string; status: string }>;
    expect(conds.some((c) => c.type === AgentTaskConditionType.Resuming && c.status === "True")).toBe(true);
    expect(patches[0]?.patch.phase).toBeUndefined();
  });

  test("resumed sets SessionLost=True, clears Resuming, updates sessionId, keeps Running", async () => {
    const { patches, store } = fakeStore();
    const sup = fakeSupervisor();
    wireSupervisorToTasks({ supervisor: sup, taskStore: store, now: () => 0 });
    sup.fire({ kind: "resumed", key: baseKey, acpxRecordId: "r1", newSessionId: "s1", lastSeq: 7 });
    await new Promise((r) => setTimeout(r, 0));
    const p = patches[0]?.patch;
    const conds = p.conditions as Array<{ type: string; status: string }>;
    expect(conds.some((c) => c.type === AgentTaskConditionType.SessionLost && c.status === "True")).toBe(true);
    expect(conds.some((c) => c.type === AgentTaskConditionType.Resuming && c.status === "False")).toBe(true);
    expect(p.sessionId).toBe("s1");
    expect(p.phase).toBeUndefined();
  });

  test("dead sets Failed and invokes onDead for lease release", async () => {
    const { patches, store } = fakeStore();
    const sup = fakeSupervisor();
    const released: string[] = [];
    wireSupervisorToTasks({ supervisor: sup, taskStore: store, now: () => 0, onDead: async (slotId) => { released.push(slotId); } });
    sup.fire({ kind: "dead", key: baseKey, acpxRecordId: "r1", reason: "crash-loop", respawns: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect(patches[0]?.patch.phase).toBe("Failed");
    expect(released).toEqual(["task-1"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/acpx-supervisor-wiring.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the wiring**

Create `src/server/acpx-supervisor-wiring.ts` exporting `wireSupervisorToTasks(deps)`:

```ts
import { AgentTaskConditionType } from "../core/agent-task.js";
import type { AcpxRespawnEvent } from "../core/acpx-supervisor.js";
import { AgentTaskPhase } from "../core/agent-task.js";
import type { AgentTaskStore } from "../core/store.js";
import { upsertCondition } from "../core/task-controller.js";

export interface SupervisorTaskWiringDeps {
  readonly supervisor: { onRespawn(cb: (e: AcpxRespawnEvent) => void): void };
  readonly taskStore: Pick<AgentTaskStore, "patchAgentTaskStatus" | "getAgentTask">;
  readonly now?: () => number;
  readonly onDead?: (slotId: string) => Promise<void>;
}

export function wireSupervisorToTasks(deps: SupervisorTaskWiringDeps): void {
  const now = deps.now ?? Date.now;
  deps.supervisor.onRespawn((event) => {
    void handle(event).catch(() => {
      /* fire-and-forget; controller resync is the backstop */
    });
  });

  async function handle(event: AcpxRespawnEvent): Promise<void> {
    const slotId = event.key.slotId;
    const task = await deps.taskStore.getAgentTask(slotId);
    if (!task) return;
    const gen = task.spec.generation;
    const ts = new Date(now()).toISOString();
    let conditions = task.status.conditions;

    if (event.kind === "resuming") {
      conditions = upsertCondition(conditions, {
        type: AgentTaskConditionType.Resuming,
        status: "True",
        observedGeneration: gen,
        lastTransitionTime: ts,
        reason: "acpx-disconnected",
        message: `respawn #${event.respawns + 1}`,
      });
      await deps.taskStore.patchAgentTaskStatus(slotId, { conditions });
      return;
    }

    if (event.kind === "resumed") {
      conditions = upsertCondition(
        upsertCondition(conditions, {
          type: AgentTaskConditionType.Resuming,
          status: "False",
          observedGeneration: gen,
          lastTransitionTime: ts,
          reason: "respawned",
          message: "",
        }),
        {
          type: AgentTaskConditionType.SessionLost,
          status: "True",
          observedGeneration: gen,
          lastTransitionTime: ts,
          reason: "respawned",
          message: `new session ${event.newSessionId}`,
        },
      );
      await deps.taskStore.patchAgentTaskStatus(slotId, {
        conditions,
        sessionId: event.newSessionId,
      });
      return;
    }

    // event.kind === "dead"
    conditions = upsertCondition(
      upsertCondition(conditions, {
        type: AgentTaskConditionType.Running,
        status: "False",
        observedGeneration: gen,
        lastTransitionTime: ts,
        reason: "session-lost",
        message: event.reason,
      }),
      {
        type: AgentTaskConditionType.Failed,
        status: "True",
        observedGeneration: gen,
        lastTransitionTime: ts,
        reason: "session-lost",
        message: event.reason,
      },
    );
    await deps.taskStore.patchAgentTaskStatus(slotId, {
      phase: AgentTaskPhase.Failed,
      conditions,
      lastTransitionAt: ts,
    });
    await deps.onDead?.(slotId);
  }
}
```

- [ ] **Step 4: Run + typecheck + lint + commit**

Run: `bun test src/server/acpx-supervisor-wiring.test.ts` → PASS.

```bash
bun run typecheck && bun run check
git add src/server/acpx-supervisor-wiring.ts src/server/acpx-supervisor-wiring.test.ts
git commit -m "feat(server): wire supervisor respawn events to AgentTask conditions (#273)"
```

---

## Phase 5 — Adoption in `selectRuntime` + real-process E2E

### Task 5.1: Adopt the supervisor behind `GROVE_SUPERVISOR`

**Files:**
- Modify: `src/core/select-runtime.ts`
- Test: `src/core/select-runtime.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `src/core/select-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpxSupervisor } from "./acpx-supervisor.js";
import { selectRuntime } from "./select-runtime.js";

describe("selectRuntime supervisor flag", () => {
  test("GROVE_SUPERVISOR=1 wraps the runtime in AcpxSupervisor", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" }, supervisorEnv: { GROVE_SUPERVISOR: "1" } });
    expect(rt).toBeInstanceOf(AcpxSupervisor);
  });

  test("default (flag unset) returns a bare AcpRuntime", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" }, supervisorEnv: {} });
    expect(rt).not.toBeInstanceOf(AcpxSupervisor);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/core/select-runtime.test.ts`
Expected: FAIL — no wrapping; `supervisorEnv` unknown.

- [ ] **Step 3: Implement**

In `src/core/select-runtime.ts`: add `readonly supervisorEnv?: { readonly GROVE_SUPERVISOR?: string | undefined };` to `SelectRuntimeOptions`. After constructing the `AcpRuntime`, wrap it when the flag is set:

```ts
export function selectRuntime(options: SelectRuntimeOptions = {}): AgentRuntime {
  const flag = options.env?.GROVE_RUNTIME ?? process.env.GROVE_RUNTIME;
  const normalized = flag?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "acp") {
    const supervisorFlag =
      options.supervisorEnv?.GROVE_SUPERVISOR ?? process.env.GROVE_SUPERVISOR;
    if (supervisorFlag === "1") {
      return new AcpxSupervisor({ runtimeFactory: () => new AcpRuntime(options.acp) });
    }
    return new AcpRuntime(options.acp);
  }
  throw new Error(
    `[select-runtime] GROVE_RUNTIME=${flag} no longer supported; only "acp" is valid`,
  );
}
```

Add `import { AcpxSupervisor } from "./acpx-supervisor.js";`. Default behavior (flag unset) is unchanged — escape hatch for one release, mirroring the `GROVE_RUNTIME` cutover.

- [ ] **Step 4: Run + commit**

Run: `bun test src/core/select-runtime.test.ts` → PASS.

```bash
git add src/core/select-runtime.ts src/core/select-runtime.test.ts
git commit -m "feat(runtime): adopt AcpxSupervisor behind GROVE_SUPERVISOR flag (#273)"
```

### Task 5.2: Verify eventSink re-wrap + wire respawn→task in the server

**Files:**
- Read: `src/tui/spawn-manager.ts:293-300` (production `setAcpEventSink` wiring)
- Read: `src/server/task-controller-wiring.ts` (where `selectRuntime` feeds the TaskController)
- Modify: `src/server/task-controller-wiring.ts` (call `wireSupervisorToTasks` when the runtime is a supervisor)

**Note on drains:** `publishTurnToNexus` has no production caller; `SessionOrchestrator.watchTurn` only awaits `turn.result` (it does **not** drain `messages`). So there is **no double-drain risk** — the single production event path is the eventSink. The only requirement is that when the runtime is a supervisor, its `setAcpEventSink` (Task 2.3) is the one spawn-manager calls, so seq stamping is active. Confirm with a test.

- [ ] **Step 1: Confirm spawn-manager wiring works through the façade**

`spawn-manager.ts:296` checks `typeof runtime.setAcpEventSink === "function"`. The supervisor implements it (Task 2.3). Add a test in `src/core/acpx-supervisor.test.ts` asserting that after `sup.setAcpEventSink(sink)`, events emitted by a child reach `sink` **with a `seq`** field.

- [ ] **Step 2: Wire respawn → AgentTask in the server**

In `src/server/task-controller-wiring.ts`, after `selectRuntime(...)` returns the runtime, if it is an `AcpxSupervisor` (`instanceof`), call `wireSupervisorToTasks({ supervisor: runtime, taskStore, onDead: (slotId) => releaseLeasesForTask(slotId) })`. Use the existing claim/lease release path (`ClaimStore.release`, `store.ts:360`) for `onDead`. Add a focused test with a fake store + fake supervisor asserting the wiring is registered.

- [ ] **Step 3: Run + commit**

Run: `bun test src/core/acpx-supervisor.test.ts src/server/`
Expected: PASS.

```bash
bun run typecheck && bun run check
git add src/server/task-controller-wiring.ts src/core/acpx-supervisor.test.ts src/server/*.test.ts
git commit -m "feat(server): activate supervisor seq sink + respawn→task wiring (#273)"
```

### Task 5.3: Real-process kill-PID E2E

**Files:**
- Create: `tests/e2e/acpx-supervisor-respawn-tmux.ts`

**Pattern:** follow an existing real-process E2E under `tests/e2e/`. Launch via `grove up` (NOT `nexus up`); validate against Nexus stores (NOT local SQLite); no manual `send-keys`. Per project memory: fresh temp dir + `git init` per run (avoids stale-session IPC stall).

- [ ] **Step 1: Write the E2E script**

Concrete outline (no placeholders):
1. Fresh temp dir + `git init`; `GROVE_SUPERVISOR=1`; `grove up` with one agent task.
2. Resolve the agent's acpx child PID (from the process tree of the grove-managed runtime / the supervisor's `list()` session).
3. `kill -9 <pid>`.
4. Poll the Nexus `AgentTask` entity (HTTP API / watch) until a `SessionLost=True` condition appears AND `phase` stays `Running` (not `Failed`), within `maxRespawns × backoff`.
5. Assert a new session id is bound (respawn happened) and the agent produces a subsequent contribution (continues working).
6. Read the agent event stream; assert `seq` is monotonic with **no reset** across the kill boundary.
7. `grove down`; clean temp dir.

- [ ] **Step 2: Run the E2E**

Run: `GROVE_INTEGRATION=1 bun tests/e2e/acpx-supervisor-respawn-tmux.ts`
Expected: PASS — respawn within backoff; `SessionLost` visible on the task; monotonic seq; agent continues.

> If blocked by a known infra issue (e.g. Nexus IPC brick regression — project memory), pin the working image ref + note it in the script header. Do NOT claim the E2E passed without the real run (`feedback_no_workarounds`, `feedback_e2e_use_nexus`).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/acpx-supervisor-respawn-tmux.ts
git commit -m "test(e2e): kill-PID respawn + SessionLost under grove up (#273)"
```

---

## Final verification

- [ ] **Full suite:** `bun test --timeout 60000` → all green.
- [ ] **Typecheck:** `bun run typecheck` → clean.
- [ ] **Lint:** `bun run check` → clean.
- [ ] **Matrix (#210):** `bun test src/core/runtime-adapter-matrix.test.ts` → Mock + Acp + Supervisor green.
- [ ] **Spec coverage:** P1–P5 each map to tasks above; OQ2 (adoption, in scope) delivered by Task 5.1–5.3.
- [ ] **superpowers:requesting-code-review**, then **superpowers:finishing-a-development-branch** to open the PR referencing #273.

## Notes / risks (carried from the spec, corrected against the code)

- **Seq lives at the eventSink**, not `publishTurnToNexus` (which has no production caller). The supervisor wraps each child's `setAcpEventSink`; `entry.lastSeq` survives respawn because `handleDisconnect` mutates the entry in place.
- **No double-drain risk:** `watchTurn` only awaits `result`; nothing else drains `messages` in production. Task 5.2 verifies the supervisor sink is the active one through `spawn-manager`.
- **`wireSessionId` reuse prevented:** each respawn calls `sharedRuntime.spawn()` → a fresh `session/new` ⇒ a new `wireSessionId`, never the dead one (the shared runtime learns a distinct wire id per spawn).
- **`reconcileRunning` race** (`task-controller.ts:312`): respawn-aware `listSessions()` (the entry's live session) + the `Resuming` condition keep the controller from prematurely calling `failLostSession()`. If the TaskController runs in the E2E, assert the task stays `Running` through a respawn.
- **Open implementation question (resolve in P5):** confirm exactly how agent events reach the durable Nexus stream so the E2E's "monotonic seq" assertion observes the supervisor-stamped `seq` (trace the live eventSink → store/EventBus path; `publishTurnToNexus` appears dead). Surface findings in the PR.
- **Orphan reaping** across grove restarts is out of scope (design OQ4).
```
