import { expect, test } from "bun:test";
import type { AgentRuntime } from "./agent-runtime.js";

/**
 * Shared conformance matrix every AgentRuntime must satisfy (#210). Call inside
 * a describe() block. The factory must return a fresh, isolated runtime per call.
 */
export function runRuntimeAdapterMatrix(label: string, factory: () => AgentRuntime): void {
  const cfg = { role: "coder", command: "codex", cwd: process.cwd() };

  test(`${label}: spawn returns a running session`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    expect(s.role).toBe("coder");
    expect(s.status).toBe("running");
    await rt.close(s);
  });

  test(`${label}: listSessions reflects spawn then close`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    expect((await rt.listSessions()).some((x) => x.id === s.id)).toBe(true);
    await rt.close(s);
    expect((await rt.listSessions()).some((x) => x.id === s.id)).toBe(false);
  });

  test(`${label}: distinct spawns get distinct ids`, async () => {
    const rt = factory();
    const a = await rt.spawn("coder", cfg);
    const b = await rt.spawn("coder", cfg);
    expect(a.id).not.toBe(b.id);
    await rt.close(a);
    await rt.close(b);
  });

  test(`${label}: send returns a typed AcpxTurn that resolves`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    const turn = await rt.send(s, "hello");
    expect(turn.sessionId).toBeDefined();
    for await (const _ of turn.messages) {
      /* drain */
    }
    const result = await turn.result;
    expect(typeof result.stopReason).toBe("string");
    await rt.close(s);
  });

  test(`${label}: close is idempotent`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    await rt.close(s);
    await rt.close(s); // must not throw
    expect(true).toBe(true);
  });

  test(`${label}: listSessionEntities returns AgentSession entities`, async () => {
    const rt = factory();
    const s = await rt.spawn("coder", cfg);
    const entities = await rt.listSessionEntities();
    expect(entities.every((e) => e.kind === "AgentSession")).toBe(true);
    await rt.close(s);
  });
}
