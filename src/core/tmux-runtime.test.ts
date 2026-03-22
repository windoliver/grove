import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "./agent-runtime.js";
import { TmuxRuntime } from "./tmux-runtime.js";

const config: AgentConfig = {
  role: "coder",
  command: "echo hello",
  cwd: "/tmp",
};

describe("TmuxRuntime", () => {
  test("isAvailable returns boolean", async () => {
    const rt = new TmuxRuntime();
    const available = await rt.isAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("listSessions returns an array", async () => {
    const rt = new TmuxRuntime();
    const sessions = await rt.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("implements AgentRuntime interface", () => {
    const rt = new TmuxRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
  });

  test("spawn and close work when tmux is available", async () => {
    const rt = new TmuxRuntime();
    const skip = !(await rt.isAvailable());
    if (skip) return;

    const session = await rt.spawn("test", config);
    expect(session.id).toMatch(/^grove-test-\d+$/);
    expect(session.role).toBe("test");
    expect(session.status).toBe("running");

    // Clean up
    await rt.close(session);
  });

  test("send works when tmux is available", async () => {
    const rt = new TmuxRuntime();
    const skip = !(await rt.isAvailable());
    if (skip) return;

    // Use bash so the session stays alive to receive send-keys
    const session = await rt.spawn("send-test", {
      ...config,
      command: "bash",
    });

    // Should not throw
    await rt.send(session, "echo test-message");

    // Clean up
    await rt.close(session);
  });

  test("close is idempotent", async () => {
    const rt = new TmuxRuntime();
    const skip = !(await rt.isAvailable());
    if (skip) return;

    const session = await rt.spawn("idem", config);
    await rt.close(session);
    // Second close should not throw
    await rt.close(session);
  });

  test("listSessions finds spawned sessions", async () => {
    const rt = new TmuxRuntime();
    const skip = !(await rt.isAvailable());
    if (skip) return;

    const session = await rt.spawn("list-test", {
      ...config,
      command: "bash",
    });

    try {
      const sessions = await rt.listSessions();
      const found = sessions.find((s) => s.id === session.id);
      expect(found).toBeTruthy();
      expect(found?.role).toBe("list-test");
    } finally {
      await rt.close(session);
    }
  });

  test("onIdle registers callback without throwing", async () => {
    const rt = new TmuxRuntime({ idlePollMs: 60000 }); // Large interval so it doesn't fire
    const skip = !(await rt.isAvailable());
    if (skip) return;

    const session = await rt.spawn("idle-test", {
      ...config,
      command: "bash",
    });

    try {
      // Should not throw
      rt.onIdle(session, () => {
        /* no-op */
      });
    } finally {
      await rt.close(session);
    }
  });
});
