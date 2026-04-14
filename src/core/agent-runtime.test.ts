import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "./agent-runtime.js";
import { MockRuntime } from "./mock-runtime.js";

const config: AgentConfig = {
  role: "coder",
  command: "echo hello",
  cwd: "/tmp",
};

describe("AgentRuntime contract (MockRuntime)", () => {
  test("spawn creates a running session", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", config);
    expect(session.id).toBeTruthy();
    expect(session.role).toBe("coder");
    expect(session.status).toBe("running");
  });

  test("spawn records the call", async () => {
    const rt = new MockRuntime();
    await rt.spawn("coder", config);
    expect(rt.spawnCalls).toHaveLength(1);
    expect(rt.spawnCalls[0]!.role).toBe("coder");
  });

  test("send records the message", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", config);
    await rt.send(session, "implement auth");
    expect(rt.sendCalls).toHaveLength(1);
    expect(rt.sendCalls[0]!.message).toBe("implement auth");
  });

  test("close marks session as stopped", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", config);
    await rt.close(session);
    expect(rt.closeCalls).toHaveLength(1);
    const sessions = await rt.listSessions();
    expect(sessions[0]!.status).toBe("stopped");
  });

  test("onIdle callback fires when triggered", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", config);
    let idled = false;
    rt.onIdle(session, () => {
      idled = true;
    });
    rt.triggerIdle(session.id);
    expect(idled).toBe(true);
  });

  test("listSessions returns all sessions", async () => {
    const rt = new MockRuntime();
    await rt.spawn("coder", config);
    await rt.spawn("reviewer", { ...config, role: "reviewer" });
    const sessions = await rt.listSessions();
    expect(sessions).toHaveLength(2);
  });

  test("isAvailable returns true by default", async () => {
    const rt = new MockRuntime();
    expect(await rt.isAvailable()).toBe(true);
  });

  test("setAvailable controls isAvailable", async () => {
    const rt = new MockRuntime();
    rt.setAvailable(false);
    expect(await rt.isAvailable()).toBe(false);
  });

  test("reset clears all state", async () => {
    const rt = new MockRuntime();
    await rt.spawn("coder", config);
    await rt.send({ id: "mock-coder-0", role: "coder", status: "running" }, "test");
    rt.reset();
    expect(rt.spawnCalls).toHaveLength(0);
    expect(rt.sendCalls).toHaveLength(0);
    expect(await rt.listSessions()).toHaveLength(0);
  });

  test("multiple sessions get unique IDs", async () => {
    const rt = new MockRuntime();
    const s1 = await rt.spawn("coder", config);
    const s2 = await rt.spawn("coder", config);
    expect(s1.id).not.toBe(s2.id);
  });

  // --- Platform/model metadata propagation ---

  test("spawn propagates platform from config to session", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", { ...config, platform: "claude-code" });
    expect(session.platform).toBe("claude-code");
  });

  test("spawn propagates model from config to session", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", { ...config, model: "claude-opus-4-6" });
    expect(session.model).toBe("claude-opus-4-6");
  });

  test("spawn leaves platform/model undefined when not in config", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", config);
    expect(session.platform).toBeUndefined();
    expect(session.model).toBeUndefined();
  });

  test("getSessionMetadata returns platform and model", async () => {
    const rt = new MockRuntime();
    const session = await rt.spawn("coder", {
      ...config,
      platform: "codex",
      model: "gpt-4.1",
    });
    const meta = rt.getSessionMetadata(session.id);
    expect(meta).toBeDefined();
    expect(meta!.platform).toBe("codex");
    expect(meta!.model).toBe("gpt-4.1");
  });

  test("getSessionMetadata returns undefined for unknown session", () => {
    const rt = new MockRuntime();
    expect(rt.getSessionMetadata("nonexistent")).toBeUndefined();
  });

  test("spawnCalls captures platform and model in config", async () => {
    const rt = new MockRuntime();
    await rt.spawn("coder", { ...config, platform: "gemini", model: "gemini-2.5" });
    expect(rt.spawnCalls[0]!.config.platform).toBe("gemini");
    expect(rt.spawnCalls[0]!.config.model).toBe("gemini-2.5");
  });
});
