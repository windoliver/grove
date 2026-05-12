import { describe, expect, test } from "bun:test";
import { type Page, PagesStore, type StackEvent } from "./pages-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(kind: Page["kind"], params?: Record<string, string>): Page {
  return params !== undefined ? { kind, params } : { kind };
}

// Collect all events fired during a thunk, in order.
function capture(
  store: PagesStore,
  types: Array<StackEvent["type"]>,
  thunk: () => void,
): StackEvent[] {
  const events: StackEvent[] = [];
  const unsubs = types.map((t) => store.subscribe(t, (e) => events.push(e)));
  thunk();
  for (const u of unsubs) u();
  return events;
}

// ---------------------------------------------------------------------------
// 1. Initial state
// ---------------------------------------------------------------------------

describe("PagesStore — initial state", () => {
  test("depth() is 0", () => {
    const s = new PagesStore();
    expect(s.depth()).toBe(0);
  });

  test("top() is undefined", () => {
    const s = new PagesStore();
    expect(s.top()).toBeUndefined();
  });

  test("snapshot() is []", () => {
    const s = new PagesStore();
    expect(s.snapshot()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. push — appends, fires pushed + top; duplicate is no-op
// ---------------------------------------------------------------------------

describe("PagesStore — push", () => {
  test("push appends and increments depth", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    expect(s.depth()).toBe(1);
    expect(s.top()?.kind).toBe("preset-select");
  });

  test("push fires 'pushed' then 'top' in order", () => {
    const s = new PagesStore();
    const events = capture(s, ["pushed", "top"], () => {
      s.push(makePage("goal-input"));
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("pushed");
    expect(events[1]?.type).toBe("top");
  });

  test("pushed event carries page and depth", () => {
    const s = new PagesStore();
    const events = capture(s, ["pushed"], () => {
      s.push(makePage("goal-input"));
    });
    expect(events[0]).toEqual({ type: "pushed", page: { kind: "goal-input" }, depth: 1 });
  });

  test("top event carries page and depth", () => {
    const s = new PagesStore();
    const events = capture(s, ["top"], () => {
      s.push(makePage("goal-input"));
    });
    expect(events[0]).toEqual({ type: "top", page: { kind: "goal-input" }, depth: 1 });
  });

  test("duplicate-top push (same kind, no params) is a no-op", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    const events = capture(s, ["pushed", "popped", "top"], () => {
      s.push(makePage("preset-select"));
    });
    expect(events).toHaveLength(0);
    expect(s.depth()).toBe(1);
  });

  test("duplicate-top push (same kind + same params) is a no-op", () => {
    const s = new PagesStore();
    s.push(makePage("entity-detail", { id: "42" }));
    const events = capture(s, ["pushed", "popped", "top"], () => {
      s.push(makePage("entity-detail", { id: "42" }));
    });
    expect(events).toHaveLength(0);
    expect(s.depth()).toBe(1);
  });

  test("different params is NOT a duplicate", () => {
    const s = new PagesStore();
    s.push(makePage("entity-detail", { id: "1" }));
    const events = capture(s, ["pushed", "top"], () => {
      s.push(makePage("entity-detail", { id: "2" }));
    });
    expect(events).toHaveLength(2);
    expect(s.depth()).toBe(2);
  });

  test("same kind different params key set is NOT a duplicate", () => {
    const s = new PagesStore();
    s.push(makePage("entity-detail", { id: "1" }));
    const events = capture(s, ["pushed", "top"], () => {
      s.push(makePage("entity-detail", { id: "1", extra: "yes" }));
    });
    expect(events).toHaveLength(2);
    expect(s.depth()).toBe(2);
  });

  test("push with undefined params vs defined empty object — kind-only dedup", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    // Same kind, same implicit undefined params → no-op
    const events = capture(s, ["pushed", "top"], () => {
      s.push(makePage("preset-select"));
    });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. pop — no-op at depth ≤ 1; otherwise pops + fires popped + top
// ---------------------------------------------------------------------------

describe("PagesStore — pop", () => {
  test("pop on empty stack returns undefined and fires no events", () => {
    const s = new PagesStore();
    const events = capture(s, ["popped", "top"], () => {
      const result = s.pop();
      expect(result).toBeUndefined();
    });
    expect(events).toHaveLength(0);
  });

  test("pop on single-item stack returns undefined (depth ≤ 1 guard)", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    const events = capture(s, ["popped", "top"], () => {
      const result = s.pop();
      expect(result).toBeUndefined();
    });
    expect(events).toHaveLength(0);
    expect(s.depth()).toBe(1);
  });

  test("pop on depth=2 pops top, fires 'popped' then 'top' for new top", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));
    const events = capture(s, ["popped", "top"], () => {
      s.pop();
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("popped");
    expect(events[0]).toMatchObject({ type: "popped", page: { kind: "goal-input" }, depth: 1 });
    expect(events[1]?.type).toBe("top");
    expect(events[1]).toMatchObject({ type: "top", page: { kind: "preset-select" }, depth: 1 });
  });

  test("pop returns the popped page", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input", { foo: "bar" }));
    const popped = s.pop();
    expect(popped).toEqual({ kind: "goal-input", params: { foo: "bar" } });
  });
});

// ---------------------------------------------------------------------------
// 4. replace — swaps top; depth unchanged; fires pushed + top
// ---------------------------------------------------------------------------

describe("PagesStore — replace", () => {
  test("replace on non-empty stack keeps depth, fires pushed + top", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));
    const events = capture(s, ["pushed", "popped", "top"], () => {
      s.replace(makePage("agent-detect"));
    });
    expect(s.depth()).toBe(2);
    expect(s.top()?.kind).toBe("agent-detect");
    const types = events.map((e) => e.type);
    expect(types).toEqual(["pushed", "top"]);
  });

  test("replace on empty stack acts like push", () => {
    const s = new PagesStore();
    const events = capture(s, ["pushed", "top"], () => {
      s.replace(makePage("preset-select"));
    });
    expect(s.depth()).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["pushed", "top"]);
  });

  test("identical-top replace is a no-op", () => {
    const s = new PagesStore();
    s.push(makePage("goal-input", { x: "1" }));
    const events = capture(s, ["pushed", "popped", "top"], () => {
      s.replace(makePage("goal-input", { x: "1" }));
    });
    expect(events).toHaveLength(0);
    expect(s.depth()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. resetTo — clears stack firing popped for each, then pushes page
// ---------------------------------------------------------------------------

describe("PagesStore — resetTo", () => {
  test("resetTo on empty stack ends with depth=1", () => {
    const s = new PagesStore();
    s.resetTo(makePage("preset-select"));
    expect(s.depth()).toBe(1);
    expect(s.top()?.kind).toBe("preset-select");
  });

  test("resetTo fires popped for each removed entry, then pushed + top", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));
    s.push(makePage("agent-detect"));

    const events = capture(s, ["pushed", "popped", "top"], () => {
      s.resetTo(makePage("running"));
    });

    const types = events.map((e) => e.type);
    // 3 pops + 1 pushed + 1 top
    expect(types).toEqual(["popped", "popped", "popped", "pushed", "top"]);
    expect(s.depth()).toBe(1);
    expect(s.top()?.kind).toBe("running");
  });

  test("resetTo fires popped in reverse stack order (top first)", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));

    const poppedPages: Page["kind"][] = [];
    const unsub = s.subscribe("popped", (e) => poppedPages.push(e.page.kind));
    s.resetTo(makePage("running"));
    unsub();

    expect(poppedPages[0]).toBe("goal-input");
    expect(poppedPages[1]).toBe("preset-select");
  });
});

// ---------------------------------------------------------------------------
// 6. snapshot — copy-stable, frozen
// ---------------------------------------------------------------------------

describe("PagesStore — snapshot", () => {
  test("snapshot returns frozen array", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    const snap = s.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test("snapshot taken before mutation is not affected by mutation", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    const snapBefore = s.snapshot();
    s.push(makePage("goal-input"));
    // snapBefore should still have only 1 entry
    expect(snapBefore).toHaveLength(1);
    expect(snapBefore[0]?.kind).toBe("preset-select");
  });

  test("snapshot reflects current state", () => {
    const s = new PagesStore();
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));
    expect(s.snapshot()).toHaveLength(2);
    expect(s.snapshot()[1]?.kind).toBe("goal-input");
  });
});

// ---------------------------------------------------------------------------
// 7. Listener error handling — throw caught + logged; other listeners fire
// ---------------------------------------------------------------------------

describe("PagesStore — listener error handling", () => {
  test("throwing listener does not prevent subsequent listeners from firing", () => {
    const s = new PagesStore();
    const called: string[] = [];

    s.subscribe("pushed", () => {
      throw new Error("boom");
    });
    s.subscribe("pushed", () => called.push("second"));

    // Should not throw
    expect(() => s.push(makePage("preset-select"))).not.toThrow();
    expect(called).toContain("second");
  });

  test("store keeps working after a listener throws", () => {
    const s = new PagesStore();
    s.subscribe("pushed", () => {
      throw new Error("listener error");
    });
    s.push(makePage("preset-select"));
    s.push(makePage("goal-input"));
    expect(s.depth()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. subscribe — returns unsubscribe function
// ---------------------------------------------------------------------------

describe("PagesStore — subscribe / unsubscribe", () => {
  test("subscribe returns a function", () => {
    const s = new PagesStore();
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op listener for subscribe-return test
    const unsub = s.subscribe("pushed", () => {});
    expect(typeof unsub).toBe("function");
  });

  test("unsubscribe stops listener from firing", () => {
    const s = new PagesStore();
    const calls: number[] = [];
    const unsub = s.subscribe("pushed", () => calls.push(1));

    s.push(makePage("preset-select"));
    unsub();
    s.push(makePage("goal-input"));

    expect(calls).toHaveLength(1);
  });

  test("multiple independent subscriptions work", () => {
    const s = new PagesStore();
    const a: string[] = [];
    const b: string[] = [];

    s.subscribe("top", () => a.push("A"));
    s.subscribe("top", () => b.push("B"));

    s.push(makePage("preset-select"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9 & 10. registerDirtyCheck / hasDirtyTop
// ---------------------------------------------------------------------------

describe("PagesStore — registerDirtyCheck / hasDirtyTop", () => {
  test("hasDirtyTop returns false when no check registered for current top kind", () => {
    const s = new PagesStore();
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("hasDirtyTop returns false when no top", () => {
    const s = new PagesStore();
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("hasDirtyTop returns false when check returns false", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => false);
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("hasDirtyTop returns true when check returns true", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => true);
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(true);
  });

  test("check consulted only for top kind — other kinds ignored", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => true);
    s.push(makePage("preset-select")); // different kind
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("throwing dirty-check is treated as dirty (true)", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => {
      throw new Error("dirty check error");
    });
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(true);
  });

  test("registerDirtyCheck returns an unsubscribe function", () => {
    const s = new PagesStore();
    const unsub = s.registerDirtyCheck("goal-input", () => true);
    expect(typeof unsub).toBe("function");
  });

  test("unsubscribing dirty-check removes it", () => {
    const s = new PagesStore();
    const unsub = s.registerDirtyCheck("goal-input", () => true);
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(true);
    unsub();
    expect(s.hasDirtyTop()).toBe(false);
  });

  test("multiple dirty checks for same kind — true if any returns true", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => false);
    s.registerDirtyCheck("goal-input", () => true);
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(true);
  });

  test("multiple dirty checks — false if all return false", () => {
    const s = new PagesStore();
    s.registerDirtyCheck("goal-input", () => false);
    s.registerDirtyCheck("goal-input", () => false);
    s.push(makePage("goal-input"));
    expect(s.hasDirtyTop()).toBe(false);
  });
});
