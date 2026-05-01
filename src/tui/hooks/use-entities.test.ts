/**
 * Tests for useEntities pure helpers.
 */

import { describe, expect, test } from "bun:test";
import { computeFilteredEntities, shallowArraysEqual } from "./use-entities.js";

describe("shallowArraysEqual", () => {
  test("identical references → true", () => {
    const a = [1, 2, 3];
    expect(shallowArraysEqual(a, a)).toBe(true);
  });

  test("different lengths → false", () => {
    expect(shallowArraysEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  test("same elements in same order → true", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(shallowArraysEqual([a, b], [a, b])).toBe(true);
  });

  test("same length, different element identity → false", () => {
    expect(shallowArraysEqual([{ id: "a" }], [{ id: "a" }])).toBe(false);
  });

  test("NaN handled by Object.is", () => {
    expect(shallowArraysEqual([Number.NaN], [Number.NaN])).toBe(true);
  });
});

describe("computeFilteredEntities", () => {
  const e1 = { id: "a" } as unknown as { id: string };
  const e2 = { id: "b" } as unknown as { id: string };

  test("undefined predicate returns the input array reference", () => {
    const list = [e1, e2];
    expect(computeFilteredEntities(list, undefined)).toBe(list);
  });

  test("predicate filters", () => {
    const out = computeFilteredEntities([e1, e2], (e) => e.id === "a");
    expect(out).toEqual([e1]);
  });

  test("predicate that throws is propagated to caller", () => {
    const boom = (): boolean => {
      throw new Error("boom");
    };
    expect(() => computeFilteredEntities([e1], boom)).toThrow("boom");
  });
});
