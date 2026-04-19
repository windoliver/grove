import { expect, test } from "bun:test";
import type { Message, Result } from "../../acp/types.ts";
import type { AcpSinkEvent, SessionRecord, TurnRecord } from "./acp-session-store.ts";

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
