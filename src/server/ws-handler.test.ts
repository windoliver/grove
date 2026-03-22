import { describe, expect, test } from "bun:test";
import type { GroveContract } from "../core/contract.js";
import { LocalEventBus } from "../core/local-event-bus.js";
import { MockRuntime } from "../core/mock-runtime.js";
import { SessionService } from "./session-service.js";
import type { WsSocket } from "./ws-handler.js";
import { createWsHandler } from "./ws-handler.js";

function makeContract(): GroveContract {
  return {
    contractVersion: 2,
    name: "test",
    topology: {
      structure: "flat",
      roles: [{ name: "worker", description: "Do work", command: "echo worker" }],
    },
  };
}

function makeService(): {
  service: SessionService;
  runtime: MockRuntime;
  bus: LocalEventBus;
} {
  const runtime = new MockRuntime();
  const bus = new LocalEventBus();
  const service = new SessionService({
    contract: makeContract(),
    runtime,
    eventBus: bus,
    projectRoot: "/tmp",
    workspaceBaseDir: "/tmp/workspaces",
  });
  return { service, runtime, bus };
}

/** Mock WebSocket that records sent messages. */
class MockWs implements WsSocket {
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

describe("createWsHandler", () => {
  test("open sends current state snapshot", () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(msg.type).toBe("state");
    expect(msg.status).toBe("pending");

    handler.close(ws);
    service.destroy();
    bus.close();
  });

  test("open subscribes to push events", async () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);

    // Start a session — should push agent_spawned events
    await service.startSession("Test goal");

    // Should have: 1 state (on connect) + 1 agent_spawned event
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    const types = ws.sent.map((s) => (JSON.parse(s) as Record<string, unknown>).type);
    expect(types).toContain("agent_spawned");

    handler.close(ws);
    service.destroy();
    bus.close();
  });

  test("close unsubscribes from events", async () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);
    handler.close(ws);

    const countBefore = ws.sent.length;

    // Start a session after closing — should NOT push events
    await service.startSession("Test goal");
    expect(ws.sent.length).toBe(countBefore);

    service.destroy();
    bus.close();
  });

  test("message: get_state returns state snapshot", () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);
    const countAfterOpen = ws.sent.length;

    handler.message(ws, JSON.stringify({ type: "command", command: "get_state" }));

    // Allow the async handler to settle
    // The handler is fire-and-forget async, so we give it a tick
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ws.sent.length).toBeGreaterThan(countAfterOpen);
        const lastMsg = JSON.parse(ws.sent[ws.sent.length - 1]!) as Record<string, unknown>;
        expect(lastMsg.type).toBe("state");
        handler.close(ws);
        service.destroy();
        bus.close();
        resolve();
      }, 50);
    });
  });

  test("message: start_session spawns agents", () => {
    const { service, runtime, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);

    handler.message(
      ws,
      JSON.stringify({
        type: "command",
        command: "start_session",
        payload: { goal: "Build auth" },
      }),
    );

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(runtime.spawnCalls.length).toBeGreaterThan(0);
        // Should have received a state message with running status
        const stateMessages = ws.sent
          .map((s) => JSON.parse(s) as Record<string, unknown>)
          .filter((m) => m.type === "state");
        const lastState = stateMessages[stateMessages.length - 1];
        expect(lastState?.status).toBe("running");
        expect(lastState?.goal).toBe("Build auth");

        handler.close(ws);
        service.destroy();
        bus.close();
        resolve();
      }, 50);
    });
  });

  test("message: stop_session stops the session", () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);

    return new Promise<void>((resolve) => {
      // Start first, then stop
      void service.startSession("Test").then(() => {
        handler.message(
          ws,
          JSON.stringify({
            type: "command",
            command: "stop_session",
            payload: { reason: "Done" },
          }),
        );

        setTimeout(() => {
          const events = ws.sent
            .map((s) => JSON.parse(s) as Record<string, unknown>)
            .filter((m) => m.type === "session_complete");
          expect(events.length).toBeGreaterThanOrEqual(1);

          handler.close(ws);
          service.destroy();
          bus.close();
          resolve();
        }, 50);
      });
    });
  });

  test("message: invalid JSON sends error", () => {
    const { service, bus } = makeService();
    const handler = createWsHandler(service);
    const ws = new MockWs();

    handler.open(ws);
    const countAfterOpen = ws.sent.length;

    handler.message(ws, "not-json{{{");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const errorMessages = ws.sent
          .slice(countAfterOpen)
          .map((s) => JSON.parse(s) as Record<string, unknown>)
          .filter((m) => m.type === "error");
        expect(errorMessages.length).toBeGreaterThanOrEqual(1);

        handler.close(ws);
        service.destroy();
        bus.close();
        resolve();
      }, 50);
    });
  });
});
