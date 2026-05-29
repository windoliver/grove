import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { type AcpxKey, AcpxSupervisor } from "./acpx-supervisor.js";
import { makeInProcessLaunchOverride } from "./acpx-test-support.js";

function makeSupervisor(): AcpxSupervisor {
  return new AcpxSupervisor({
    runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
  });
}

const key: AcpxKey = { slotId: "task-1", backend: "codex", cwd: process.cwd() };
const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

describe("AcpxSupervisor registry", () => {
  test("ensure spawns one entry and is idempotent for the same slot", async () => {
    const sup = makeSupervisor();
    const a = await sup.ensure(key, cfg);
    const b = await sup.ensure(key, cfg);
    expect(b).toBe(a);
    expect(sup.list()).toHaveLength(1);
    expect(a.phase).toBe("running");
    expect(a.acpxRecordId).toBeDefined();
    await sup.stop(key.slotId, "test cleanup");
  });

  test("concurrent ensure for the same slot coalesces to one entry", async () => {
    const sup = makeSupervisor();
    const [a, b] = await Promise.all([sup.ensure(key, cfg), sup.ensure(key, cfg)]);
    expect(a).toBe(b);
    expect(sup.list()).toHaveLength(1);
    await sup.stop(key.slotId, "cleanup");
  });

  test("distinct slots get distinct entries and children", async () => {
    const sup = makeSupervisor();
    const a = await sup.ensure(key, cfg);
    const b = await sup.ensure({ ...key, slotId: "task-2" }, cfg);
    expect(a.acpxRecordId).not.toBe(b.acpxRecordId);
    expect(a.session.id).not.toBe(b.session.id);
    expect(sup.list()).toHaveLength(2);
    await sup.stop("task-1", "cleanup");
    await sup.stop("task-2", "cleanup");
  });

  test("get returns the entry; stop terminates and removes it", async () => {
    const sup = makeSupervisor();
    await sup.ensure(key, cfg);
    expect(sup.get(key.slotId)).toBeDefined();
    await sup.stop(key.slotId, "done");
    expect(sup.get(key.slotId)).toBeUndefined();
    expect(sup.list()).toHaveLength(0);
  });

  test("AgentRuntime facade: spawn routes to ensure, listSessions reflects entries", async () => {
    const sup = makeSupervisor();
    const session = await sup.spawn("coder", cfg);
    expect((await sup.listSessions()).some((s) => s.id === session.id)).toBe(true);
    await sup.close(session);
    expect((await sup.listSessions()).some((s) => s.id === session.id)).toBe(false);
  });

  test("setAcpEventSink: child events reach the downstream sink with a seq", async () => {
    const seqs: number[] = [];
    const sup = makeSupervisor();
    sup.setAcpEventSink((event) => {
      if (event.seq !== undefined) seqs.push(event.seq);
    });
    const session = await sup.spawn("coder", cfg);
    // The default in-process agent completes a turn (no streamed messages) but
    // emits a terminal "result" event through the runtime's eventSink.
    const turn = await sup.send(session, "hi");
    for await (const _ of turn.messages) {
      /* drain */
    }
    await turn.result;
    await new Promise((r) => setTimeout(r, 5));
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(seqs[0]).toBe(0);
    await sup.close(session);
  });
});
