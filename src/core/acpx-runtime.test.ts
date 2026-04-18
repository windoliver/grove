import { describe, expect, test } from "bun:test";
import { AcpxRuntime } from "./acpx-runtime.js";
import type { AgentConfig } from "./agent-runtime.js";

const config: AgentConfig = {
  role: "coder",
  command: "echo hello",
  cwd: "/tmp",
};

/** Check if acpx is available (cached for the test run). */
let _acpxAvailable: boolean | undefined;
async function isAcpxAvailable(): Promise<boolean> {
  if (_acpxAvailable === undefined) {
    const rt = new AcpxRuntime();
    _acpxAvailable = await rt.isAvailable();
  }
  return _acpxAvailable;
}

describe("AcpxRuntime", () => {
  test("isAvailable returns boolean", async () => {
    const rt = new AcpxRuntime();
    const available = await rt.isAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("isAvailable caches its result", async () => {
    const rt = new AcpxRuntime();
    const first = await rt.isAvailable();
    const second = await rt.isAvailable();
    expect(first).toBe(second);
  });

  test("implements AgentRuntime interface", () => {
    const rt = new AcpxRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
    expect(typeof rt.resolveAgent).toBe("function");
    expect(typeof rt.discoverSessions).toBe("function");
  });

  test("spawn throws when acpx is not available", async () => {
    const available = await isAcpxAvailable();
    if (available) {
      // Skip — acpx is installed in this environment
      console.log("[SKIP] acpx is installed, skipping unavailable test");
      return;
    }

    const rt = new AcpxRuntime();
    await expect(rt.spawn("coder", config)).rejects.toThrow("acpx is not installed");
  });

  test("listSessions returns empty array when unavailable", async () => {
    const available = await isAcpxAvailable();
    if (available) {
      console.log("[SKIP] acpx is installed, skipping unavailable test");
      return;
    }

    const rt = new AcpxRuntime();
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

  test("send does nothing for unknown session (creates reattach entry)", async () => {
    const rt = new AcpxRuntime();
    // Should not throw when session doesn't exist — creates reattach entry
    await rt.send({ id: "nonexistent", role: "test", status: "running" }, "hello");
  });

  test("send uses session.agent for reattach entry", async () => {
    const rt = new AcpxRuntime({ agent: "codex" });
    const session = {
      id: "test-session",
      role: "test",
      status: "running" as const,
      agent: "claude",
    };
    // This will create a reattach entry using session.agent ("claude") not the default ("codex")
    await rt.send(session, "hello");
    // We can't directly inspect the entry, but the session is now tracked
    const sessions = await rt.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe("test-session");
  });

  test("constructor accepts agent option", () => {
    const rt = new AcpxRuntime({ agent: "codex" });
    expect(rt).toBeDefined();
  });

  // Timeout bumped to 30s because acpx cold-start can take >5s when the
  // agent adapter has to be fetched via npx or when the host is under load.
  test("spawn and close work when acpx is available", async () => {
    const available = await isAcpxAvailable();
    if (!available) {
      console.log("[SKIP] acpx not installed, skipping integration test");
      return;
    }

    const rt = new AcpxRuntime();
    // Session names now carry a per-spawn counter and a base36 timestamp:
    // grove-<role>-<counter>--<timestamp> (double dash separator).
    const session = await rt.spawn("test", config);
    expect(session.id).toMatch(/^grove-test-\d+--[a-z0-9]+$/);
    expect(session.role).toBe("test");
    expect(session.status).toBe("running");

    await rt.close(session);
  }, 30_000);

  test("spawn returns platform/model metadata when provided", async () => {
    const available = await isAcpxAvailable();
    if (!available) {
      console.log("[SKIP] acpx not installed, skipping integration test");
      return;
    }

    const rt = new AcpxRuntime();
    const session = await rt.spawn("test", {
      ...config,
      platform: "codex",
      model: "gpt-4.1",
    });

    expect(session.platform).toBe("codex");
    expect(session.model).toBe("gpt-4.1");
    expect(session.agent).toBe("codex");

    await rt.close(session);
  }, 30_000);

  test("spawn returns agent field matching resolved backend", async () => {
    const available = await isAcpxAvailable();
    if (!available) {
      console.log("[SKIP] acpx not installed, skipping integration test");
      return;
    }

    const rt = new AcpxRuntime();
    const session = await rt.spawn("test", {
      ...config,
      platform: "claude-code",
    });

    expect(session.agent).toBe("claude");

    await rt.close(session);
  }, 30_000);
});
