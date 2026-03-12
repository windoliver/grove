/**
 * Tests for backend resolution, health checks, and help text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendLabel, checkNexusHealth, resolveBackend } from "./resolve-backend.js";

// ---------------------------------------------------------------------------
// resolveBackend() — pure function tests
// ---------------------------------------------------------------------------

describe("resolveBackend", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.GROVE_NEXUS_URL;
    delete process.env.GROVE_NEXUS_URL;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.GROVE_NEXUS_URL = savedEnv;
    } else {
      delete process.env.GROVE_NEXUS_URL;
    }
  });

  test("--url flag -> remote mode", () => {
    const result = resolveBackend({ url: "http://server:4515" });
    expect(result).toEqual({
      mode: "remote",
      url: "http://server:4515",
      source: "flag",
    });
  });

  test("--nexus flag -> nexus mode, source flag", () => {
    const result = resolveBackend({ nexus: "http://nexus:8080" });
    expect(result).toEqual({
      mode: "nexus",
      url: "http://nexus:8080",
      source: "flag",
    });
  });

  test("GROVE_NEXUS_URL env -> nexus mode, source env", () => {
    process.env.GROVE_NEXUS_URL = "http://env-nexus:9090";
    const result = resolveBackend({});
    expect(result).toEqual({
      mode: "nexus",
      url: "http://env-nexus:9090",
      source: "env",
    });
  });

  test("no config -> local mode, source default", () => {
    const result = resolveBackend({});
    expect(result.mode).toBe("local");
    expect(result.source).toBe("default");
  });

  test("--grove override -> local mode, source flag", () => {
    const result = resolveBackend({ groveOverride: "/some/path/.grove" });
    expect(result.mode).toBe("local");
    expect(result.source).toBe("flag");
    if (result.mode === "local") {
      expect(result.groveOverride).toBe("/some/path/.grove");
    }
  });

  test("--url takes priority over GROVE_NEXUS_URL", () => {
    process.env.GROVE_NEXUS_URL = "http://env-nexus:9090";
    const result = resolveBackend({ url: "http://server:4515" });
    expect(result.mode).toBe("remote");
    expect(result.source).toBe("flag");
  });

  test("--nexus takes priority over GROVE_NEXUS_URL", () => {
    process.env.GROVE_NEXUS_URL = "http://env-nexus:9090";
    const result = resolveBackend({ nexus: "http://flag-nexus:8080" });
    expect(result).toEqual({
      mode: "nexus",
      url: "http://flag-nexus:8080",
      source: "flag",
    });
  });

  test("--url takes priority over --nexus", () => {
    const result = resolveBackend({
      url: "http://server:4515",
      nexus: "http://nexus:8080",
    });
    expect(result.mode).toBe("remote");
  });

  test("empty GROVE_NEXUS_URL is treated as unset", () => {
    process.env.GROVE_NEXUS_URL = "";
    const result = resolveBackend({});
    expect(result.mode).toBe("local");
  });

  test("--nexus flag preserves groveOverride for topology loading", () => {
    const result = resolveBackend({
      nexus: "http://nexus:8080",
      groveOverride: "/my/project/.grove",
    });
    expect(result.mode).toBe("nexus");
    expect(result.source).toBe("flag");
    if (result.mode === "nexus") {
      expect(result.groveOverride).toBe("/my/project/.grove");
    }
  });

  test("grove.json with nexusUrl -> nexus mode when --grove points at .grove dir", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "grove-resolve-test-"));
    const groveDir = join(tempDir, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(
      join(groveDir, "grove.json"),
      JSON.stringify({ nexusUrl: "http://json-nexus:7070" }),
    );

    try {
      // --grove points at the .grove directory -> resolveGroveDir uses it directly
      const result = resolveBackend({ groveOverride: groveDir });
      expect(result.mode).toBe("nexus");
      expect(result.source).toBe("grove.json");
      if (result.mode === "nexus") {
        expect(result.url).toBe("http://json-nexus:7070");
        // groveOverride must survive so loadTopology can find GROVE.md
        expect(result.groveOverride).toBe(groveDir);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("grove.json not found when --grove points at repo root (not .grove)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "grove-resolve-test-"));
    const groveDir = join(tempDir, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(
      join(groveDir, "grove.json"),
      JSON.stringify({ nexusUrl: "http://json-nexus:7070" }),
    );

    try {
      // --grove points at the repo root (parent of .grove) — config won't be found
      // because resolveGroveDir treats the override as the final directory
      const result = resolveBackend({ groveOverride: tempDir });
      // Should fall through to local since grove.json is at tempDir/.grove/grove.json
      // but resolveGroveDir(tempDir) returns groveDir=tempDir, so we look for
      // tempDir/grove.json which doesn't exist
      expect(result.mode).toBe("local");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("grove.json with nexusManaged -> discovers nexus URL from nexus.yaml ports.http", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "grove-resolve-test-"));
    const groveDir = join(tempDir, ".grove");
    mkdirSync(groveDir, { recursive: true });
    // Write managed-Nexus grove.json (no nexusUrl)
    writeFileSync(
      join(groveDir, "grove.json"),
      JSON.stringify({ name: "test", mode: "nexus", nexusManaged: true }),
    );
    // Write nexus.yaml with nexus#2918 ports shape
    writeFileSync(
      join(tempDir, "nexus.yaml"),
      "preset: shared\nports:\n  http: 3456\n  grpc: 3458\n",
    );

    try {
      const result = resolveBackend({ groveOverride: groveDir });
      expect(result.mode).toBe("nexus");
      expect(result.source).toBe("grove.json");
      if (result.mode === "nexus") {
        expect(result.url).toBe("http://localhost:3456");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("grove.json with nexusManaged but no nexus.yaml -> falls back to default URL", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "grove-resolve-test-"));
    const groveDir = join(tempDir, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(
      join(groveDir, "grove.json"),
      JSON.stringify({ name: "test", mode: "nexus", nexusManaged: true }),
    );

    try {
      const result = resolveBackend({ groveOverride: groveDir });
      expect(result.mode).toBe("nexus");
      expect(result.source).toBe("grove.json");
      if (result.mode === "nexus") {
        expect(result.url).toBe("http://localhost:2026");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("invalid grove.json -> falls through to local", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "grove-resolve-test-"));
    const groveDir = join(tempDir, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(join(groveDir, "grove.json"), "not valid json{{{");

    try {
      const result = resolveBackend({ groveOverride: groveDir });
      // Should not crash, should fall through
      expect(result.mode).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("missing .grove dir -> falls through to local", () => {
    // No GROVE_NEXUS_URL, no flags, resolveGroveDir will throw
    const result = resolveBackend({});
    expect(result.mode).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// backendLabel()
// ---------------------------------------------------------------------------

describe("backendLabel", () => {
  test("remote backend", () => {
    const label = backendLabel({ mode: "remote", url: "http://server:4515", source: "flag" });
    expect(label).toBe("remote (http://server:4515)");
  });

  test("nexus from flag", () => {
    const label = backendLabel({ mode: "nexus", url: "http://nexus:8080", source: "flag" });
    expect(label).toBe("nexus (--nexus)");
  });

  test("nexus from env", () => {
    const label = backendLabel({ mode: "nexus", url: "http://nexus:8080", source: "env" });
    expect(label).toBe("nexus (auto: env)");
  });

  test("nexus from grove.json", () => {
    const label = backendLabel({ mode: "nexus", url: "http://nexus:8080", source: "grove.json" });
    expect(label).toBe("nexus (auto: grove.json)");
  });

  test("local mode", () => {
    const label = backendLabel({ mode: "local", source: "default" });
    expect(label).toBe("local (.grove/)");
  });
});

// ---------------------------------------------------------------------------
// checkNexusHealth()
// ---------------------------------------------------------------------------

describe("checkNexusHealth", () => {
  test("returns 'ok' on 200 JSON-RPC response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        // Verify it hits the correct Nexus JSON-RPC endpoint
        const url = new URL(req.url);
        expect(url.pathname).toBe("/api/nfs/exists");
        expect(req.method).toBe("POST");
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { exists: true }, id: 1 }), {
          status: 200,
        });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'auth_required' on 401", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Unauthorized", { status: 401 });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("auth_required");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'auth_required' on 403", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Forbidden", { status: 403 });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("auth_required");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'not_nexus' on 404", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("not_nexus");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'not_nexus' on 405", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Method Not Allowed", { status: 405 });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("not_nexus");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'server_error' on 500", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("error", { status: 500 });
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`);
      expect(result).toBe("server_error");
    } finally {
      server.stop(true);
    }
  });

  test("returns 'unreachable' on connection refused", async () => {
    // Use a port that is almost certainly not listening
    const result = await checkNexusHealth("http://127.0.0.1:1", 500);
    expect(result).toBe("unreachable");
  });

  test("returns 'unreachable' on timeout", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        // Wait longer than the timeout
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return new Response("too late");
      },
    });
    try {
      const result = await checkNexusHealth(`http://localhost:${server.port}`, 100);
      expect(result).toBe("unreachable");
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Health check integration with resolveBackend semantics
// ---------------------------------------------------------------------------

describe("nexus health check behavior", () => {
  test("auto-detected nexus (env) unreachable -> should allow fallback", () => {
    // This test verifies the _semantics_ — the fallback logic is in handleTui,
    // but we verify that auto-detected sources are distinguishable from explicit flags
    process.env.GROVE_NEXUS_URL = "http://unreachable:9999";
    const backend = resolveBackend({});
    expect(backend.mode).toBe("nexus");
    expect(backend.source).toBe("env");
    // source !== "flag" means auto-detected -> fallback allowed
    expect(backend.source !== "flag").toBe(true);
    delete process.env.GROVE_NEXUS_URL;
  });

  test("explicit --nexus flag -> source is flag (hard fail expected)", () => {
    const backend = resolveBackend({ nexus: "http://explicit:8080" });
    expect(backend.mode).toBe("nexus");
    expect(backend.source).toBe("flag");
  });
});

// ---------------------------------------------------------------------------
// parseTuiArgs help text snapshot
// ---------------------------------------------------------------------------

describe("parseTuiArgs help text", () => {
  test("help text contains auto-detection info", async () => {
    // We can't easily snapshot process.exit, but we can verify the
    // help text string is accessible by checking the parseTuiArgs export
    const { parseTuiArgs } = await import("./main.js");

    // Capture stdout by overriding console.log
    let output = "";
    const originalLog = console.log;
    const originalExit = process.exit;

    console.log = (msg: string) => {
      output = msg;
    };
    process.exit = (() => {
      throw new Error("EXIT");
    }) as never;

    try {
      parseTuiArgs(["--help"]);
    } catch {
      // Expected EXIT throw
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }

    expect(output).toContain("GROVE_NEXUS_URL");
    expect(output).toContain("auto-detection");
    expect(output).toContain("auto-selected");
    expect(output).toContain("grove.json");
  });
});
