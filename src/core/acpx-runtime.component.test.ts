import { expect, test } from "bun:test";
import { AcpxRuntime } from "./acpx-runtime.js";

/**
 * Component test: boots real acpx (gated on `isAvailable`) and asserts the
 * new typed send() contract: an AcpxTurn whose messages iterable drains and
 * whose result resolves with a terminal stopReason.
 */
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
