/**
 * Tests for useDerived pure reducer.
 */

import { describe, expect, test } from "bun:test";
import { stepDerived } from "./use-derived.js";

describe("stepDerived", () => {
  test("first compute success → data set, error null", () => {
    const next = stepDerived<number>({ data: undefined, error: null }, () => 42);
    expect(next.data).toBe(42);
    expect(next.error).toBeNull();
    expect(next.committed).toBe(true);
  });

  test("compute returns same value (Object.is) → no commit", () => {
    const obj = { a: 1 };
    const next = stepDerived({ data: obj, error: null }, () => obj);
    expect(next.committed).toBe(false);
  });

  test("custom equals comparator → no commit when equal", () => {
    const next = stepDerived<{ a: number }>(
      { data: { a: 1 }, error: null },
      () => ({ a: 1 }),
      (a, b) => a.a === b.a,
    );
    expect(next.committed).toBe(false);
  });

  test("compute throws → error set, last data preserved", () => {
    const next = stepDerived<number>({ data: 7, error: null }, () => {
      throw new Error("boom");
    });
    expect(next.data).toBe(7);
    expect(next.error?.message).toBe("boom");
    expect(next.committed).toBe(true);
  });

  test("recovery: previous error cleared on success", () => {
    const next = stepDerived<number>({ data: 7, error: new Error("old") }, () => 8);
    expect(next.data).toBe(8);
    expect(next.error).toBeNull();
    expect(next.committed).toBe(true);
  });
});
