/**
 * Issue #303 acceptance test — :a → :s → esc returns to agents.
 *
 * Integration test of PagesStore data plane + PagesRouter rendering.
 * Drives the store with the same push/pop calls that gotoDispatch makes in
 * production (running-view.tsx), then verifies that the rendered output and
 * stack state both match the expected navigation outcome.
 *
 * Acceptance criterion (verbatim from #303):
 *   Typing :a (goto agents), then :s (goto sessions), then pressing escape
 *   returns the user to the agents view — NOT to the initial running view.
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PagesStore } from "../../src/tui/data/pages-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mock @opentui/react — required because PagesRouter calls useKeyboard.
// Must be set up before importing PagesRouter.
// ---------------------------------------------------------------------------

mock.module("@opentui/react", () => ({
  useKeyboard: (): void => {
    // No-op: keyboard handler is not exercised in this data-plane test.
    // Esc is simulated via direct store.pop() calls, mirroring the pop
    // short-circuit that running-view fires on escape (Task 8).
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
}));

// Import AFTER mock.module so the mock is applied at component load time.
const { PagesRouter } = await import("../../src/tui/components/pages-router.js");

import type { PagesRouterComponentMap } from "../../src/tui/components/pages-router.js";
import type { Page } from "../../src/tui/data/pages-store.js";

// ---------------------------------------------------------------------------
// Stub component map — covers all 10 PageKind values (TS forces completeness)
// ---------------------------------------------------------------------------

function makeStubs(): PagesRouterComponentMap {
  const stub = (label: string) =>
    function Stub() {
      return <text>{label}</text>;
    };

  return {
    "preset-select": stub("preset"),
    "goal-input": stub("goal"),
    "agent-detect": stub("detect"),
    "launch-preview": stub("preview"),
    spawning: stub("spawning"),
    running: stub("running-feed"),
    complete: stub("complete"),
    advanced: stub("advanced"),
    panel: function Panel({ page }: { page: Page }) {
      return <text>{`panel:${page.params?.panel ?? ""}`}</text>;
    },
    "entity-detail": stub("detail"),
  };
}

// ---------------------------------------------------------------------------
// Acceptance test
// ---------------------------------------------------------------------------

describe("issue #303 acceptance — :a → :s → esc returns to agents", () => {
  test("two pushes + one pop leaves user on agents", async () => {
    const store = new PagesStore();
    // Simulate screen-manager's resetTo("running") after spawn-complete.
    store.push({ kind: "running" });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<PagesRouter store={store} components={makeStubs()} width={120} />) as React.ReactElement,
      );
    });

    // Step 1: initial render shows the running screen.
    expect(JSON.stringify(renderer.toJSON())).toContain("running-feed");
    expect(store.depth()).toBe(1);

    // Step 2: :a → gotoDispatch pushes panel:agents.
    await act(async () => {
      store.push({ kind: "panel", params: { panel: "agents" } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("panel:agents");
    expect(store.depth()).toBe(2);

    // Step 3: :s → gotoDispatch pushes panel:sessions.
    await act(async () => {
      store.push({ kind: "panel", params: { panel: "sessions" } });
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("panel:sessions");
    expect(store.depth()).toBe(3);

    // Step 4: esc → running-view's pop short-circuit fires (Task 8).
    // Simulate that by calling store.pop() directly — same call the screen makes.
    await act(async () => {
      store.pop();
    });

    // Acceptance criterion: rendered view returns to agents, NOT to running.
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("panel:agents");
    expect(flat).not.toContain("panel:sessions");
    expect(flat).not.toContain("running-feed");

    // Stack state: depth=2, top=panel:agents.
    expect(store.depth()).toBe(2);
    expect(store.top()).toEqual({ kind: "panel", params: { panel: "agents" } });

    renderer.unmount();
  });
});
