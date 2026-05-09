/**
 * Tests for service lifecycle management (stopServices).
 *
 * startServices requires Bun.spawn and filesystem config, so we focus on
 * stopServices which accepts a RunningServices object and has testable
 * shutdown logic (SIGTERM → wait → SIGKILL).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunningServices } from "./service-lifecycle.js";
import * as lifecycle from "./service-lifecycle.js";
import { stopServices } from "./service-lifecycle.js";

const helpers = lifecycle as typeof lifecycle & {
  resolveBunExecutable?: (execPath?: string) => string;
  resolveServicePort?: (name: string, env?: NodeJS.ProcessEnv) => number;
};

// ---------------------------------------------------------------------------
// Helpers — fake child process objects
// ---------------------------------------------------------------------------

function makeFakeChild(name: string, opts?: { hangOnExit?: boolean }) {
  const signals: string[] = [];
  let resolveExited: (code: number) => void;

  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  // If not hanging, resolve immediately after SIGTERM.
  // Always resolve on SIGKILL to avoid dangling promises.
  const proc = {
    pid: Math.floor(Math.random() * 90_000) + 10_000,
    kill(signal: string) {
      signals.push(signal);
      if (!opts?.hangOnExit && signal === "SIGTERM") {
        resolveExited!(0);
      }
      if (signal === "SIGKILL") {
        resolveExited!(137);
      }
    },
    get exited() {
      return exitedPromise;
    },
  };

  return {
    child: { name, pid: proc.pid, proc } as unknown as RunningServices["children"][number],
    signals,
    forceExit: () => resolveExited!(1),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stopServices", () => {
  let tempDir: string;

  afterEach(() => {
    // Clean up temp dirs (best-effort)
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("sends SIGTERM and waits for graceful exit", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, "{}");

    const { child, signals } = makeFakeChild("server");

    const services: RunningServices = {
      children: [child],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    await stopServices(services);

    expect(signals).toContain("SIGTERM");
    // Should NOT have needed SIGKILL since our fake exits immediately
    expect(signals).not.toContain("SIGKILL");
    // PID file should be cleaned up
    expect(existsSync(pidFile)).toBe(false);
  });

  test("sends SIGKILL when child does not exit within timeout", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, "{}");

    const { child, signals } = makeFakeChild("hung-server", { hangOnExit: true });

    const services: RunningServices = {
      children: [child],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // stopServices has a 5s deadline but our fake never resolves on SIGTERM,
    // so it should escalate to SIGKILL after timeout
    await stopServices(services);

    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  }, 10_000);

  test("handles empty children list without error", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");

    const services: RunningServices = {
      children: [],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // Should not throw
    await stopServices(services);
  });

  test("tolerates kill throwing (process already dead)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "grove-test-"));
    const pidFile = join(tempDir, "grove.pid");

    const proc = {
      pid: 99999,
      kill() {
        throw new Error("No such process");
      },
      exited: Promise.resolve(0),
    };

    const services: RunningServices = {
      children: [
        { name: "dead-server", pid: 99999, proc } as unknown as RunningServices["children"][number],
      ],
      nexusManaged: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    // Should not throw even though kill() throws
    await stopServices(services);
  });
});

describe("service startup configuration", () => {
  test("server uses PORT while MCP uses MCP_PORT", () => {
    expect(helpers.resolveServicePort).toBeDefined();
    const resolveServicePort = helpers.resolveServicePort;
    if (resolveServicePort === undefined) throw new Error("resolveServicePort is not exported");

    expect(resolveServicePort("server", { PORT: "5515" } as NodeJS.ProcessEnv)).toBe(5515);
    expect(resolveServicePort("mcp", { MCP_PORT: "4415" } as NodeJS.ProcessEnv)).toBe(4415);
    expect(resolveServicePort("mcp", { PORT: "5515" } as NodeJS.ProcessEnv)).toBe(4015);
  });

  test("spawned services prefer the current Bun executable when available", () => {
    expect(helpers.resolveBunExecutable).toBeDefined();
    const resolveBunExecutable = helpers.resolveBunExecutable;
    if (resolveBunExecutable === undefined) throw new Error("resolveBunExecutable is not exported");

    expect(resolveBunExecutable("/Users/example/.bun/bin/bun")).toBe("/Users/example/.bun/bin/bun");
    expect(resolveBunExecutable("/usr/local/bin/node")).toBe("bun");
  });
});

// ---------------------------------------------------------------------------
// Foreign-server detection (regression: orphan grove-server from a deleted
// worktree was silently reused by `grove up`, producing 401s in the TUI).
// ---------------------------------------------------------------------------

describe("verifyServerOwnership — foreign-listener detection", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let port: number;
  let groveDir: string;

  function startFakeServer(handler: (req: Request) => Response | Promise<Response>) {
    server = Bun.serve({ port: 0, fetch: handler });
    if (server.port === undefined) throw new Error("Bun.serve returned no port");
    port = server.port;
  }

  afterEach(async () => {
    if (server) {
      server.stop();
      server = undefined;
    }
  });

  test("returns ok=true when listener authorizes our key", async () => {
    groveDir = mkdtempSync(join(tmpdir(), "verify-ok-"));
    writeFileSync(join(groveDir, "api-key"), "grv_correct\n", { mode: 0o600 });
    startFakeServer((req) => {
      const auth = req.headers.get("Authorization");
      if (auth === "Bearer grv_correct")
        return Response.json({ items: [], listResourceVersion: "0" });
      return new Response("nope", { status: 401 });
    });
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(true);
  });

  test("returns ok=false with 401 reason when listener has foreign registry", async () => {
    groveDir = mkdtempSync(join(tmpdir(), "verify-foreign-"));
    writeFileSync(join(groveDir, "api-key"), "grv_ours\n", { mode: 0o600 });
    startFakeServer(
      () =>
        new Response(JSON.stringify({ error: { code: "NAMESPACE_UNAUTHORIZED" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("401");
    }
  });

  test("returns ok=false when no api-key file exists", async () => {
    groveDir = mkdtempSync(join(tmpdir(), "verify-nokey-"));
    startFakeServer(() => Response.json({}));
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No api-key");
  });

  test("returns ok=false on non-401 error status", async () => {
    groveDir = mkdtempSync(join(tmpdir(), "verify-500-"));
    writeFileSync(join(groveDir, "api-key"), "grv_x\n", { mode: 0o600 });
    startFakeServer(() => new Response("boom", { status: 500 }));
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("500");
  });

  test("returns ok=false when listener accepts ANY bearer (auth not enforced)", async () => {
    // Permissive listener squatting on the port: 200s on every call.
    // The bogus-key probe must catch this before we leak the real key.
    groveDir = mkdtempSync(join(tmpdir(), "verify-permissive-"));
    writeFileSync(join(groveDir, "api-key"), "grv_real\n", { mode: 0o600 });
    let realKeySeen = false;
    startFakeServer((req) => {
      if (req.headers.get("Authorization") === "Bearer grv_real") realKeySeen = true;
      return Response.json({ items: [], listResourceVersion: "0" });
    });
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bogus.*auth.*not.*enforced/i);
    // Defense-in-depth: the real key must not have been sent once we knew
    // auth wasn't enforced.
    expect(realKeySeen).toBe(false);
  });

  test("returns ok=false when authed response shape isn't Grove ListResponse", async () => {
    // Listener that 401s strangers (passes step 1) but responds to our key
    // with a non-Grove shape — e.g. a different service that happens to
    // namespace its bearers identically. Must reject.
    groveDir = mkdtempSync(join(tmpdir(), "verify-shape-"));
    writeFileSync(join(groveDir, "api-key"), "grv_match\n", { mode: 0o600 });
    startFakeServer((req) => {
      const auth = req.headers.get("Authorization");
      if (auth === "Bearer grv_match")
        return Response.json({ status: "ok", message: "hello from not-grove" });
      return new Response("nope", { status: 401 });
    });
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shape|grove-server/i);
  });

  test("returns ok=false when authed response is not JSON", async () => {
    groveDir = mkdtempSync(join(tmpdir(), "verify-nonjson-"));
    writeFileSync(join(groveDir, "api-key"), "grv_match\n", { mode: 0o600 });
    startFakeServer((req) => {
      const auth = req.headers.get("Authorization");
      if (auth === "Bearer grv_match")
        return new Response("plain text body", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      return new Response("nope", { status: 401 });
    });
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/JSON|grove-server/i);
  });
});
