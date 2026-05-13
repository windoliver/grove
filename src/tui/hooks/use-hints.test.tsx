/**
 * Tests for useHints hook.
 *
 * Uses react-test-renderer + bun:test (no @testing-library/react).
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { KeyAction } from "../data/hint-map.js";
import { hintsForPage } from "../data/hint-map.js";
import { PagesStore } from "../data/pages-store.js";
import { useHints } from "./use-hints.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Probe component — captures the hook's return value on each render.
// ---------------------------------------------------------------------------

function Probe({
  store,
  onValue,
}: {
  store: PagesStore;
  onValue: (v: readonly KeyAction[]) => void;
}): null {
  const hints = useHints(store);
  onValue(hints);
  return null;
}

describe("useHints", () => {
  // -------------------------------------------------------------------------
  // 1. Initial state: pre-populated store with running page
  // -------------------------------------------------------------------------
  test("returns hints for pre-populated running page", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let captured: readonly KeyAction[] | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              captured = v;
            }}
          />
        ) as React.ReactElement,
      );
    });

    expect(captured).toBeDefined();
    expect(captured).toEqual(hintsForPage({ kind: "running" }));

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 2. After push: running → panel:dag returns DAG hints
  // -------------------------------------------------------------------------
  test("returns DAG hints after pushing panel:dag page", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    const renders: Array<readonly KeyAction[]> = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              renders.push(v);
            }}
          />
        ) as React.ReactElement,
      );
    });

    // Initial render should show running hints
    expect(renders.at(-1)).toEqual(hintsForPage({ kind: "running" }));

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });

    expect(renders.at(-1)).toEqual(hintsForPage({ kind: "panel", params: { panel: "dag" } }));

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 3. After pop: [running, panel:dag] → pop → running hints
  // -------------------------------------------------------------------------
  test("returns running hints after popping panel:dag page", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });
    store.push({ kind: "panel", params: { panel: "dag" } });

    const renders: Array<readonly KeyAction[]> = [];

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              renders.push(v);
            }}
          />
        ) as React.ReactElement,
      );
    });

    // Initial render should show DAG hints
    expect(renders.at(-1)).toEqual(hintsForPage({ kind: "panel", params: { panel: "dag" } }));

    await act(async () => {
      store.pop();
    });

    expect(renders.at(-1)).toEqual(hintsForPage({ kind: "running" }));

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 4. Empty store: returns []
  // -------------------------------------------------------------------------
  test("returns empty array for empty store", async () => {
    const store = new PagesStore();

    let captured: readonly KeyAction[] | undefined;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={(v) => {
              captured = v;
            }}
          />
        ) as React.ReactElement,
      );
    });

    expect(captured).toBeDefined();
    expect(captured).toEqual([]);

    renderer.unmount();
  });

  // -------------------------------------------------------------------------
  // 5. Unmount safety: store mutations after unmount do not increment render count
  // -------------------------------------------------------------------------
  test("store mutations after unmount do not trigger renders", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderCount = 0;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <Probe
            store={store}
            onValue={() => {
              renderCount += 1;
            }}
          />
        ) as React.ReactElement,
      );
    });

    const countAtUnmount = renderCount;

    await act(async () => {
      renderer.unmount();
    });

    // Mutate after unmount
    store.push({ kind: "goal-input" });
    store.push({ kind: "complete" });

    // Give React a tick to process anything (should be nothing)
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderCount).toBe(countAtUnmount);
  });
});
