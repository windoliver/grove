/**
 * Unit tests for nexus-lifecycle core functions.
 *
 * Covers:
 *   Issue 9A  — ensureNexusRunning() fast path, quick-restart path, and cold-start path
 *   Issue 10A — parseNexusPortFromDockerPs() port-parsing regex
 *   Issue 11A — nexusUp() version-compatibility fallback (--timeout not supported)
 *   Issue 12A — waitForNexusHealth() state transitions (healthy, starting, timeout)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseNexusPortFromDockerPs, waitForNexusHealth } from "./nexus-lifecycle.js";

// ---------------------------------------------------------------------------
// Issue 10A — parseNexusPortFromDockerPs (pure function, table tests)
// ---------------------------------------------------------------------------

describe("parseNexusPortFromDockerPs", () => {
  test("IPv4 host-bound port", () => {
    expect(parseNexusPortFromDockerPs("0.0.0.0:27960->2026/tcp")).toBe(27960);
  });

  test("IPv6 host-bound port", () => {
    expect(parseNexusPortFromDockerPs(":::27960->2026/tcp")).toBe(27960);
  });

  test("default port 2026 bound to host", () => {
    expect(parseNexusPortFromDockerPs("0.0.0.0:2026->2026/tcp")).toBe(2026);
  });

  test("unbound internal port — no host mapping", () => {
    expect(parseNexusPortFromDockerPs("2026/tcp")).toBeUndefined();
  });

  test("different port (not 2026)", () => {
    expect(parseNexusPortFromDockerPs("0.0.0.0:8080->8080/tcp")).toBeUndefined();
  });

  test("empty string", () => {
    expect(parseNexusPortFromDockerPs("")).toBeUndefined();
  });

  test("multiple port mappings — picks 2026", () => {
    expect(parseNexusPortFromDockerPs("0.0.0.0:5432->5432/tcp, 0.0.0.0:33219->2026/tcp")).toBe(
      33219,
    );
  });

  test("port 0 is rejected as invalid", () => {
    expect(parseNexusPortFromDockerPs("0.0.0.0:0->2026/tcp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 12A — waitForNexusHealth (uses Bun.serve pattern from resolve-backend.test.ts)
// ---------------------------------------------------------------------------

describe("waitForNexusHealth", () => {
  test("resolves immediately when server responds healthy on first poll", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      },
    });
    try {
      await expect(
        waitForNexusHealth(`http://localhost:${server.port}`, 5_000),
      ).resolves.toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("keeps polling through 'starting' responses until 'healthy'", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        // First two calls: starting; third: healthy
        const status = callCount < 3 ? "starting" : "healthy";
        return new Response(JSON.stringify({ status }), { status: 200 });
      },
    });
    try {
      await expect(
        waitForNexusHealth(`http://localhost:${server.port}`, 10_000),
      ).resolves.toBeUndefined();
      expect(callCount).toBeGreaterThanOrEqual(3);
    } finally {
      server.stop(true);
    }
  });

  test("throws after timeoutMs if server never becomes healthy", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ status: "starting" }), { status: 200 });
      },
    });
    try {
      await expect(
        waitForNexusHealth(`http://localhost:${server.port}`, 1_500),
      ).rejects.toThrow("timed out");
    } finally {
      server.stop(true);
    }
  });

  test("handles non-ok HTTP status without throwing (keeps polling)", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        if (callCount < 3) return new Response("error", { status: 503 });
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      },
    });
    try {
      await expect(
        waitForNexusHealth(`http://localhost:${server.port}`, 10_000),
      ).resolves.toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("throws on unreachable server", async () => {
    await expect(waitForNexusHealth("http://127.0.0.1:1", 800)).rejects.toThrow("timed out");
  });
});

// ---------------------------------------------------------------------------
// Issue 11A — nexusUp() version-compatibility fallback
//
// We stub Bun.spawn to return controlled exit codes and stderr strings.
// ---------------------------------------------------------------------------

describe("nexusUp fallback (--timeout not supported)", () => {
  // We import the module dynamically so we can replace Bun.spawn per-test.
  // Bun's module cache means we need to use mock() on the global Bun.spawn.

  const originalSpawn = Bun.spawn.bind(Bun);

  afterEach(() => {
    // Restore Bun.spawn after each test
    // @ts-ignore
    Bun.spawn = originalSpawn;
  });

  /** Build a fake proc that immediately exits with the given code and fixed stdio. */
  function fakeProc(exitCode: number, stdoutText: string, stderrText: string) {
    const enc = new TextEncoder();
    return {
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(stdoutText));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(stderrText));
          c.close();
        },
      }),
    };
  }

  /**
   * Build a fake proc whose stderr arrives in two separate chunks to simulate
   * arbitrary stream read boundaries. Used to verify the chunk-safe ring buffer.
   */
  function fakeChunkedProc(exitCode: number, stdoutText: string, chunk1: string, chunk2: string) {
    const enc = new TextEncoder();
    return {
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(stdoutText));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(chunk1));
          c.enqueue(enc.encode(chunk2));
          c.close();
        },
      }),
    };
  }

  test("falls back to args without --timeout when CLI says 'no such option'", async () => {
    const calls: string[][] = [];

    // @ts-ignore – replace Bun.spawn for this test
    Bun.spawn = (args: string[], _opts?: unknown) => {
      calls.push(args);
      // First call (with --timeout): simulate old CLI rejecting the flag
      if (args.includes("--timeout")) {
        return fakeProc(1, "", "Error: no such option: --timeout");
      }
      // Fallback call (without --timeout): succeed
      return fakeProc(0, "nexus  http://localhost:2026\n", "");
    };

    const { nexusUp } = await import("./nexus-lifecycle.js");
    const out = await nexusUp("/tmp/test-proj");

    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("--timeout");
    expect(calls[1]).not.toContain("--timeout");
    expect(out).toContain("http://localhost:2026");
  });

  test("falls back when CLI says 'unrecognized arguments'", async () => {
    const calls: string[][] = [];

    // @ts-ignore
    Bun.spawn = (args: string[], _opts?: unknown) => {
      calls.push(args);
      if (args.includes("--timeout")) {
        return fakeProc(1, "", "unrecognized arguments: --timeout");
      }
      return fakeProc(0, "nexus  http://localhost:2026\n", "");
    };

    const { nexusUp } = await import("./nexus-lifecycle.js");
    await nexusUp("/tmp/test-proj");

    expect(calls.length).toBe(2);
  });

  test("falls back when 'no such option' is split across two stream chunks (chunk-safety)", async () => {
    // Regression: ring buffer previously split on read boundaries, so "no such option: --timeout"
    // arriving as two chunks would not match the fallback trigger substring.
    const calls: string[][] = [];

    // @ts-ignore
    Bun.spawn = (args: string[], _opts?: unknown) => {
      calls.push(args);
      if (args.includes("--timeout")) {
        // Split "Error: no such option: --timeout\n" across two chunks
        return fakeChunkedProc(1, "", "Error: no such opt", "ion: --timeout\n");
      }
      return fakeProc(0, "nexus  http://localhost:2026\n", "");
    };

    const { nexusUp } = await import("./nexus-lifecycle.js");
    await nexusUp("/tmp/test-proj");

    expect(calls.length).toBe(2);
    expect(calls[1]).not.toContain("--timeout");
  });

  test("throws immediately for unrelated errors — no fallback attempted", async () => {
    const calls: string[][] = [];

    // @ts-ignore
    Bun.spawn = (args: string[], _opts?: unknown) => {
      calls.push(args);
      return fakeProc(1, "", "Docker daemon not running");
    };

    const { nexusUp } = await import("./nexus-lifecycle.js");
    await expect(nexusUp("/tmp/test-proj")).rejects.toThrow("nexus up failed");
    expect(calls.length).toBe(1); // no fallback attempt
  });
});

// ---------------------------------------------------------------------------
// Issue 9A — ensureNexusRunning() fast path
//
// We test by spinning up a real local HTTP server to simulate a healthy Nexus,
// then verify ensureNexusRunning() returns early without invoking Bun.spawn
// (i.e. without running nexus up / nexus init).
// ---------------------------------------------------------------------------

describe("ensureNexusRunning — fast path", () => {
  const originalSpawn = Bun.spawn.bind(Bun);
  let spawnCalls: string[][] = [];

  beforeEach(() => {
    spawnCalls = [];
    // Track any spawn calls — the fast path must not spawn anything.
    // @ts-ignore
    Bun.spawn = (args: string[], opts?: unknown) => {
      spawnCalls.push(args);
      // discoverRunningNexus calls `docker ps` — let it return empty (no containers).
      if (args[0] === "docker") {
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
        };
      }
      // Any other spawn (nexus up, nexus init) should not be reached in fast path.
      throw new Error(`Unexpected spawn: ${args.join(" ")}`);
    };
  });

  afterEach(() => {
    // @ts-ignore
    Bun.spawn = originalSpawn;
  });

  test("returns early when GROVE_NEXUS_URL points to a healthy server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      },
    });

    const savedEnv = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = `http://localhost:${server.port}`;

    try {
      const { ensureNexusRunning } = await import("./nexus-lifecycle.js");
      const result = await ensureNexusRunning(
        "/tmp/test-proj",
        { mode: "nexus", nexusManaged: true } as import("../core/config.js").GroveConfig,
      );

      expect(result.url).toBe(`http://localhost:${server.port}`);
      // No nexus up or nexus init should have been spawned
      const nexusCalls = spawnCalls.filter((a) => a[0] === "nexus");
      expect(nexusCalls.length).toBe(0);
    } finally {
      server.stop(true);
      if (savedEnv !== undefined) process.env.GROVE_NEXUS_URL = savedEnv;
      else delete process.env.GROVE_NEXUS_URL;
    }
  });

  test("waits through 'starting' status before returning", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        const status = callCount < 2 ? "starting" : "healthy";
        return new Response(JSON.stringify({ status }), { status: 200 });
      },
    });

    const savedEnv = process.env.GROVE_NEXUS_URL;
    process.env.GROVE_NEXUS_URL = `http://localhost:${server.port}`;

    try {
      const { ensureNexusRunning } = await import("./nexus-lifecycle.js");
      const result = await ensureNexusRunning(
        "/tmp/test-proj",
        { mode: "nexus", nexusManaged: true } as import("../core/config.js").GroveConfig,
      );

      expect(result.url).toBe(`http://localhost:${server.port}`);
      // Must have polled at least twice (starting → healthy)
      expect(callCount).toBeGreaterThanOrEqual(2);
      const nexusCalls = spawnCalls.filter((a) => a[0] === "nexus");
      expect(nexusCalls.length).toBe(0);
    } finally {
      server.stop(true);
      if (savedEnv !== undefined) process.env.GROVE_NEXUS_URL = savedEnv;
      else delete process.env.GROVE_NEXUS_URL;
    }
  });
});
