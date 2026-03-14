/**
 * Tests for the safeCleanup utility.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { safeCleanup } from "./safe-cleanup.js";

describe("safeCleanup", () => {
  let originalConsoleError: typeof console.error;
  let errorCalls: string[];

  beforeEach(() => {
    originalConsoleError = console.error;
    errorCalls = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("resolves when promise succeeds", async () => {
    await safeCleanup(Promise.resolve("ok"), "test-success");
    expect(errorCalls).toHaveLength(0);
  });

  test("absorbs errors and logs by default", async () => {
    await safeCleanup(Promise.reject(new Error("boom")), "delete-temp-file");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]).toContain("[cleanup]");
    expect(errorCalls[0]).toContain("delete-temp-file");
    expect(errorCalls[0]).toContain("boom");
  });

  test("includes context in log message", async () => {
    await safeCleanup(Promise.reject(new Error("fail")), "release-claim-abc");
    expect(errorCalls[0]).toContain("release-claim-abc");
  });

  test("handles non-Error rejections", async () => {
    await safeCleanup(Promise.reject("string-error"), "non-error-rejection");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]).toContain("string-error");
  });

  test("suppresses logging when silent: true", async () => {
    await safeCleanup(Promise.reject(new Error("ignored")), "silent-cleanup", { silent: true });
    expect(errorCalls).toHaveLength(0);
  });

  test("returns void even when promise resolves with a value", async () => {
    const result = await safeCleanup(Promise.resolve(42), "value-cleanup");
    expect(result).toBeUndefined();
  });

  test("does not throw on rejection", async () => {
    // Should not throw — that's the whole point
    await expect(
      safeCleanup(Promise.reject(new Error("crash")), "no-throw"),
    ).resolves.toBeUndefined();
  });
});
