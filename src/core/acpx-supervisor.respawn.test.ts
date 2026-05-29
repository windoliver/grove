import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { type AcpxKey, type AcpxRespawnEvent, AcpxSupervisor } from "./acpx-supervisor.js";
import {
  type DisconnectableHandlers,
  makeDisconnectableLaunchOverride,
} from "./acpx-test-support.js";

const key: AcpxKey = { slotId: "task-1", backend: "codex", cwd: process.cwd() };
const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

function build(
  maxRespawns = 5,
  handlers: DisconnectableHandlers = {},
): {
  sup: AcpxSupervisor;
  triggers: Array<(info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void>;
} {
  const triggers: Array<
    (info: { exitCode?: number | null; signal?: NodeJS.Signals | null }) => void
  > = [];
  const sup = new AcpxSupervisor({
    maxRespawns,
    backoffBaseMs: 0,
    sleep: async () => {},
    runtimeFactory: () => {
      const { launchOverride, onTrigger } = makeDisconnectableLaunchOverride(handlers);
      onTrigger((t) => triggers.push(t));
      return new AcpRuntime({ launchOverride });
    },
  });
  return { sup, triggers };
}

describe("AcpxSupervisor respawn", () => {
  test("disconnect drives running -> resuming -> running with a fresh session", async () => {
    const { sup, triggers } = build();
    const events: AcpxRespawnEvent[] = [];
    sup.onRespawn((e) => events.push(e));
    const entry = await sup.ensure(key, cfg);
    const firstSessionId = entry.session.id;

    triggers[0]?.({ signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 50));

    const after = sup.get(key.slotId);
    expect(after?.phase).toBe("running");
    expect(after?.session.id).not.toBe(firstSessionId);
    expect(events.map((e) => e.kind)).toEqual(["resuming", "resumed"]);
    await sup.stop(key.slotId, "cleanup");
  });

  test("lastSeq is preserved across respawn (no reset)", async () => {
    const { sup, triggers } = build();
    const entry = await sup.ensure(key, cfg);
    entry.lastSeq = 42;
    triggers[0]?.({ signal: "SIGKILL" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sup.get(key.slotId)?.lastSeq).toBe(42);
    await sup.stop(key.slotId, "cleanup");
  });

  test("after maxRespawns the slot becomes dead", async () => {
    const { sup, triggers } = build(2);
    const events: AcpxRespawnEvent[] = [];
    sup.onRespawn((e) => events.push(e));
    await sup.ensure(key, cfg);
    for (let i = 0; i < 3; i++) {
      triggers[triggers.length - 1]?.({ signal: "SIGKILL" });
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sup.get(key.slotId)?.phase).toBe("dead");
    expect(events.some((e) => e.kind === "dead")).toBe(true);
  });
});
