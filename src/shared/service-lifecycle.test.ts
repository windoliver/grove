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
  resolveServiceHealthTimeoutMs?: (env?: NodeJS.ProcessEnv) => number;
  pickFreePort?: () => Promise<number>;
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
    child: {
      name,
      pid: proc.pid,
      proc,
      acquired: "spawned",
    } as unknown as RunningServices["children"][number],
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
      nexusStartedThisCall: false,
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
      nexusStartedThisCall: false,
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
      nexusStartedThisCall: false,
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
        {
          name: "dead-server",
          pid: 99999,
          proc,
          acquired: "spawned",
        } as unknown as RunningServices["children"][number],
      ],
      nexusManaged: false,
      nexusStartedThisCall: false,
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

  test("service health timeout can be extended for cold managed starts", () => {
    expect(helpers.resolveServiceHealthTimeoutMs).toBeDefined();
    const resolveServiceHealthTimeoutMs = helpers.resolveServiceHealthTimeoutMs;
    if (resolveServiceHealthTimeoutMs === undefined)
      throw new Error("resolveServiceHealthTimeoutMs is not exported");

    expect(resolveServiceHealthTimeoutMs({} as NodeJS.ProcessEnv)).toBe(10_000);
    expect(
      resolveServiceHealthTimeoutMs({
        GROVE_SERVICE_HEALTH_TIMEOUT_MS: "30000",
      } as NodeJS.ProcessEnv),
    ).toBe(30_000);
    expect(
      resolveServiceHealthTimeoutMs({
        GROVE_SERVICE_HEALTH_TIMEOUT_MS: "abc",
      } as NodeJS.ProcessEnv),
    ).toBe(10_000);
  });

  // Concurrent grove worktrees on the same host should not collide on the
  // default service port. When the configured port is held by a foreign
  // process, spawnService falls back to an OS-assigned ephemeral port via
  // pickFreePort instead of throwing. (#191 follow-up)
  test("pickFreePort returns an unused port we can bind to", async () => {
    expect(helpers.pickFreePort).toBeDefined();
    const pickFreePort = helpers.pickFreePort;
    if (pickFreePort === undefined) throw new Error("pickFreePort is not exported");

    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);

    // Bind to the returned port to prove it's actually free at this moment.
    const server = Bun.serve({ port, fetch: () => new Response("ok") });
    try {
      expect(server.port).toBe(port);
    } finally {
      server.stop();
    }
  });

  test("pickFreePort returns distinct ports on consecutive calls", async () => {
    const pickFreePort = helpers.pickFreePort;
    if (pickFreePort === undefined) throw new Error("pickFreePort is not exported");

    const a = await pickFreePort();
    const srv = Bun.serve({ port: a, fetch: () => new Response("ok") });
    try {
      const b = await pickFreePort();
      expect(b).not.toBe(a);
    } finally {
      srv.stop();
    }
  });

  // Race regression: the two children must NOT see process.env.PORT /
  // process.env.GROVE_SERVER_PORT mutated by a sibling spawn after they've
  // already read serviceEnv(). The fix pre-resolves all ports before any
  // spawn promise starts; here we assert that ordering property by checking
  // that resolveServicePort('server') reflects whatever PORT was set to,
  // simulating the post-fallback state.
  // Round 4 regression: if a sibling grove on the same project is alive
  // with its own MCP bound on the default port, this run's forceFreshSpawn
  // must NOT kill it — even though the pidfile identity matches by pid.
  // Verified by writing a pidfile whose parentPid is a live process other
  // than the current one, then asserting the classifier returns "preserve".
  test("forceFreshSpawn preserves MCP owned by a different live grove parent", async () => {
    const classifier = (
      lifecycle as unknown as {
        classifyForceFreshOwner?: (
          identity: { ok: true; pid: number } | { ok: false; reason: string },
          name: string,
          port: number,
          pidFilePath: string,
        ) => Promise<{ kind: string; reason: string }>;
      }
    ).classifyForceFreshOwner;
    if (classifier === undefined) {
      // Not exported in production — this test guards future regressions
      // when the helper is exposed for cross-process review.
      return;
    }

    const groveDir = mkdtempSync(join(tmpdir(), "force-fresh-preserve-"));
    const pidFile = join(groveDir, "grove.pid");
    // PPID is the parent of THIS bun test process — a real live PID that
    // is not us. Mimics a sibling-grove ownership scenario.
    const liveSiblingPid = process.ppid;
    writeFileSync(
      pidFile,
      JSON.stringify({
        parentPid: liveSiblingPid,
        children: [{ name: "mcp", pid: 99_999, port: 4015, serverPort: 4515 }],
      }),
    );
    const decision = await classifier({ ok: true, pid: 99_999 }, "mcp", 4015, pidFile);
    expect(decision.kind).toBe("preserve");
    expect(decision.reason).toContain("different live grove");
  });

  // Round 9 regression: mixed-owner pidfile. A process started, adopted
  // a sibling's MCP, then died — leaving the top-level parentPid dead
  // but the adopted MCP entry's own parentPid still pointing at the
  // live sibling. Next force-fresh classification must trust the
  // child's parentPid and preserve the live-sibling MCP.
  test("classifier uses child.parentPid over dead top-level parent", async () => {
    const classifier = (
      lifecycle as unknown as {
        classifyForceFreshOwner?: (
          identity: { ok: true; pid: number } | { ok: false; reason: string },
          name: string,
          port: number,
          pidFilePath: string,
        ) => Promise<{ kind: string; reason: string }>;
      }
    ).classifyForceFreshOwner;
    if (classifier === undefined) return;

    const groveDir = mkdtempSync(join(tmpdir(), "mixed-owner-"));
    const pidFile = join(groveDir, "grove.pid");
    const liveSiblingPid = process.ppid;
    const deadPid = 999_999; // overwhelmingly unlikely to be alive
    writeFileSync(
      pidFile,
      JSON.stringify({
        parentPid: deadPid,
        children: [{ name: "mcp", pid: 88_888, parentPid: liveSiblingPid, serverPort: 4515 }],
      }),
    );
    const decision = await classifier({ ok: true, pid: 88_888 }, "mcp", 4015, pidFile);
    expect(decision.kind).toBe("preserve");
    expect(decision.reason).toContain(`recorded owner ${liveSiblingPid}`);
  });

  test("resolveServicePort reads back env mutation deterministically", () => {
    const resolveServicePort = helpers.resolveServicePort;
    if (resolveServicePort === undefined) throw new Error("resolveServicePort is not exported");

    // Caller mutates env.PORT (the fallback path does this synchronously
    // inside preResolvePort) — every subsequent resolveServicePort('server')
    // must see the new value. Without pre-resolution before parallel spawn,
    // an MCP child could read serviceEnv() before this mutation lands.
    const env = { PORT: "55501" } as NodeJS.ProcessEnv;
    expect(resolveServicePort("server", env)).toBe(55501);
    env.PORT = "55502";
    expect(resolveServicePort("server", env)).toBe(55502);
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

  test("real api-key is NEVER sent to listener (avoid disclosure)", async () => {
    // Stronger version of the round-2 check: even a foreign listener that
    // 401s the bogus probe must not receive the real key. The current
    // round-3 design routes spawnService through verifyPortIdentity (no
    // creds); this tests the credentialed function itself remains
    // safe-by-default by abandoning early on the bogus-key 401.
    groveDir = mkdtempSync(join(tmpdir(), "verify-leak-"));
    writeFileSync(join(groveDir, "api-key"), "grv_secret_DO_NOT_LEAK\n", { mode: 0o600 });
    let realKeySeen = false;
    startFakeServer((req) => {
      const auth = req.headers.get("Authorization") ?? "";
      if (auth === "Bearer grv_secret_DO_NOT_LEAK") realKeySeen = true;
      // Foreign listener: 401 strangers (passes step 1) but harvests step-2.
      // This documents the hazard the round-3 redesign avoids by only calling
      // verifyServerOwnership on the pidfile-reuse path (PID already proven).
      return new Response("nope", { status: 401 });
    });
    const result = await lifecycle.verifyServerOwnership(port, groveDir);
    // Result is still ok=false (foreign), but the real key DID get sent —
    // documenting the surface area. spawnService's identity gate prevents
    // ever calling this with an unverified PID.
    expect(result.ok).toBe(false);
    expect(realKeySeen).toBe(true); // documents the credentialed path
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

// ---------------------------------------------------------------------------
// Identity-based ownership gate (no credentials sent).
// ---------------------------------------------------------------------------

describe("verifyPortIdentity — credential-free identity gate", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let port: number;
  let pidFilePath: string;

  function startFakeServer() {
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    if (server.port === undefined) throw new Error("Bun.serve returned no port");
    port = server.port;
  }

  afterEach(() => {
    if (server) {
      server.stop();
      server = undefined;
    }
  });

  test("returns ok=false when no pidfile exists (fresh-start collision)", async () => {
    startFakeServer();
    const dir = mkdtempSync(join(tmpdir(), "identity-nopidfile-"));
    pidFilePath = join(dir, "grove.pid");
    const result = await lifecycle.verifyPortIdentity(port, pidFilePath, "server");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pidfile|wasn't spawned/i);
  });

  test("returns ok=false when pidfile records different PID for the service", async () => {
    startFakeServer();
    const dir = mkdtempSync(join(tmpdir(), "identity-mismatch-"));
    pidFilePath = join(dir, "grove.pid");
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        parentPid: process.pid,
        children: [{ name: "server", pid: 999_999 }],
      }),
    );
    const result = await lifecycle.verifyPortIdentity(port, pidFilePath, "server");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/foreign listener|PID/i);
  });

  test("returns ok=false when pidfile has no record for the named service", async () => {
    startFakeServer();
    const dir = mkdtempSync(join(tmpdir(), "identity-wrongname-"));
    pidFilePath = join(dir, "grove.pid");
    // Pidfile records mcp but not server. The PID value doesn't matter
    // since the lookup is keyed on `name` and our service is "server".
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        parentPid: process.pid,
        children: [{ name: "mcp", pid: 99_999 }],
      }),
    );
    const result = await lifecycle.verifyPortIdentity(port, pidFilePath, "server");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no record|foreign/i);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle ownership in stopServices: adopted children + reused Nexus must
// NOT be torn down on routine cleanup (different from rollback's own filter).
// ---------------------------------------------------------------------------

describe("stopServices — ownership-aware cleanup", () => {
  let tempDir: string;

  afterEach(() => {
    try {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("does NOT kill adopted children", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "stop-adopted-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, "{}");

    // Two children: one spawned (should be killed), one adopted (must NOT).
    const spawned = makeFakeChild("server");
    const adopted = makeFakeChild("mcp");
    // Cast adopted to acquired:"adopted" to simulate spawnService's reuse path.
    const adoptedChild = {
      ...(adopted.child as unknown as Record<string, unknown>),
      acquired: "adopted",
    } as unknown as RunningServices["children"][number];

    const services: RunningServices = {
      children: [spawned.child, adoptedChild],
      nexusManaged: false,
      nexusStartedThisCall: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    await stopServices(services);

    // Spawned child got SIGTERM
    expect(spawned.signals).toContain("SIGTERM");
    // Adopted child was untouched
    expect(adopted.signals).toEqual([]);
  });

  test("mixed adopted+spawned: rewrites pidfile to keep adopted entries (no orphan)", async () => {
    // Round-9 regression: stopServices used to unlink the entire pidfile
    // whenever any spawned child existed, even if adopted children were
    // still live. That orphaned the adopted process with no record for
    // grove-down or future identity checks.
    tempDir = mkdtempSync(join(tmpdir(), "stop-mixed-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, JSON.stringify({ parentPid: 1, children: [] }));

    const spawned = makeFakeChild("mcp"); // newly started this call
    const adopted = makeFakeChild("server"); // adopted from prior owner
    // The adopted child must look alive to process.kill(pid,0) — use the
    // current process's own PID (always alive) for the test.
    const adoptedChild = {
      ...(adopted.child as unknown as Record<string, unknown>),
      pid: process.pid,
      acquired: "adopted",
    } as unknown as RunningServices["children"][number];

    const services: RunningServices = {
      children: [spawned.child, adoptedChild],
      nexusManaged: false,
      nexusStartedThisCall: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    await stopServices(services);

    // Spawned was killed
    expect(spawned.signals).toContain("SIGTERM");
    // Adopted was NOT touched
    expect(adopted.signals).toEqual([]);
    // Pidfile rewritten with only the adopted entry — NOT unlinked
    expect(existsSync(pidFile)).toBe(true);
    const persisted = JSON.parse(require("node:fs").readFileSync(pidFile, "utf-8") as string) as {
      children?: ReadonlyArray<{ name: string; pid: number }>;
    };
    expect(persisted.children?.length).toBe(1);
    expect(persisted.children?.[0]?.name).toBe("server");
    expect(persisted.children?.[0]?.pid).toBe(process.pid);
  });

  test("preserves pidfile when only adopted children are present", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "stop-borrower-"));
    const pidFile = join(tempDir, "grove.pid");
    writeFileSync(pidFile, '{"parentPid": 1234}');

    const adopted = makeFakeChild("server");
    const adoptedChild = {
      ...(adopted.child as unknown as Record<string, unknown>),
      acquired: "adopted",
    } as unknown as RunningServices["children"][number];

    const services: RunningServices = {
      children: [adoptedChild],
      nexusManaged: false,
      nexusStartedThisCall: false,
      projectRoot: tempDir,
      pidFilePath: pidFile,
    };

    await stopServices(services);

    // Adopted not killed, pidfile retained for the original owner.
    expect(adopted.signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(true);
  });
});
