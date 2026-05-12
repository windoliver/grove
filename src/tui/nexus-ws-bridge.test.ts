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
    listSessionEntities: mock(() => Promise.resolve([])),
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

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
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

  /** Expose inbox drain for missed-SSE regression tests. */
  async testDrainRoleInbox(role: string): Promise<void> {
    await (
      this as unknown as { drainRoleInbox: (r: string, reason: string) => Promise<void> }
    ).drainRoleInbox(role, "test");
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

  test("handleEvent publishes to EventBus on contribution-bearing message_delivered", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    // Mock fetch for readAndPush VFS read — return a contribution
    // payload (cid + kind). Without those fields, the publish path
    // intentionally skips firing so non-contribution IPC traffic does
    // not invalidate the contribution list cache.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "coder",
            payload: { cid: "blake3:abc", kind: "work", summary: "test contribution" },
          }),
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

    // readAndPush is fire-and-forget — wait for the microtask queue to
    // drain so the publish call inside it has run.
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("contribution");
    expect(received[0]!.sourceRole).toBe("coder");
    expect(received[0]!.targetRole).toBe("reviewer");
    expect(received[0]!.payload).toMatchObject({
      message_id: "msg-1",
      cid: "blake3:abc",
      kind: "work",
      summary: "test contribution",
    });

    bridge.close();
    bus.close();
  });

  test("handleEvent includes done summary and context in EventBus contribution payload", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("coder");
    bridge.registerSession("coder", session);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "reviewer",
            payload: {
              cid: "blake3:done",
              kind: "discussion",
              summary: "[DONE] Approved",
              context: { done: true },
            },
          }),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "coder",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-done",
        sender: "reviewer",
        recipient: "coder",
        type: "event",
        path: "/inbox/msg-done",
      }),
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]!.sourceRole).toBe("reviewer");
    expect(received[0]!.targetRole).toBe("coder");
    expect(received[0]!.payload).toMatchObject({
      message_id: "msg-done",
      cid: "blake3:done",
      kind: "discussion",
      summary: "[DONE] Approved",
      context: { done: true },
    });

    bridge.close();
    bus.close();
  });

  test("handleEvent skips runtime delivery when done handling unregisters the session", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("coder");
    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => {
      received.push(e);
      bridge.unregisterSession("coder", session.id);
    });
    bridge.registerSession("coder", session);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "reviewer",
            payload: {
              cid: "blake3:done",
              kind: "discussion",
              summary: "[DONE] Approved",
              context: { done: true },
            },
          }),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "coder",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-done",
        sender: "reviewer",
        recipient: "coder",
        type: "event",
        path: "/inbox/msg-done",
      }),
    );

    await waitFor(() => received.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtime.send).not.toHaveBeenCalled();

    bridge.close();
    bus.close();
  });

  test("handleEvent derives Nexus EventRecord message_id from inbox filename", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "coder",
            payload: { cid: "blake3:eventrecord", kind: "work", summary: "from event record" },
          }),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "reviewer",
      "event",
      JSON.stringify({
        event_id: "nexus-event-id",
        type: "write",
        path: "/zone/test-zone/ipc/reviewer/inbox/message-file-id.json",
        agent_id: "coder",
      }),
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.message_id).toBe("message-file-id");

    bridge.close();
    bus.close();
  });

  test("handleEvent ignores Nexus EventRecord writes outside the configured zone", async () => {
    const runtime = makeMockRuntime();
    const readPaths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/events/stream") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/api/v2/files/read") {
        readPaths.push(url.searchParams.get("path") ?? "");
        return new Response(
          JSON.stringify({
            content: JSON.stringify({
              sender: "coder",
              payload: { cid: "blake3:foreign", kind: "work", summary: "foreign work" },
            }),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(
      makeBridgeOpts({
        runtime,
        getSessionId: () => "sess-123",
        zoneId: "zone-a",
      }),
    );
    bridge.registerSession("reviewer", makeSession("reviewer"));

    bridge.testHandleEvent(
      "reviewer",
      "event",
      JSON.stringify({
        event_id: "nexus-event-id",
        type: "write",
        path: "/zones/zone-b/sessions/sess-123/ipc/reviewer/inbox/msg-foreign.json",
        agent_id: "coder",
      }),
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(readPaths).toEqual([]);
    expect(runtime.send).not.toHaveBeenCalled();
    bridge.close();
  });

  test("handleEvent does NOT publish for non-contribution IPC (no cid+kind)", async () => {
    const runtime = makeMockRuntime();
    const bus = new LocalEventBus();
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime, eventBus: bus }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    // Plain IPC payload — no cid + kind. Should NOT trigger a
    // contribution event on the bus, otherwise high-volume ACP/agent
    // traffic would force a full VFS rescan per delivery.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({ sender: "coder", payload: { summary: "plain notice" } }),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-2",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-2",
      }),
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(0);

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
          content: JSON.stringify({ sender: "coder", payload: { summary: "test" } }),
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
          content: JSON.stringify({
            sender: "coder",
            payload: { summary: "implement auth module" },
          }),
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

  test("readAndPush formats routed contribution with CID for direct tool invocation", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "coder",
            payload: {
              cid: "blake3:abc123",
              kind: "work",
              summary: "implement auth module",
              agentId: "coder-1",
            },
          }),
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
        message_id: "msg-cid-1",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/inbox/msg-cid-1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(runtime.send).toHaveBeenCalledTimes(1);
    const sendCall = (runtime.send as ReturnType<typeof mock>).mock.calls[0];
    const notification = sendCall![1] as string;
    expect(notification).toContain("blake3:abc123");
    expect(notification).toContain("New work from coder");
    expect(notification).toContain("implement auth module");
    expect(notification).toContain("grove_submit_review");
    expect(notification).not.toContain("[IPC from coder]");

    bridge.close();
  });

  test("readAndPush uses kind-specific action text for review contributions", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: JSON.stringify({
            sender: "reviewer",
            payload: {
              cid: "blake3:review1",
              kind: "review",
              summary: "fix the race condition in handler.ts",
              agentId: "reviewer-1",
            },
          }),
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("coder");
    bridge.registerSession("coder", session);

    bridge.testHandleEvent(
      "coder",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "msg-review-1",
        sender: "reviewer",
        recipient: "coder",
        type: "event",
        path: "/inbox/msg-review-1",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(runtime.send).toHaveBeenCalledTimes(1);
    const notification = (runtime.send as ReturnType<typeof mock>).mock.calls[0]![1] as string;
    // A review arriving at the coder should prompt updated work, NOT another review.
    expect(notification).toContain("blake3:review1");
    expect(notification).toContain("New review from reviewer");
    expect(notification).toContain("grove_submit_work");
    expect(notification).not.toContain("grove_submit_review");

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

  test("readAndPush handles missing content field gracefully", async () => {
    const runtime = makeMockRuntime();

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

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

  test("drainRoleInbox delivers missed inbox file for registered session", async () => {
    const runtime = makeMockRuntime();
    const modifiedAt = new Date(Date.now() + 1000).toISOString();

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/events/stream")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v2/files/list")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                name: "missed-message.json",
                path: "/ipc/reviewer/inbox/missed-message.json",
                is_directory: false,
                modified_at: modifiedAt,
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v2/files/read")) {
        return new Response(
          JSON.stringify({
            content: JSON.stringify({
              sender: "coder",
              recipient: "reviewer",
              timestamp: modifiedAt,
              payload: {
                cid: "blake3:missed",
                kind: "work",
                summary: "missed SSE contribution",
              },
            }),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(makeBridgeOpts({ runtime }));
    const session = makeSession("reviewer");
    bridge.registerSession("reviewer", session);

    await bridge.testDrainRoleInbox("reviewer");
    await new Promise((r) => setTimeout(r, 20));

    expect(runtime.send).toHaveBeenCalledTimes(1);
    const notification = (runtime.send as ReturnType<typeof mock>).mock.calls[0]![1] as string;
    expect(notification).toContain("blake3:missed");
    expect(notification).toContain("missed SSE contribution");

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
    expect(fetchCalls[0]!.url).toBe("http://localhost:9999/api/v2/files/write");
    const body = fetchCalls[0]!.body as {
      path: string;
      content: string;
      encoding: string;
    };
    expect(body.path).toMatch(/^\/ipc\/reviewer\/inbox\/.+\.json$/);
    expect(body.encoding).toBe("base64");
    const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as {
      sender: string;
      recipient: string;
      type: string;
      payload: Record<string, unknown>;
    };
    expect(decoded.sender).toBe("coder");
    expect(decoded.recipient).toBe("reviewer");
    expect(decoded.type).toBe("event");
    expect(decoded.payload).toEqual({ summary: "test" });

    bridge.close();
  });

  test("send() scopes the inbox path when a session id is active", async () => {
    const fetchCalls: { body: unknown }[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        body: JSON.parse(init?.body as string),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts({ getSessionId: () => "sess-123" }));
    const ok = await bridge.send("coder", "reviewer", { summary: "test" });

    expect(ok).toBe(true);
    const body = fetchCalls[0]!.body as {
      path: string;
      content: string;
    };
    expect(body.path).toMatch(/^\/sessions\/sess-123\/ipc\/reviewer\/inbox\/.+\.json$/);
    const decoded = JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as {
      session_id: string;
    };
    expect(decoded.session_id).toBe("sess-123");
    bridge.close();
  });

  test("send() scopes the inbox path under an encoded zone when provided", async () => {
    const fetchCalls: { body: unknown }[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        body: JSON.parse(init?.body as string),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(
      makeBridgeOpts({
        getSessionId: () => "sess-123",
        zoneId: "project-123/worktree-a",
      }),
    );
    const ok = await bridge.send("coder", "reviewer", { summary: "test" });

    expect(ok).toBe(true);
    const body = fetchCalls[0]!.body as { path: string };
    expect(body.path).toMatch(
      /^\/zones\/project-123%2Fworktree-a\/sessions\/sess-123\/ipc\/reviewer\/inbox\/.+\.json$/,
    );
    bridge.close();
  });

  test("drainRoleInbox lists the encoded zone-scoped inbox when provided", async () => {
    const runtime = makeMockRuntime();
    const listPaths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/events/stream") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/api/v2/files/list") {
        listPaths.push(url.searchParams.get("path") ?? "");
        return new Response(JSON.stringify({ items: [], has_more: false }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(
      makeBridgeOpts({
        runtime,
        getSessionId: () => "sess-123",
        zoneId: "project-123/worktree-a",
      }),
    );
    bridge.registerSession("reviewer", makeSession("reviewer"));

    await bridge.testDrainRoleInbox("reviewer");

    expect(listPaths).toContain(
      "/zones/project-123%2Fworktree-a/sessions/sess-123/ipc/reviewer/inbox",
    );
    bridge.close();
  });

  test("readAndPush skips legacy global inbox messages during a scoped session", async () => {
    const runtime = makeMockRuntime();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/files/read")) {
        return new Response(
          JSON.stringify({
            content: JSON.stringify({
              sender: "coder",
              payload: { cid: "blake3:old", kind: "work", summary: "old work" },
            }),
          }),
          { status: 200 },
        );
      }
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const bridge = new TestableNexusWsBridge(
      makeBridgeOpts({ runtime, getSessionId: () => "sess-current" }),
    );
    bridge.registerSession("reviewer", makeSession("reviewer"));
    bridge.testHandleEvent(
      "reviewer",
      "message_delivered",
      JSON.stringify({
        event: "message_delivered",
        message_id: "old-msg",
        sender: "coder",
        recipient: "reviewer",
        type: "event",
        path: "/ipc/reviewer/inbox/old-msg.json",
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.send).not.toHaveBeenCalled();
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
          content: JSON.stringify({
            sender: "coder",
            payload: {
              type: "acp.message",
              sessionId: "s1",
              turnId: "t1",
              message: { kind: "text", turnId: "t1", text: "hi", chunk: true },
            },
          }),
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

  // --- connect() readiness ---

  test("connect resolves when every role registers successfully", async () => {
    // Registration accepts any 2xx; stream probe also requires real
    // text/event-stream content-type to count as ready.
    globalThis.fetch = ((url: string) => {
      if (url.includes("/api/v2/events/stream")) {
        return Promise.resolve(
          new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(1000)).resolves.toBeUndefined();
    bridge.close();
  });

  test("connect accepts 409 Conflict as idempotent registration success", async () => {
    // coder registers fresh (200); reviewer returns 409 (already registered).
    let regCalls = 0;
    globalThis.fetch = ((url: string) => {
      if (url.includes("/api/v2/agents/register")) {
        regCalls += 1;
        return Promise.resolve(new Response("", { status: regCalls === 1 ? 200 : 409 }));
      }
      if (url.includes("/api/v2/events/stream")) {
        return Promise.resolve(
          new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(1000)).resolves.toBeUndefined();
    bridge.close();
  });

  test("SSE stream parser delivers events split across read chunks", async () => {
    const runtime = makeMockRuntime();
    const encoder = new TextEncoder();
    const eventRecord = JSON.stringify({
      event_id: "event-split-1",
      type: "write",
      path: "/ipc/reviewer/inbox/msg-split.json",
      agent_id: "coder",
    });

    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/api/v2/events/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("retry: 5000\n\nid: 1\nevent: event\n"));
            setTimeout(() => {
              controller.enqueue(encoder.encode(`data: ${eventRecord}\n\n`));
              controller.close();
            }, 0);
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      if (url.includes("/api/v2/files/read")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: JSON.stringify({
                sender: "coder",
                payload: { cid: "blake3:split", kind: "work", summary: "split event" },
              }),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts({ runtime }));
    bridge.registerSession("reviewer", makeSession("reviewer"));

    await waitFor(
      () =>
        (runtime.send as unknown as { mock: { calls: readonly unknown[] } }).mock.calls.length ===
        1,
    );
    expect(runtime.send).toHaveBeenCalledTimes(1);
    bridge.close();
  });

  test("session stream drains existing inbox files and dedupes SSE replay", async () => {
    const runtime = makeMockRuntime();
    const encoder = new TextEncoder();
    const inboxPath = "/sessions/sess-123/ipc/reviewer/inbox/msg-1.json";
    const markDelivered = mock(() => Promise.resolve());
    const handoffStore = {
      list: mock(() =>
        Promise.resolve([
          {
            handoffId: "handoff-1",
            fromRole: "coder",
            toRole: "reviewer",
            sourceCid: "blake3:catchup",
            status: "pending_pickup" as const,
            ipcMessageId: "msg-1",
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
      markDelivered,
      markDeadLettered: mock(() => Promise.resolve()),
    };

    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/api/v2/events/stream")) {
        const eventRecord = JSON.stringify({
          event_id: "event-1",
          type: "write",
          path: inboxPath,
          agent_id: "coder",
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(encoder.encode(`id: 1\nevent: event\ndata: ${eventRecord}\n\n`));
              controller.close();
            }, 0);
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      if (url.includes("/api/v2/files/list")) {
        expect(decodeURIComponent(url)).toContain(
          "/api/v2/files/list?path=/sessions/sess-123/ipc/reviewer/inbox",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ path: inboxPath, isDirectory: false, modifiedAt: "2026-05-06T00:00:00Z" }],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/api/v2/files/read")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: JSON.stringify({
                message_id: "msg-1",
                sender: "coder",
                session_id: "sess-123",
                payload: { cid: "blake3:catchup", kind: "work", summary: "catch-up work" },
              }),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(
      makeBridgeOpts({
        runtime,
        getSessionId: () => "sess-123",
        handoffStore: handoffStore as unknown as NexusWsBridgeOptions["handoffStore"],
      }),
    );
    bridge.registerSession("reviewer", makeSession("reviewer"));

    await waitFor(
      () =>
        (runtime.send as unknown as { mock: { calls: readonly unknown[] } }).mock.calls.length ===
        1,
    );
    await waitFor(() => markDelivered.mock.calls.length === 1);
    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledWith("handoff-1");
    bridge.close();
  });

  test("connect rejects when probe returns 2xx without event-stream content-type", async () => {
    globalThis.fetch = ((url: string) => {
      if (url.includes("/api/v2/events/stream")) {
        // 2xx but plain text/html — a misconfigured proxy scenario.
        return Promise.resolve(
          new Response("not a stream", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(1000)).rejects.toThrow(/not event-stream/);
    bridge.close();
  });

  test("connect rejects when any role fails to register", async () => {
    // First call (coder) returns 200, second (reviewer) returns 500.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("", { status: calls === 1 ? 200 : 500 });
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(1000)).rejects.toThrow(/reviewer: HTTP 500/);
    bridge.close();
  });

  test("connect rejects with timeout when registration hangs", async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // Reject when the AbortSignal fires; otherwise never settle.
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(50)).rejects.toThrow(/timeout after 50ms/);
    bridge.close();
  });

  test("connect rejects when SSE stream probe returns non-2xx", async () => {
    // Registration succeeds (POST /agents/register returns 200) but the
    // stream probe (GET /ipc/stream/<role>) returns 403 — simulating a
    // deployment where registration is permissive but stream auth is not.
    globalThis.fetch = ((url: string) => {
      if (url.includes("/api/v2/events/stream")) {
        return Promise.resolve(new Response("", { status: 403 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const bridge = new NexusWsBridge(makeBridgeOpts());
    await expect(bridge.connect(1000)).rejects.toThrow(/stream handshake failed.*HTTP 403/);
    bridge.close();
  });
});
