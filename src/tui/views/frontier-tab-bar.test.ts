import { describe, expect, test } from "bun:test";
import { computeVisibleTabs } from "./frontier-tab-bar.js";

describe("computeVisibleTabs", () => {
  const TABS = [
    "overview",
    "adoption",
    "recency",
    "review",
    "reproduction",
    "metric:a",
    "metric:b",
  ];

  test("all tabs fit when capacity ≥ count", () => {
    const r = computeVisibleTabs(TABS, "adoption", 10);
    expect(r.visible).toEqual(TABS);
    expect(r.hiddenAfter).toBe(0);
  });

  test("active tab forced visible when capacity smaller than count", () => {
    const r = computeVisibleTabs(TABS, "metric:b", 3);
    expect(r.visible.includes("metric:b")).toBe(true);
    expect(r.visible.length).toBeLessThanOrEqual(3);
  });

  test("hiddenAfter = count - visible.length when overflow", () => {
    const r = computeVisibleTabs(TABS, "overview", 3);
    expect(r.hiddenAfter).toBe(TABS.length - r.visible.length);
  });

  test("active tab not in input → no crash, falls back to first window", () => {
    const r = computeVisibleTabs(TABS, "missing", 3);
    expect(r.visible.length).toBe(3);
  });

  test("empty tab list → empty visible", () => {
    expect(computeVisibleTabs([], "x", 5)).toEqual({ visible: [], hiddenAfter: 0 });
  });
});
