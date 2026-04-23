import { describe, expect, test } from "bun:test";
import { AcpTurnImpl } from "./turn-direct.js";
import type { Message, Result } from "./types.js";

describe("AcpTurnImpl", () => {
  test("fans out pushed messages to the async iterator", async () => {
    let resolveResult: (r: Result) => void = () => {};
    const result = new Promise<Result>((r) => {
      resolveResult = r;
    });
    const turn = new AcpTurnImpl({
      sessionId: "s1",
      turnId: "t1",
      result,
      cancelFn: async () => {},
    });

    turn.ingest({ kind: "text", turnId: "t1", text: "hi", chunk: false });
    turn.ingest({
      kind: "token_usage",
      turnId: "t1",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    resolveResult({ turnId: "t1", stopReason: "end_turn" });

    const collected: Message[] = [];
    for await (const m of turn.messages) {
      collected.push(m);
      if (collected.length === 2) break;
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ kind: "text", text: "hi" });

    const res = await turn.result;
    expect(res.stopReason).toBe("end_turn");
  });

  test("cancel invokes cancelFn exactly once", async () => {
    let calls = 0;
    const turn = new AcpTurnImpl({
      sessionId: "s1",
      turnId: "t1",
      result: Promise.resolve({ turnId: "t1", stopReason: "cancelled" }),
      cancelFn: async () => {
        calls += 1;
      },
    });
    await turn.cancel();
    await turn.cancel();
    expect(calls).toBe(1);
  });
});
