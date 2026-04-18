/**
 * Unit tests for publishTurnToNexus — drains an AcpxTurn and emits one
 * GroveEvent per Message plus one final acp.result event.
 */

import { describe, expect, test } from "bun:test";
import type { Message, Result } from "../acp/types.js";
import type { GroveEvent } from "../core/event-bus.js";
import { publishTurnToNexus } from "./nexus-agent-publisher.js";
import { NexusEventBus } from "./nexus-event-bus.js";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

describe("publishTurnToNexus", () => {
  test("emits one event per Message plus a final acp.result event", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push(e));

    const messages: Message[] = [
      { kind: "text", turnId: "t1", text: "hi", chunk: true },
      { kind: "tool_call", turnId: "t1", toolCall: { id: "tc1", name: "bash" } },
    ];
    const result: Result = { turnId: "t1", stopReason: "end_turn" };

    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages: asyncIter(messages),
      result: Promise.resolve(result),
    });

    expect(received).toHaveLength(3);
    expect(received[0]!.type).toBe("acp.message");
    expect(received[1]!.type).toBe("acp.message");
    expect(received[2]!.type).toBe("acp.result");
    bus.close();
  });

  test("every event carries sessionId + turnId in payload for correlation", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push(e));

    const messages: Message[] = [{ kind: "text", turnId: "t1", text: "a", chunk: true }];
    const result: Result = { turnId: "t1", stopReason: "end_turn" };

    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s-abc",
      turnId: "t-xyz",
      messages: asyncIter(messages),
      result: Promise.resolve(result),
    });

    for (const event of received) {
      expect(event.payload.sessionId).toBe("s-abc");
      expect(event.payload.turnId).toBe("t-xyz");
      expect(event.sourceRole).toBe("coder");
      expect(event.targetRole).toBe("orchestrator");
    }
    bus.close();
  });

  test("acp.message payload round-trips the typed Message shape", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push(e));

    const toolCallMsg: Message = {
      kind: "tool_call",
      turnId: "t1",
      toolCall: {
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "echo hi" },
        output: "hi",
      },
    };
    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages: asyncIter([toolCallMsg]),
      result: Promise.resolve({ turnId: "t1", stopReason: "end_turn" }),
    });

    expect(received[0]!.payload.message).toEqual(toolCallMsg);
  });

  test("acp.result payload carries the terminal Result including error", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push(e));

    const result: Result = {
      turnId: "t1",
      stopReason: "error",
      error: { code: "provider", message: "rate limit" },
    };
    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages: asyncIter([]),
      result: Promise.resolve(result),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("acp.result");
    expect(received[0]!.payload.result).toEqual(result);
  });

  test("events carry ISO timestamps", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push(e));

    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages: asyncIter([{ kind: "text", turnId: "t1", text: "x", chunk: true }]),
      result: Promise.resolve({ turnId: "t1", stopReason: "end_turn" }),
    });

    for (const e of received) {
      expect(typeof e.timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
    }
  });

  test("returns one PublishResult per emitted event", async () => {
    const bus = new NexusEventBus(undefined);
    const results = await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages: asyncIter([
        { kind: "text", turnId: "t1", text: "a", chunk: true },
        { kind: "text", turnId: "t1", text: "b", chunk: true },
      ]),
      result: Promise.resolve({ turnId: "t1", stopReason: "end_turn" }),
    });
    // 2 messages + 1 terminal result = 3 PublishResults
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.ok).toBe(true);
  });

  test("streams messages in iteration order without buffering the whole stream", async () => {
    const bus = new NexusEventBus(undefined);
    const received: GroveEvent[] = [];
    bus.subscribe("orchestrator", (e) => received.push({ ...e }));

    // Build a stream that observes publish progress as iteration advances.
    const observed: number[] = [];
    const messages: AsyncIterable<Message> = (async function* () {
      for (let i = 0; i < 3; i++) {
        observed.push(received.length);
        yield { kind: "text", turnId: "t1", text: String(i), chunk: true };
      }
    })();

    await publishTurnToNexus({
      bus,
      sourceRole: "coder",
      targetRole: "orchestrator",
      sessionId: "s1",
      turnId: "t1",
      messages,
      result: Promise.resolve({ turnId: "t1", stopReason: "end_turn" }),
    });

    // Each iteration step observes the running count before yielding, so the
    // first yield sees 0 published, second sees 1, third sees 2 — proving the
    // publisher does not drain the iterator before publishing.
    expect(observed).toEqual([0, 1, 2]);
    expect(received).toHaveLength(4);
  });
});
