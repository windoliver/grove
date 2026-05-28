import { describe, expect, test } from "bun:test";
import { getReservedActionRegistryEntries } from "./reserved-ids.js";

describe("reserved action ids", () => {
  test("reserves the workflow set-goal and register-agent action ids", () => {
    expect(getReservedActionRegistryEntries().map((e) => e.id)).toEqual([
      "workflow.set-goal",
      "workflow.register-agent",
    ]);
  });
});
