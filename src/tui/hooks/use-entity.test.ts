/**
 * Tests for useEntity pure selector.
 */

import { describe, expect, test } from "bun:test";
import type { Informer } from "../../core/informer.js";
import { selectEntityById } from "./use-entity.js";

function fakeInformer<E extends { id: string }>(items: readonly E[]): Informer {
  return {
    list: () => items,
    getById: (id: string) => items.find((i) => i.id === id),
    hasSynced: () => true,
    addEventHandler: () => () => undefined,
  } as unknown as Informer;
}

describe("selectEntityById", () => {
  test("undefined id returns undefined and never calls getById", () => {
    let calls = 0;
    const inf = {
      ...fakeInformer([{ id: "a" }]),
      getById: (_id: string) => {
        calls += 1;
        return undefined;
      },
    } as unknown as Informer;
    expect(selectEntityById(inf, undefined)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("id present in cache returns the entity", () => {
    const a = { id: "a" };
    const inf = fakeInformer([a]);
    expect(selectEntityById(inf, "a")).toBe(a as never);
  });

  test("id absent returns undefined", () => {
    const inf = fakeInformer<{ id: string }>([{ id: "a" }]);
    expect(selectEntityById(inf, "missing")).toBeUndefined();
  });
});
