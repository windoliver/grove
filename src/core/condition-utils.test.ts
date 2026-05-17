import { describe, expect, test } from "bun:test";
import { upsertCondition } from "./condition-utils.js";
import type { Condition } from "./entity.js";

const makeCondition = (overrides?: Partial<Condition>): Condition => ({
  type: "Bound",
  status: "True",
  observedGeneration: 1,
  lastTransitionTime: "2026-01-01T00:00:00Z",
  reason: "x",
  message: "",
  ...overrides,
});

describe("upsertCondition", () => {
  test("inserts new condition when type absent", () => {
    const out = upsertCondition([], makeCondition());
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("Bound");
  });

  test("replaces existing condition of same type", () => {
    const a = makeCondition({ status: "True", reason: "a", observedGeneration: 1 });
    const b = makeCondition({
      status: "False",
      reason: "b",
      message: "x",
      observedGeneration: 2,
      lastTransitionTime: "2026-01-02T00:00:00Z",
    });
    const out = upsertCondition([a], b);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("False");
    expect(out[0]?.reason).toBe("b");
  });

  test("preserves lastTransitionTime when status/reason/message unchanged", () => {
    const original = makeCondition({
      lastTransitionTime: "2026-01-01T00:00:00Z",
      status: "True",
      reason: "same",
      message: "",
    });
    const updated = makeCondition({
      lastTransitionTime: "2026-01-02T00:00:00Z",
      status: "True",
      reason: "same",
      message: "",
      observedGeneration: 2,
    });
    const out = upsertCondition([original], updated);
    // lastTransitionTime must be preserved from original
    expect(out[0]?.lastTransitionTime).toBe("2026-01-01T00:00:00Z");
  });

  test("returns same array reference when nothing changed", () => {
    const cond = makeCondition();
    const arr = [cond] as const;
    const out = upsertCondition(arr, { ...cond });
    expect(out).toBe(arr); // same reference — no allocation when equal
  });

  test("appends second condition of different type", () => {
    const bound = makeCondition({ type: "Bound" });
    const running = makeCondition({ type: "Running" });
    const out = upsertCondition([bound], running);
    expect(out).toHaveLength(2);
  });
});
