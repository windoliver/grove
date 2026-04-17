import { expect, test } from "bun:test";
import { MockRuntime } from "./mock-runtime.js";

test("MockRuntime.send returns a drainable AcpxTurn with canned messages", async () => {
  const rt = new MockRuntime();
  const s = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  rt.enqueueMessages(s.id, [{ kind: "text", turnId: "auto", text: "ok", chunk: true }]);
  rt.enqueueResult(s.id, { turnId: "auto", stopReason: "end_turn" });

  const turn = await rt.send(s, "hi");
  const got = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  expect(got).toHaveLength(1);
  expect(got[0]!.kind).toBe("text");
  expect(r.stopReason).toBe("end_turn");
});

test("MockRuntime.send returns default end_turn result when no result enqueued", async () => {
  const rt = new MockRuntime();
  const s = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  const turn = await rt.send(s, "hi");
  const r = await turn.result;
  expect(r.stopReason).toBe("end_turn");
});

test("MockRuntime queues are drained per turn (not reused)", async () => {
  const rt = new MockRuntime();
  const s = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  rt.enqueueMessages(s.id, [{ kind: "text", turnId: "t1", text: "one", chunk: true }]);
  rt.enqueueResult(s.id, { turnId: "t1", stopReason: "end_turn" });

  const first = await rt.send(s, "msg1");
  for await (const _ of first.messages) { /* drain */ }
  await first.result;

  // Second send without re-enqueueing: empty messages, default result.
  const second = await rt.send(s, "msg2");
  const got: unknown[] = [];
  for await (const m of second.messages) got.push(m);
  const r = await second.result;
  expect(got).toHaveLength(0);
  expect(r.stopReason).toBe("end_turn");
});

test("MockRuntime.reset clears queues", async () => {
  const rt = new MockRuntime();
  const s = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  rt.enqueueMessages(s.id, [{ kind: "text", turnId: "t1", text: "one", chunk: true }]);
  rt.reset();
  const s2 = await rt.spawn("coder", { role: "coder", command: "codex", cwd: "." });
  const turn = await rt.send(s2, "hi");
  const got: unknown[] = [];
  for await (const m of turn.messages) got.push(m);
  expect(got).toHaveLength(0);
});
