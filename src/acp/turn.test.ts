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

test("cancel() remains callable after a successful write — provider may not honor it", async () => {
  // A successful cancelFn write only means "cancel requested", not confirmed.
  // Callers can re-invoke cancel() to re-send until the turn's result settles.
  let calls = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      calls += 1;
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  await turn.cancel();
  expect(calls).toBe(1);
  // Turn hasn't settled → next cancel re-sends.
  await turn.cancel();
  expect(calls).toBe(2);
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
  // Another explicit re-send escalation while the turn is still in flight.
  await turn.cancel();
  expect(attempts).toBe(3);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() is single-flight under concurrent callers", async () => {
  let calls = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      calls += 1;
      // Simulate slow transport so concurrent callers race into the same attempt.
      await new Promise((r) => setTimeout(r, 20));
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  // Fire 3 callers simultaneously; only one underlying cancelFn invocation is allowed.
  await Promise.all([turn.cancel(), turn.cancel(), turn.cancel()]);
  expect(calls).toBe(1);
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

test("cancel() same-tick after result resolution is a no-op (no microtask race)", async () => {
  // If settlement is tracked only via a .then() latch on `this.result`, a
  // caller that invokes cancel() in the same tick as the result resolution
  // will still see the latch as false and spuriously fire cancelFn. This
  // test forces that race by awaiting result and immediately cancelling —
  // without any setImmediate/setTimeout flush in between.
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
  for await (const _ of turn.messages) {
    /* drain */
  }
  await turn.result;
  // NO microtask flush here — cancel() must observe settlement synchronously.
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
