/**
 * Unit tests for NexusWsBridge.
 *
 * Tests handleEvent and readAndPush with mocked dependencies.
 * Establishes a baseline before adding IPC delivery state updates (3A).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AcpxTurn } from "../acp/types.js";
import type { AgentRuntime, AgentSession } from "../core/agent-runtime.js";
import type { GroveEvent } from "../core/event-bus.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { NexusWsBridge, type NexusWsBridgeOptions } from "./nexus-ws-bridge.js";

function makeNoAcpTurn(sessionId: string): AcpxTurn {
  return {
    sessionId,
    turnId: `${sessionId}-noacp`,
    messages: (async function* () {
      /* no messages */
    })(),
    result: Promise.resolve({ turnId: `${sessionId}-noacp`, stopReason: "end_turn" as const }),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSession(role: string): AgentSession {
  return {
    id: `session-${role}`,
    role,
    status: "running",
  };
}

function makeMockRuntime(): AgentRuntime {
  return {
    spawn: mock(() => Promise.resolve(makeSession("mock"))),
    send: mock((session: AgentSession) => Promise.resolve(makeNoAcpTurn(session.id))),
    close: mock(() => Promise.resolve()),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mock no-op
    onIdle: mock(() => {}),
    listSessions: mock(() => Promise.resolve([])),
    isAvailable: mock(() => Promise.resolve(true)),
  };
}

function makeBridgeOpts(overrides?: Partial<NexusWsBridgeOptions>): NexusWsBridgeOptions {
  return {
    topology: {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" as const }] },
        { name: "reviewer" },
      ],
    },
    runtime: makeMockRuntime(),
    nexusUrl: "http://localhost:9999",
    apiKey: "test-key",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers to invoke private methods via the bridge
// ---------------------------------------------------------------------------

/**
 * We need to test handleEvent which is private. We test it indirectly by:
 * 1. Registering a session
 * 2. Mocking fetch for the VFS read
 * 3. Calling the bridge's internal SSE handler by simulating what connectSse does
 *
 * Rather than reaching into private methods, we test the public API path:
 * registerSession + the observable side effects (runtime.send called, eventBus notified).
 *
 * For direct handleEvent testing, we use a subclass that exposes it.
 */
class TestableNexusWsBridge extends NexusWsBridge {
  /** Expose handleEvent for testing. */
  testHandleEvent(role: string, eventType: string | null, raw: string): void {
    // Access private method — test-only subclass
    (
      this as unknown as { handleEvent: (r: string, e: string | null, d: string) => void }
    ).handleEvent(role, eventType, raw);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusWsBridge", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- handleEvent ---

  test("handleEvent ignores non-message_delivered events", () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    bridge.testHandleEvent(
      "reviewer",
      "heartbeat",
      JSON.stringify({
        event: "heartbeat",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    // runtime.send should NOT have been called
    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
    bus.close();
  });

  test("handleEvent publishes to EventBus on message_delivered", () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    // Mock fetch for readAndPush VFS read — return valid data
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            data: Buffer.from(
              JSON.stringify({ sender: "coder", payload: { summary: "test contribution" } }),
            ).toString("base64"),
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    // EventBus should have received the event
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("contribution");
    expect(received[0]!.sourceRole).toBe("coder");
    expect(received[0]!.targetRole).toBe("reviewer");
    expect(received[0]!.payload).toEqual({ message_id: "msg-1" });

    bridge.close();
    bus.close();
  });

  test("handleEvent does nothing when no session registered for role", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    // No session registered for "reviewer"

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    // Give async readAndPush a tick
    await new Promise((r) => setTimeout(r, 20));

    // runtime.send should NOT have been called (no session)
    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
    bus.close();
  });

  test("handleEvent calls onBeforeDeliver callback", async () => {
    const runtime = makeMockRuntime();
    const deliverCalls: { sender: string; recipient: string }[] = [];

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            data: Buffer.from(
              JSON.stringify({ sender: "coder", payload: { summary: "test" } }),
            ).toString("base64"),
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(
      makeBridgeOpts({
        runtime,
        onBeforeDeliver: (sender, recipient) => {
          deliverCalls.push({ sender, recipient });
        },
      }),
    );
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]).toEqual({ sender: "coder", recipient: "reviewer" });
    bridge.close();
  });

  test("handleEvent skips malformed JSON gracefully", () => {
    const runtime = makeMockRuntime();
    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    // Should not throw
    bridge.testHandleEvent("reviewer", "message_delivered", "not-valid-json");

    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
  });

  // --- readAndPush ---

  test("readAndPush delivers message content to agent session", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            data: Buffer.from(
              JSON.stringify({
                sender: "coder",
                payload: { summary: "implement auth module" },
              }),
            ).toString("base64"),
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    // readAndPush is async — wait for it
    await new Promise((r) => setTimeout(r, 50));

    expect(runtime.send).toHaveBeenCalledTimes(1);
    const sendCall = (runtime.send as ReturnType<typeof mock>).mock.calls[0];
    expect(sendCall![0]).toBe(session);
    expect(sendCall![1]).toContain("[IPC from coder]");
    expect(sendCall![1]).toContain("implement auth module");

    bridge.close();
  });

  test("readAndPush handles VFS read failure gracefully", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    // Should not crash, should not deliver
    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
  });

  test("readAndPush handles missing data field gracefully", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: {} }), { status: 200 })) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
  });

  // --- send ---

  test("send() POSTs to Nexus IPC endpoint", async () => {
    const fetchCalls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(init?.body as string),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    const ok = await bridge.send("coder", "reviewer", { summary: "test" });

    expect(ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://localhost:9999/api/v2/ipc/send");
    expect(fetchCalls[0]!.body).toEqual({
      sender: "coder",
      recipient: "reviewer",
      type: "event",
      payload: { summary: "test" },
    });

    bridge.close();
  });

  test("send() returns false on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    const ok = await bridge.send("coder", "reviewer", { summary: "test" });

    expect(ok).toBe(false);
    bridge.close();
  });

  test("send() returns false on non-ok response", async () => {
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    const ok = await bridge.send("coder", "reviewer", { summary: "test" });

    expect(ok).toBe(false);
    bridge.close();
  });

  // --- session management ---

  test("registerSession and unregisterSession", () => {
    const bridge = new NexusWsBridge(makeBridgeOpts());
    const session = makeSession("reviewer");

    bridge.registerSession("reviewer", session);
    bridge.unregisterSession("reviewer");

    // After unregister, events for this role should not deliver
    // (tested indirectly via handleEvent no-session path)
    bridge.close();
  });

  test("close clears all sessions and abort controllers", () => {
    const bridge = new NexusWsBridge(makeBridgeOpts());
    bridge.registerSession("reviewer", makeSession("reviewer"));
    bridge.registerSession("coder", makeSession("coder"));

    bridge.close();

    // After close, new registrations should not start SSE
    // (the closed flag prevents it)
    bridge.registerSession("tester", makeSession("tester"));
    // No error expected — just a no-op
  });

  // --- handleIpcEnvelope ---
  //
  // NexusEventBus.publish sends ONLY `event.payload` over the IPC wire (the
  // outer GroveEvent fields are dropped). These tests exercise that real
  // wire shape: innerPayload is the published payload object, wireSender /
  // wireRecipient come from the IPC `from`/`recipient` fields.

  test("handleIpcEnvelope routes acp.message to onAcpEvent when source is remote", () => {
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
      },
      "external-agent",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).toHaveBeenCalledTimes(1);
    const call = (onAcpEvent.mock.calls[0] as unknown as [GroveEvent])[0];
    expect(call.type).toBe("acp.message");
    expect(call.sourceRole).toBe("external-agent");
    expect(call.targetRole).toBe("tui");
    expect(call.payload.sessionId).toBe("s1");
  });

  test("handleIpcEnvelope drops acp.message from local role when neither side has instance markers (legacy wiring)", () => {
    // Neither bridge nor envelope carries a sourceInstance — preserve the
    // original role-only dedupe so single-process in-proc bus + SSE
    // loopback does not double-deliver.
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
      },
      "coder",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).not.toHaveBeenCalled();
  });

  test("handleIpcEnvelope drops local-role ACP when only one side has an instance marker", () => {
    // Bridge has localInstanceId but envelope lacks sourceInstance (e.g.
    // a local legacy publisher). We can't distinguish "self-loop" from
    // "cross-process sender that happens to share this role name" — but
    // the in-process EventBus subscription already delivers local-role
    // events, so forwarding would duplicate every message frame (the
    // store has no idempotency key and appends on every acp.message).
    // Drop is the correct default; cross-process safety requires both
    // sides to stamp sourceInstance.
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent, localInstanceId: "A" }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "legacy-publisher", chunk: true },
      },
      "coder",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).not.toHaveBeenCalled();
  });

  test("handleIpcEnvelope returns 'ipc' for non-acp payloads (regression guard)", () => {
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
    const outcome = bridge.handleIpcEnvelope(
      { type: "contribution", body: "done" },
      "coder",
      "reviewer",
    );
    expect(outcome).toBe("ipc");
    expect(onAcpEvent).not.toHaveBeenCalled();
  });

  test("handleIpcEnvelope returns 'acp' even when onAcpEvent is undefined (silent drop)", () => {
    // No onAcpEvent wired. An acp.* envelope must still be classified as
    // "acp" so readAndPush skips runtime.send — preventing typed control
    // events from leaking into the agent's IPC inbox as prose.
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent: undefined }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.result",
        sessionId: "s1",
        turnId: "t1",
        result: { turnId: "t1", stopReason: "end_turn" },
      },
      "external-agent",
      "tui",
    );
    expect(outcome).toBe("acp");
  });

  test("handleIpcEnvelope accepts ACP-shaped payload without `type` field (rolling upgrade)", () => {
    // Older publishers predate the `type` embedding. Bridge must fall back
    // to shape detection so a mixed-version deployment does not route
    // typed control-plane events into an agent's prose IPC inbox.
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent }));
    const outcome = bridge.handleIpcEnvelope(
      {
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "legacy", chunk: true },
      },
      "external-agent",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).toHaveBeenCalledTimes(1);
  });

  test("handleIpcEnvelope forwards remote ACP with same role name when instance IDs differ", () => {
    // Shared-Nexus scenario: another Grove process also uses role "coder".
    // Current bridge is configured with localInstanceId "A"; SSE delivers
    // an event from instance "B" whose role happens to collide. Must NOT
    // be dropped as a local self-loop.
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent, localInstanceId: "A" }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sourceInstance: "B",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "remote-coder", chunk: true },
      },
      "coder",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).toHaveBeenCalledTimes(1);
  });

  test("handleIpcEnvelope drops ACP self-loop when role and instance both match", () => {
    const onAcpEvent = mock(() => undefined);
    const bridge = new NexusWsBridge(makeBridgeOpts({ onAcpEvent, localInstanceId: "A" }));
    const outcome = bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sourceInstance: "A",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "self-loop", chunk: true },
      },
      "coder",
      "tui",
    );
    expect(outcome).toBe("acp");
    expect(onAcpEvent).not.toHaveBeenCalled();
  });

  test("handleIpcEnvelope reconstructs GroveEvent from wire payload so sink accepts it", async () => {
    // End-to-end integration through the real sink: inner payload shape
    // matches what NexusEventBus sends over the wire (just `event.payload`,
    // with `type` embedded inside it — see nexus-agent-publisher.ts).
    const { AcpSessionStore } = await import("./data/acp-session-store.js");
    const { createAcpMessageSink } = await import("./data/acp-message-sink.js");
    const store = new AcpSessionStore();
    store.register("s1");
    const sink = createAcpMessageSink(store);

    const bridge = new NexusWsBridge(
      makeBridgeOpts({ onAcpEvent: (e) => sink.handleGroveEvent(e) }),
    );
    bridge.handleIpcEnvelope(
      {
        type: "acp.message",
        sessionId: "s1",
        turnId: "t1",
        message: { kind: "text", turnId: "t1", text: "wire-shape", chunk: true },
      },
      "external-agent",
      "tui",
    );
    expect(store.getTurn("s1", "t1")?.messages).toHaveLength(1);
  });

  test("ACP envelope delivered by SSE must NOT trigger handoff markDelivered", async () => {
    // Codex Round 9 Finding 1: ACP traffic is high-volume and has no
    // backing handoff record. The sender-fallback inside
    // updateHandoffDeliveryStatus matches the most-recent pending
    // handoff from the same sender — so every ACP envelope would
    // falsely advance an unrelated handoff to delivered. Fixed by
    // running handoff-state transitions only AFTER ACP classification.
    const runtime = makeMockRuntime();
    const markDelivered = mock(() => Promise.resolve());
    const handoffStore = {
      list: mock(() =>
        Promise.resolve([
          // A pending handoff from the same sender — would falsely match
          // the sender-fallback if markDelivered ran before ACP gate.
          {
            handoffId: "h1",
            fromRole: "coder",
            toRole: "reviewer",
            status: "pending_pickup" as const,
            ipcMessageId: undefined,
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
      markDelivered,
      markDeadLettered: mock(() => Promise.resolve()),
    };

    const bridge = new TestableNexusWsBridge(
      makeBridgeOpts({
        runtime,
        handoffStore: handoffStore as unknown as NexusWsBridgeOptions["handoffStore"],
        onAcpEvent: () => undefined,
      }),
    );
    bridge.registerSession("reviewer", makeSession("reviewer"));

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            data: Buffer.from(
              JSON.stringify({
                sender: "coder",
                payload: {
                  type: "acp.message",
                  sessionId: "s1",
                  turnId: "t1",
                  message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
                },
              }),
            ).toString("base64"),
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "acp-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/acp-1",
      }),
    );

    // Wait for async readAndPush
    await new Promise((r) => setTimeout(r, 20));
    expect(markDelivered).not.toHaveBeenCalled();
    bridge.close();
  });
});
