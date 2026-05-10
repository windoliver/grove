/**
 * Tests for useScreenStack hook.
 *
 * Uses react-test-renderer + bun:test (no @testing-library/react).
 */

import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { PagesStore } from "../data/pages-store.js";
import type { ScreenStackValue } from "./use-screen-stack.js";
import { useScreenStack } from "./use-screen-stack.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Probe component — captures the hook's return value on each render.
// ---------------------------------------------------------------------------

function Probe({
  store,
  onValue,
}: {
  store: PagesStore;
  onValue: (v: ScreenStackValue) => void;
}): null {
  const value = useScreenStack(store);
  onValue(value);
  return null;
}

describe("useScreenStack", () => {
  // -------------------------------------------------------------------------
  // 1. Initial state from a pre-populated store
  // -------------------------------------------------------------------------
  test("returns initial top and depth from a pre-populated store", async () => {
    const store = new PagesStore();
    store.push({ kind: "preset-select" });
    store.push({ kind: "goal-input" });

    let captured: ScreenStackValue | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Probe
          store={store}
          onValue={(v) => {
            captured = v;
          }}
        />,
      );
    });

    expect(captured).toBeDefined();
    expect(captured!.top?.kind).toBe("goal-input");
    expect(captured!.depth).toBe(2);
    expect(captured!.snapshot).toHaveLength(2);
    expect(captured!.snapshot[0]?.kind).toBe("preset-select");
    expect(captured!.snapshot[1]?.kind).toBe("goal-input");

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 2. push on the store causes the hook to deliver new top + depth
  // -------------------------------------------------------------------------
  test("push on the store updates top and depth in the hook", async () => {
    const store = new PagesStore();
    store.push({ kind: "preset-select" });

    const renders: ScreenStackValue[] = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Probe
          store={store}
          onValue={(v) => {
            renders.push(v);
          }}
        />,
      );
    });

    expect(renders.at(-1)!.depth).toBe(1);
    expect(renders.at(-1)!.top?.kind).toBe("preset-select");

    await act(async () => {
      store.push({ kind: "goal-input" });
    });

    expect(renders.at(-1)!.depth).toBe(2);
    expect(renders.at(-1)!.top?.kind).toBe("goal-input");

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 3. pop on the store delivers the prior top and decremented depth
  // -------------------------------------------------------------------------
  test("pop on the store reverts top and depth in the hook", async () => {
    const store = new PagesStore();
    store.push({ kind: "preset-select" });
    store.push({ kind: "goal-input" });

    const renders: ScreenStackValue[] = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Probe
          store={store}
          onValue={(v) => {
            renders.push(v);
          }}
        />,
      );
    });

    expect(renders.at(-1)!.depth).toBe(2);
    expect(renders.at(-1)!.top?.kind).toBe("goal-input");

    await act(async () => {
      store.pop();
    });

    expect(renders.at(-1)!.depth).toBe(1);
    expect(renders.at(-1)!.top?.kind).toBe("preset-select");

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 4. After unmount, store mutations no longer trigger renders
  // -------------------------------------------------------------------------
  test("store mutations after unmount do not trigger renders", async () => {
    const store = new PagesStore();
    store.push({ kind: "preset-select" });

    let renderCount = 0;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Probe
          store={store}
          onValue={() => {
            renderCount += 1;
          }}
        />,
      );
    });

    const countAtUnmount = renderCount;

    await act(async () => {
      renderer.unmount();
    });

    // Mutate after unmount
    store.push({ kind: "goal-input" });
    store.push({ kind: "running" });

    // Give React a tick to process anything (should be nothing)
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderCount).toBe(countAtUnmount);
  });

  // -------------------------------------------------------------------------
  // 5. Bound action callbacks (push/pop/replace) mutate the underlying store
  // -------------------------------------------------------------------------
  test("push/pop/replace action callbacks mutate the underlying store", async () => {
    const store = new PagesStore();
    store.push({ kind: "preset-select" });

    let captured: ScreenStackValue | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Probe
          store={store}
          onValue={(v) => {
            captured = v;
          }}
        />,
      );
    });

    // push via hook callback
    await act(async () => {
      captured!.push({ kind: "goal-input" });
    });
    expect(store.top()?.kind).toBe("goal-input");
    expect(store.depth()).toBe(2);

    // replace via hook callback
    await act(async () => {
      captured!.replace({ kind: "agent-detect" });
    });
    expect(store.top()?.kind).toBe("agent-detect");
    expect(store.depth()).toBe(2);

    // pop via hook callback
    await act(async () => {
      captured!.pop();
    });
    expect(store.top()?.kind).toBe("preset-select");
    expect(store.depth()).toBe(1);

    renderer.unmount();
  });
});
