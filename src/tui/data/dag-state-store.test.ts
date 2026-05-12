import { describe, expect, test } from "bun:test";
import { DagStateStore } from "./dag-state-store.js";

describe("DagStateStore", () => {
  test("starts with empty collapsed set, null focus, empty highlight", () => {
    const s = new DagStateStore();
    const snap = s.snapshot();
    expect(snap.collapsed.size).toBe(0);
    expect(snap.focusCid).toBe(null);
    expect(snap.highlight).toBe("");
  });

  test("toggleCollapsed adds and removes cid", () => {
    const s = new DagStateStore();
    s.toggleCollapsed("blake3:aaa");
    expect(s.snapshot().collapsed.has("blake3:aaa")).toBe(true);
    s.toggleCollapsed("blake3:aaa");
    expect(s.snapshot().collapsed.has("blake3:aaa")).toBe(false);
  });

  test("setFocus updates focus cid", () => {
    const s = new DagStateStore();
    s.setFocus("blake3:bbb");
    expect(s.snapshot().focusCid).toBe("blake3:bbb");
    s.setFocus(null);
    expect(s.snapshot().focusCid).toBe(null);
  });

  test("setHighlight updates highlight text", () => {
    const s = new DagStateStore();
    s.setHighlight("foo");
    expect(s.snapshot().highlight).toBe("foo");
  });

  test("subscribe('change', fn) is notified on mutation", () => {
    const s = new DagStateStore();
    let count = 0;
    const unsub = s.subscribe("change", () => {
      count++;
    });
    s.toggleCollapsed("a");
    s.setFocus("b");
    s.setHighlight("c");
    expect(count).toBe(3);
    unsub();
    s.toggleCollapsed("a");
    expect(count).toBe(3);
  });

  test("snapshot is stable when no mutation occurs (referential equality)", () => {
    const s = new DagStateStore();
    const a = s.snapshot();
    const b = s.snapshot();
    expect(a).toBe(b);
  });

  test("snapshot returns a new object after each mutation", () => {
    const s = new DagStateStore();
    const a = s.snapshot();
    s.setHighlight("x");
    const b = s.snapshot();
    expect(a).not.toBe(b);
  });

  test("collapsed snapshot is frozen", () => {
    const s = new DagStateStore();
    s.toggleCollapsed("a");
    expect(() => (s.snapshot().collapsed as Set<string>).add("b")).toThrow();
  });

  test("expandAll clears collapsed", () => {
    const s = new DagStateStore();
    s.toggleCollapsed("a");
    s.toggleCollapsed("b");
    s.expandAll();
    expect(s.snapshot().collapsed.size).toBe(0);
  });

  test("collapseAll adds every supplied cid", () => {
    const s = new DagStateStore();
    s.collapseAll(["a", "b", "c"]);
    expect(s.snapshot().collapsed.size).toBe(3);
    expect(s.snapshot().collapsed.has("a")).toBe(true);
  });

  test("throwing listener is isolated; subsequent listeners still fire and mutator does not throw", () => {
    const s = new DagStateStore();
    const calls: string[] = [];
    s.subscribe("change", () => {
      calls.push("before");
    });
    s.subscribe("change", () => {
      throw new Error("boom");
    });
    s.subscribe("change", () => {
      calls.push("after");
    });
    expect(() => s.toggleCollapsed("a")).not.toThrow();
    expect(calls).toEqual(["before", "after"]);
  });

  test("setHighlight no-op when value unchanged does not re-emit", () => {
    const s = new DagStateStore();
    let count = 0;
    s.subscribe("change", () => {
      count++;
    });
    s.setHighlight("");
    expect(count).toBe(0);
    s.setHighlight("a");
    expect(count).toBe(1);
    s.setHighlight("a");
    expect(count).toBe(1);
  });
});
