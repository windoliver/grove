/**
 * Tests for the shared subprocess utility.
 */

import { describe, expect, test } from "bun:test";
import { spawnCommand, spawnOrThrow } from "./subprocess.js";

describe("spawnCommand", () => {
  test("captures stdout from a successful command", async () => {
    const result = await spawnCommand(["echo", "hello"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("captures stderr and non-zero exit code", async () => {
    const result = await spawnCommand(["sh", "-c", "echo err >&2; exit 1"]);
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(1);
  });

  test("respects cwd option", async () => {
    const result = await spawnCommand(["pwd"], { cwd: "/tmp" });
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
    expect(result.exitCode).toBe(0);
  });

  test("throws on timeout", async () => {
    await expect(spawnCommand(["sleep", "10"], { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
  });

  test("handles empty stdout", async () => {
    const result = await spawnCommand(["true"]);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("handles multiline stdout", async () => {
    const result = await spawnCommand(["sh", "-c", "echo line1; echo line2"]);
    expect(result.stdout.trim()).toBe("line1\nline2");
  });

  test("returns exit code 127 when executable not found", async () => {
    const result = await spawnCommand(["definitely-not-a-binary-in-path"]);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBeTruthy();
  });
});

describe("spawnOrThrow", () => {
  test("returns stdout on success", async () => {
    const stdout = await spawnOrThrow(["echo", "ok"]);
    expect(stdout.trim()).toBe("ok");
  });

  test("throws with exit code and stderr on failure", async () => {
    await expect(
      spawnOrThrow(["sh", "-c", "echo bad >&2; exit 42"], undefined, "test-cmd"),
    ).rejects.toThrow(/test-cmd failed \(exit 42\): bad/);
  });

  test("throws with command name when no errorPrefix", async () => {
    await expect(spawnOrThrow(["sh", "-c", "exit 1"])).rejects.toThrow(/sh -c exit 1 failed/);
  });

  test("throws on timeout", async () => {
    await expect(spawnOrThrow(["sleep", "10"], { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
  });
});
