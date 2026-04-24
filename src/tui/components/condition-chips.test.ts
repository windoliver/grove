import { describe, expect, test } from "bun:test";
import type { Condition } from "../../core/entity.js";
import { theme } from "../theme.js";
import type { ConditionChipsProps } from "./condition-chips.js";
import {
  colorForCondition,
  colorForStatus,
  NEGATIVE_POLARITY_CONDITION_TYPES,
  shouldShowReason,
} from "./condition-chips.js";

function cond(type: string, status: "True" | "False" | "Unknown", reason = ""): Condition {
  return {
    type,
    status,
    observedGeneration: 0,
    lastTransitionTime: "",
    reason,
    message: "",
  };
}

describe("ConditionChips module", () => {
  test("exports ConditionChips as a React.memo component", async () => {
    const mod = await import("./condition-chips.js");
    expect(mod.ConditionChips).toBeDefined();
    expect(typeof mod.ConditionChips).toBe("object"); // React.memo → object
  });

  test("ConditionChips display name is ConditionChips", async () => {
    const { ConditionChips } = await import("./condition-chips.js");
    const inner = (ConditionChips as unknown as { type?: { name?: string } }).type;
    expect(inner?.name).toBe("ConditionChips");
  });
});

describe("ConditionChips props contract", () => {
  test("accepts a readonly Condition array", () => {
    const props: ConditionChipsProps = { conditions: [] };
    expect(props.conditions).toEqual([]);
  });

  test("accepts multiple conditions", () => {
    const cs: Condition[] = [
      {
        type: "Ready",
        status: "True",
        observedGeneration: 0,
        lastTransitionTime: "2026-04-23T00:00:00Z",
        reason: "running",
        message: "",
      },
    ];
    const props: ConditionChipsProps = { conditions: cs };
    expect(props.conditions).toHaveLength(1);
  });
});

describe("colorForStatus (deprecated; polarity-blind)", () => {
  test("True → theme.success", () => {
    expect(colorForStatus("True")).toBe(theme.success);
  });
  test("False → theme.error", () => {
    expect(colorForStatus("False")).toBe(theme.error);
  });
  test("Unknown → theme.warning", () => {
    expect(colorForStatus("Unknown")).toBe(theme.warning);
  });
});

describe("colorForCondition (polarity-aware)", () => {
  test("positive type + True → success", () => {
    expect(colorForCondition(cond("Ready", "True"))).toBe(theme.success);
  });
  test("positive type + False → error", () => {
    expect(colorForCondition(cond("Ready", "False"))).toBe(theme.error);
  });
  test("negative type + True → error (Crashed=True is bad)", () => {
    expect(colorForCondition(cond("Crashed", "True"))).toBe(theme.error);
  });
  test("negative type + False → success (Crashed=False is healthy)", () => {
    expect(colorForCondition(cond("Crashed", "False"))).toBe(theme.success);
  });
  test("negative type Expired False → success (healthy)", () => {
    expect(colorForCondition(cond("Expired", "False"))).toBe(theme.success);
  });
  test("negative type Expired True → error (bad)", () => {
    expect(colorForCondition(cond("Expired", "True"))).toBe(theme.error);
  });
  test("Unknown status always warning regardless of polarity", () => {
    expect(colorForCondition(cond("Ready", "Unknown"))).toBe(theme.warning);
    expect(colorForCondition(cond("Crashed", "Unknown"))).toBe(theme.warning);
  });
});

describe("NEGATIVE_POLARITY_CONDITION_TYPES", () => {
  test("contains the baseline negative predicates", () => {
    for (const t of ["Crashed", "Expired", "Failed", "Stalled", "Degraded", "Unreachable"]) {
      expect(NEGATIVE_POLARITY_CONDITION_TYPES.has(t)).toBe(true);
    }
  });
  test("excludes positive predicates", () => {
    for (const t of ["Ready", "Active", "Completed", "Published", "Available"]) {
      expect(NEGATIVE_POLARITY_CONDITION_TYPES.has(t)).toBe(false);
    }
  });
});

describe("shouldShowReason (polarity-aware)", () => {
  test("positive type + False + reason → shows", () => {
    expect(shouldShowReason(cond("Ready", "False", "stopped"))).toBe(true);
  });
  test("positive type + True → hides", () => {
    expect(shouldShowReason(cond("Ready", "True", "running"))).toBe(false);
  });
  test("negative type + False (healthy) + reason → hides (don't warn on healthy)", () => {
    expect(shouldShowReason(cond("Expired", "False", "active"))).toBe(false);
    expect(shouldShowReason(cond("Crashed", "False", "running"))).toBe(false);
  });
  test("negative type + True (bad) + reason → shows", () => {
    expect(shouldShowReason(cond("Crashed", "True", "segfault"))).toBe(true);
    expect(shouldShowReason(cond("Expired", "True", "lease timeout"))).toBe(true);
  });
  test("empty reason always hides", () => {
    expect(shouldShowReason(cond("Ready", "False", ""))).toBe(false);
    expect(shouldShowReason(cond("Crashed", "True", ""))).toBe(false);
  });
  test("Unknown status + reason → shows (uncertain = worth explaining)", () => {
    expect(shouldShowReason(cond("Ready", "Unknown", "waiting"))).toBe(true);
    expect(shouldShowReason(cond("Crashed", "Unknown", "timeout"))).toBe(true);
  });
});
