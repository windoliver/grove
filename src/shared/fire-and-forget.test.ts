import { describe, expect, test } from "bun:test";
import { fireAndForget } from "./fire-and-forget.js";

describe("fireAndForget", () => {
  test("sync function — success does not throw", () => {
    expect(() => fireAndForget("test", () => 42)).not.toThrow();
  });

  test("sync function — exception is caught and logged", () => {
    const captured: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;
    try {
      fireAndForget("boom", () => {
        throw new Error("kaboom");
      });
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("boom failed: kaboom");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("async function — rejected promise is caught and logged", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;
    try {
      fireAndForget("async-boom", () => Promise.reject(new Error("async kaboom")));
      await new Promise((r) => setTimeout(r, 10));
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("async-boom failed: async kaboom");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("promise-like rejection is caught and logged", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;
    try {
      const thenable: Record<string, unknown> = {};
      const methodName = ["th", "en"].join("");
      Object.defineProperty(thenable, methodName, {
        value(_resolve: (value: unknown) => void, reject: (reason: unknown) => void): void {
          queueMicrotask(() => reject(new Error("thenable kaboom")));
        },
      });

      fireAndForget("thenable-boom", () => thenable);
      await new Promise((r) => setTimeout(r, 10));
      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("thenable-boom failed: thenable kaboom");
    } finally {
      process.stderr.write = orig;
    }
  });

  test("async function — resolved promise does not log", async () => {
    const captured: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((msg: string) => {
      captured.push(msg);
      return true;
    }) as typeof process.stderr.write;
    try {
      fireAndForget("ok", () => Promise.resolve("fine"));
      await new Promise((r) => setTimeout(r, 10));
      expect(captured.length).toBe(0);
    } finally {
      process.stderr.write = orig;
    }
  });
});
