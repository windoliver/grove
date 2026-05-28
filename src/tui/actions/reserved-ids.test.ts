import { describe, expect, test } from "bun:test";
import { getReservedActionRegistryEntries } from "./reserved-ids.js";

describe("reserved action ids", () => {
  test("reserves set-goal and register-agent", () => {
    expect(getReservedActionRegistryEntries().map((e) => e.id)).toEqual([
      "set-goal",
      "register-agent",
    ]);
  });
});
