import { describe, expect, test } from "bun:test";
import type { Condition } from "../../core/entity.js";
import { theme } from "../theme.js";
import type { ConditionChipsProps } from "./condition-chips.js";
import { colorForStatus, shouldShowReason } from "./condition-chips.js";

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

describe("colorForStatus", () => {
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

describe("shouldShowReason", () => {
  test("shows reason line for non-True conditions with a reason", () => {
    expect(
      shouldShowReason({
        type: "Expired",
        status: "False",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "active",
        message: "",
      }),
    ).toBe(true);
  });

  test("hides reason line for True conditions", () => {
    expect(
      shouldShowReason({
        type: "Ready",
        status: "True",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "running",
        message: "",
      }),
    ).toBe(false);
  });

  test("hides reason line when reason is empty", () => {
    expect(
      shouldShowReason({
        type: "Expired",
        status: "False",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "",
        message: "",
      }),
    ).toBe(false);
  });

  test("shows reason line for Unknown conditions with a reason", () => {
    expect(
      shouldShowReason({
        type: "Ready",
        status: "Unknown",
        observedGeneration: 0,
        lastTransitionTime: "",
        reason: "waiting",
        message: "",
      }),
    ).toBe(true);
  });
});
