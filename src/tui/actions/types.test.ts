import { describe, expect, test } from "bun:test";
import { type Action, type ActionContext, GROUP_ORDER, resolveEnabled } from "./types.js";

describe("action types", () => {
  test("GROUP_ORDER lists all groups in display order", () => {
    expect(GROUP_ORDER).toEqual([
      "Navigation",
      "Agents",
      "Workflow",
      "View",
      "Contributions",
      "Prompts",
      "Skills",
      "Plugins",
    ]);
  });
});

describe("ActionGroup order", () => {
  test("includes Prompts and Skills before Plugins", () => {
    expect(GROUP_ORDER).toEqual([
      "Navigation",
      "Agents",
      "Workflow",
      "View",
      "Contributions",
      "Prompts",
      "Skills",
      "Plugins",
    ]);
  });
});

describe("resolveEnabled", () => {
  const base = { id: "x", label: "X", detail: "", group: "View", run: () => {} } as const;
  const ctx = {} as ActionContext;

  test("undefined enabled → enabled, no reason", () => {
    expect(resolveEnabled(base as Action, ctx)).toEqual({ enabled: true });
  });
  test("boolean enabled is normalized", () => {
    const a = { ...base, enabled: () => false } as Action;
    expect(resolveEnabled(a, ctx)).toEqual({ enabled: false });
  });
  test("object enabled carries a reason", () => {
    const a = { ...base, enabled: () => ({ enabled: false, reason: "at capacity" }) } as Action;
    expect(resolveEnabled(a, ctx)).toEqual({ enabled: false, reason: "at capacity" });
  });
});
