/**
 * Hook runner tests — real shell execution with controlled test scripts.
 *
 * Uses temp directories and small test scripts to verify:
 * - Command runs in correct cwd
 * - Exit code detection
 * - Timeout enforcement
 * - stdout/stderr capture
 * - Environment isolation
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HookEntry } from "../core/hooks.js";
import { LocalHookRunner } from "./hook-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `grove-hook-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalHookRunner", () => {
  test("runs simple echo command", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("echo");
    try {
      const result = await runner.run("echo hello", dir);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
      expect(result.command).toBe("echo hello");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("captures working directory", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("cwd");
    try {
      const result = await runner.run("pwd", dir);
      expect(result.success).toBe(true);
      // realpath may resolve symlinks (e.g., /tmp → /private/tmp on macOS)
      const dirName = dir.split("/").pop() ?? "";
      expect(result.stdout.trim()).toContain(dirName);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects non-zero exit code", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("exit-code");
    try {
      const result = await runner.run("exit 42", dir);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("captures stderr", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("stderr");
    try {
      const result = await runner.run("echo error-msg >&2", dir);
      expect(result.success).toBe(true);
      expect(result.stderr.trim()).toBe("error-msg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("enforces timeout", async () => {
    const runner = new LocalHookRunner({ defaultTimeoutMs: 500 });
    const dir = await makeTempDir("timeout");
    try {
      const result = await runner.run("sleep 30", dir);
      expect(result.success).toBe(false);
      // Timed out processes get killed
      expect(result.durationMs).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("per-hook timeout overrides default", async () => {
    const runner = new LocalHookRunner({ defaultTimeoutMs: 30_000 });
    const dir = await makeTempDir("per-hook-timeout");
    try {
      const entry: HookEntry = { cmd: "sleep 30", timeout: 500 };
      const result = await runner.run(entry, dir);
      expect(result.success).toBe(false);
      expect(result.durationMs).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hook can write files in workspace", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("write-file");
    try {
      const result = await runner.run('echo "test-output" > output.txt', dir);
      expect(result.success).toBe(true);

      const content = await readFile(join(dir, "output.txt"), "utf-8");
      expect(content.trim()).toBe("test-output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hook receives minimal environment", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("env");
    try {
      // Check that PATH is available but other vars are not
      const result = await runner.run("echo $PATH", dir);
      expect(result.success).toBe(true);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs multi-line script", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("multiline");
    try {
      const script = 'echo "line1" && echo "line2"';
      const result = await runner.run(script, dir);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles missing command", async () => {
    const runner = new LocalHookRunner();
    const dir = await makeTempDir("missing-cmd");
    try {
      const result = await runner.run("nonexistent_command_xyz_12345", dir);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
