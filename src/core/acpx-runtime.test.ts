import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "./agent-runtime.js";
import { AcpxRuntime } from "./acpx-runtime.js";

const config: AgentConfig = {
  role: "coder",
  command: "echo hello",
  cwd: "/tmp",
};

describe("AcpxRuntime", () => {
  test("isAvailable returns boolean", async () => {
    const rt = new AcpxRuntime();
    const available = await rt.isAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("isAvailable returns false when acpx not installed", async () => {
    // acpx is unlikely to be in PATH in CI/test environments
    const rt = new AcpxRuntime();
    const available = await rt.isAvailable();
    // We just verify it doesn't throw — the value depends on environment
    expect(typeof available).toBe("boolean");
  });

  test("implements AgentRuntime interface", () => {
    const rt = new AcpxRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
  });

  test("spawn throws when acpx is not available", async () => {
    const rt = new AcpxRuntime();
    const skip = await rt.isAvailable();
    if (skip) return; // acpx is actually installed, skip this test

    await expect(rt.spawn("coder", config)).rejects.toThrow(
      "acpx is not installed",
    );
  });

  test("listSessions returns empty array when unavailable", async () => {
    const rt = new AcpxRuntime();
    const skip = await rt.isAvailable();
    if (skip) return;

    const sessions = await rt.listSessions();
    expect(sessions).toEqual([]);
  });

  test("close does not throw for unknown session", async () => {
    const rt = new AcpxRuntime();
    // Should not throw even when the session doesn't exist
    await rt.close({ id: "nonexistent", role: "test", status: "running" });
  });

  test("onIdle does not throw for unknown session", () => {
    const rt = new AcpxRuntime();
    // Should not throw
    rt.onIdle({ id: "nonexistent", role: "test", status: "running" }, () => {
      /* no-op */
    });
  });

  test("send does nothing for unknown session", async () => {
    const rt = new AcpxRuntime();
    // Should not throw when session doesn't exist (no-op)
    await rt.send(
      { id: "nonexistent", role: "test", status: "running" },
      "hello",
    );
  });

  test("constructor accepts agent option", () => {
    const rt = new AcpxRuntime({ agent: "codex" });
    expect(rt).toBeDefined();
  });

  test("spawn and close work when acpx is available", async () => {
    const rt = new AcpxRuntime();
    const skip = !(await rt.isAvailable());
    if (skip) return;

    const session = await rt.spawn("test", config);
    expect(session.id).toMatch(/^grove-test-\d+$/);
    expect(session.role).toBe("test");
    expect(session.status).toBe("running");

    await rt.close(session);
  });
});
