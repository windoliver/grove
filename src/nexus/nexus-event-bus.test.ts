/**
 * Unit tests for NexusEventBus.
 *
 * Tests the async publish behavior with NexusIpcClient integration.
 */

import { describe, expect, test } from "bun:test";
import type { GroveEvent } from "../core/event-bus.js";
import { NexusEventBus } from "./nexus-event-bus.js";
import type { IpcSendResult, NexusIpcClient } from "./nexus-ipc-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mock IPC client that records calls and returns configurable results. */
function makeMockIpcClient(
  result: IpcSendResult = { ok: true, messageId: "msg-123" },
): NexusIpcClient & { calls: { sender: string; recipient: string; payload: unknown }[] } {
  const calls: { sender: string; recipient: string; payload: unknown }[] = [];
  return {
    calls,
    send: async (sender: string, recipient: string, payload: Record<string, unknown>) => {
      calls.push({ sender, recipient, payload });
      return result;
    },
  } as NexusIpcClient & { calls: { sender: string; recipient: string; payload: unknown }[] };
}

function makeEvent(overrides?: Partial<GroveEvent>): GroveEvent {
  return {
    type: "contribution",
    sourceRole: "coder",
    targetRole: "reviewer",
    payload: { cid: "blake3:abc123" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusEventBus", () => {
  // --- Local handler delivery ---

  test("publish delivers to local handler subscribed to target role", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    await bus.publish(makeEvent());

    expect(received).toHaveLength(1);
    expect(received[0]!.sourceRole).toBe("coder");
    expect(received[0]!.targetRole).toBe("reviewer");
    bus.close();
  });

  test("publish does not deliver to handler on different role", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("coder", (e) => received.push(e));

    await bus.publish(makeEvent({ targetRole: "reviewer" }));

    expect(received).toHaveLength(0);
    bus.close();
  });

  test("multiple handlers on same role all receive the event", async () => {
    const bus = new NexusEventBus(undefined);
    let count = 0;
    bus.subscribe("reviewer", () => count++);
    bus.subscribe("reviewer", () => count++);

    await bus.publish(makeEvent());

    expect(count).toBe(2);
    bus.close();
  });

  test("unsubscribe removes handler", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    const handler = (e: GroveEvent) => received.push(e);
    bus.subscribe("reviewer", handler);
    bus.unsubscribe("reviewer", handler);

    await bus.publish(makeEvent());

    expect(received).toHaveLength(0);
    bus.close();
  });

  test("close clears all handlers", async () => {
    const bus = new NexusEventBus(undefined);
    let count = 0;
    bus.subscribe("reviewer", () => count++);
    bus.close();

    await bus.publish(makeEvent());

    expect(count).toBe(0);
  });

  test("handler error does not prevent other handlers from firing", async () => {
    const bus = new NexusEventBus(undefined);
    let secondFired = false;
    bus.subscribe("reviewer", () => {
      throw new Error("boom");
    });
    bus.subscribe("reviewer", () => {
      secondFired = true;
    });

    await bus.publish(makeEvent());

    expect(secondFired).toBe(true);
    bus.close();
  });

  // --- IPC send behavior ---

  test("publish sends via IpcClient and returns message ID", async () => {
    const ipc = makeMockIpcClient({ ok: true, messageId: "msg-456" });
    const bus = new NexusEventBus(ipc);

    const result = await bus.publish(makeEvent({ sourceRole: "coder", targetRole: "reviewer" }));

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-456");
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]!.sender).toBe("coder");
    expect(ipc.calls[0]!.recipient).toBe("reviewer");
    bus.close();
  });

  test("publish returns error result when IPC fails", async () => {
    const ipc = makeMockIpcClient({ ok: false, error: "network error" });
    const bus = new NexusEventBus(ipc);

    const result = await bus.publish(makeEvent());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network error");
    bus.close();
  });

  test("publish without IPC client returns ok (local-only mode)", async () => {
    const bus = new NexusEventBus(undefined);

    const result = await bus.publish(makeEvent());

    expect(result.ok).toBe(true);
    expect(result.messageId).toBeUndefined();
    bus.close();
  });

  test("publish still delivers to local handlers even when IPC fails", async () => {
    const ipc = makeMockIpcClient({ ok: false, error: "connection refused" });
    const bus = new NexusEventBus(ipc);
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    await bus.publish(makeEvent());

    expect(received).toHaveLength(1);
    bus.close();
  });

  test("publishLocal delivers to handlers without sending IPC", async () => {
    const ipc = makeMockIpcClient({ ok: true, messageId: "msg-789" });
    const bus = new NexusEventBus(ipc);
    const received: GroveEvent[] = [];
    bus.subscribe("reviewer", (e) => received.push(e));

    const result = await bus.publishLocal(makeEvent());

    expect(result.ok).toBe(true);
    expect(result.messageId).toBeUndefined();
    expect(ipc.calls).toHaveLength(0);
    expect(received).toHaveLength(1);
    bus.close();
  });

  test("publish sends IPC before notifying local handlers", async () => {
    const order: string[] = [];
    const ipc = {
      send: async () => {
        order.push("ipc");
        return { ok: true };
      },
    } as unknown as NexusIpcClient;
    const bus = new NexusEventBus(ipc);
    bus.subscribe("reviewer", () => order.push("handler"));

    await bus.publish(makeEvent());

    // IPC send completes, then handlers fire
    expect(order).toEqual(["ipc", "handler"]);
    bus.close();
  });

  // --- Unsubscribe edge cases ---

  test("unsubscribe on non-existent role is a no-op", () => {
    const bus = new NexusEventBus(undefined);
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op handler
    bus.unsubscribe("nonexistent", () => {});
    bus.close();
  });

  test("unsubscribe removes the specific handler only", async () => {
    const bus = new NexusEventBus(undefined);
    const received1: GroveEvent[] = [];
    const received2: GroveEvent[] = [];
    const handler1 = (e: GroveEvent) => received1.push(e);
    const handler2 = (e: GroveEvent) => received2.push(e);
    bus.subscribe("reviewer", handler1);
    bus.subscribe("reviewer", handler2);
    bus.unsubscribe("reviewer", handler1);

    await bus.publish(makeEvent());

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);
    bus.close();
  });
});
