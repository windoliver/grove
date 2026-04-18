import { expect, test } from "bun:test";
import type { AcpxTurn, Result, StopReason } from "./types.js";
import { watchTurnError } from "./watch-turn.js";

function fakeTurn(result: Result): AcpxTurn {
  return {
    sessionId: "s1",
    turnId: result.turnId,
    messages: (async function* () {
      /* none */
    })(),
    result: Promise.resolve(result),
    cancel: async () => undefined,
    close: async () => undefined,
  };
}

async function collectLogs(result: Result): Promise<string[]> {
  const logs: string[] = [];
  watchTurnError(fakeTurn(result), "ctx", (m) => logs.push(m));
  // Yield two microtask rounds for the watcher to settle.
  await Promise.resolve();
  await Promise.resolve();
  return logs;
}

test("watchTurnError is silent when the turn ends with end_turn", async () => {
  const logs = await collectLogs({ turnId: "ok", stopReason: "end_turn" });
  expect(logs).toEqual([]);
});

test("watchTurnError logs when the turn ends with error", async () => {
  const logs = await collectLogs({
    turnId: "err",
    stopReason: "error",
    error: { code: "boom", message: "explode" },
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("abnormally");
  expect(logs[0]).toContain("stopReason=error");
  expect(logs[0]).toContain("code=boom");
});

test("watchTurnError logs when the turn is cancelled", async () => {
  const logs = await collectLogs({ turnId: "cncl", stopReason: "cancelled" });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("stopReason=cancelled");
});

test("watchTurnError logs when the turn hits max_tokens (truncated)", async () => {
  const logs = await collectLogs({ turnId: "trunc", stopReason: "max_tokens" });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("stopReason=max_tokens");
});

test("watchTurnError logs unknown stop reasons (forward-compat)", async () => {
  const logs = await collectLogs({
    turnId: "future",
    stopReason: "some_new_reason" as StopReason,
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("stopReason=some_new_reason");
});
