import { describe, expect, test } from "bun:test";
import { GROUP_ORDER } from "./types.js";

describe("action types", () => {
  test("GROUP_ORDER lists the five groups in display order", () => {
    expect(GROUP_ORDER).toEqual(["Navigation", "Agents", "Workflow", "Contributions", "Plugins"]);
  });
});
