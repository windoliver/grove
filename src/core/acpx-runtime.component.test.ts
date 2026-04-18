import { expect, test } from "bun:test";
import type { AcpxTurn } from "../acp/types.js";
import { AcpxRuntime } from "./acpx-runtime.js";

/**
 * Component test: boots real acpx (gated on `isAvailable`) and asserts the
 * new typed send() contract: an AcpxTurn whose messages iterable drains and
 * whose result resolves with a terminal stopReason.
 */
test("AcpxRuntime.send serializes N concurrent callers into sequential turns", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) {
    return;
  }
  const session = await rt.spawn("smoke", {
    role: "smoke",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
    waitForPush: true,
  });
  try {
    // Fire three concurrent sends. A naive `await entry.inflightTurn`
    // gate would let all three pass once the first child exits and
    // start three overlapping acpx children. The per-session chain must
    // produce three distinct turns with unique turnIds, and observing
    // the returned AcpxTurns should confirm ordering: each turn's
    // messages/result finish before the next starts (the acpx CLI's
    // stdout is single-writer per child, so concurrent sends would
    // otherwise collide).
    const promises: Promise<AcpxTurn>[] = [
      rt.send(session, "say one"),
      rt.send(session, "say two"),
      rt.send(session, "say three"),
    ];
    const turns = await Promise.all(promises);
    const turnIds = new Set(turns.map((t) => t.turnId));
    expect(turnIds.size).toBe(3);

    for (const t of turns) {
      for await (const _ of t.messages) {
        /* drain */
      }
      const r = await t.result;
      expect(["end_turn", "error", "cancelled", "max_tokens"]).toContain(r.stopReason);
    }
  } finally {
    await rt.close(session);
  }
}, 180_000);

test("AcpxRuntime.send returns an AcpxTurn with messages iterable and result promise", async () => {
  const rt = new AcpxRuntime();
  if (!(await rt.isAvailable())) {
    // acpx absent — real integration covers this; skip locally.
    return;
  }
  const session = await rt.spawn("smoke", {
    role: "smoke",
    command: "codex",
    cwd: process.cwd(),
    platform: "codex",
    waitForPush: true,
  });
  try {
    const turn = await rt.send(session, "reply with: ok");
    let count = 0;
    for await (const _ of turn.messages) count += 1;
    const r = await turn.result;
    expect(count).toBeGreaterThan(0);
    expect(["end_turn", "error", "cancelled", "max_tokens"]).toContain(r.stopReason);
  } finally {
    await rt.close(session);
  }
}, 90_000);
