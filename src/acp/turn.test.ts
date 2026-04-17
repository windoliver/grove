import { expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { AcpxTurnImpl } from "./turn.js";
import type { Message } from "./types.js";

function makeStream(lines: string[]): Readable {
  return Readable.from([`${lines.join("\n")}\n`]);
}

test("AcpxTurn yields messages and resolves result from a stream", async () => {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    }),
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

test("cancel() calls cancelFn", async () => {
  let cancelCalled = false;
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "cancelled" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: makeStream(lines),
    cancelFn: async () => {
      cancelCalled = true;
    },
  });
  await turn.cancel();
  for await (const _ of turn.messages) {
    /* drain */
  }
  const r = await turn.result;
  expect(cancelCalled).toBe(true);
  expect(r.stopReason).toBe("cancelled");
});

test("cancel() is idempotent across successful calls — only fires cancelFn once", async () => {
  let calls = 0;
  const stdout = new PassThrough(); // stays open so resultSettled=false when cancel is called
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      calls += 1;
    },
  });
  // Drain in the background so the parser generator runs; keeps result pending until stdout ends.
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  await turn.cancel();
  await turn.cancel();
  expect(calls).toBe(1);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() is retryable: failed cancelFn leaves the turn cancellable", async () => {
  let attempts = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient IPC failure");
      }
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  await expect(turn.cancel()).rejects.toThrow("transient IPC failure");
  // The first attempt threw — a retry must still invoke cancelFn.
  await turn.cancel();
  expect(attempts).toBe(2);
  // After a successful cancel, further calls become no-ops.
  await turn.cancel();
  expect(attempts).toBe(2);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() short-circuits once the turn's result has settled", async () => {
  let calls = 0;
  const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => {
      calls += 1;
    },
  });
  // Drain to completion so resultSettled flips.
  for await (const _ of turn.messages) {
    /* drain */
  }
  await turn.result;
  // Allow the result.then handler to flush.
  await new Promise((r) => setImmediate(r));
  await turn.cancel();
  expect(calls).toBe(0);
});

test("EOF without result yields acpx_exit error Result", async () => {
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([""]),
    cancelFn: async () => undefined,
  });
  for await (const _ of turn.messages) {
    /* drain */
  }
  const r = await turn.result;
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("acpx_exit");
});
