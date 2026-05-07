/**
 * Tests for useEntityData pure helpers.
 */
import { describe, expect, test } from "bun:test";
import { applyEntityShape } from "./use-entity-data.js";

describe("applyEntityShape", () => {
  const e = (id: string, ts: number) => ({ id, _ts: ts }) as unknown as { id: string; _ts: number };

  test("no opts → input array reference returned", () => {
    const list = [e("a", 1), e("b", 2)];
    expect(applyEntityShape(list, {})).toBe(list);
  });

  test("predicate filters", () => {
    const list = [e("a", 1), e("b", 2)];
    expect(applyEntityShape(list, { predicate: (x) => x.id === "b" })).toEqual([e("b", 2)]);
  });

  test("sort orders by comparator (desc on _ts)", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2)];
    const sorted = applyEntityShape(list, { sort: (x, y) => y._ts - x._ts });
    expect(sorted.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  test("limit slices after sort", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2)];
    const out = applyEntityShape(list, { sort: (x, y) => y._ts - x._ts, limit: 2 });
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
  });

  test("predicate before sort before limit", () => {
    const list = [e("a", 1), e("b", 3), e("c", 2), e("d", 4)];
    const out = applyEntityShape(list, {
      predicate: (x) => x._ts > 1,
      sort: (x, y) => x._ts - y._ts,
      limit: 2,
    });
    expect(out.map((x) => x.id)).toEqual(["c", "b"]);
  });

  test("offset skips first N after sort", () => {
    const list = [e("a", 1), e("b", 2), e("c", 3)];
    const out = applyEntityShape(list, { sort: (x, y) => x._ts - y._ts, offset: 1, limit: 2 });
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
  });
});
