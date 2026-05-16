/**
 * Tests for PagesRouter.
 *
 * Two groups:
 *   Group 1 — pure reducer (no rendering). Only the dialog-key cases now;
 *             non-dialog states are uniformly noop.
 *   Group 2 — component rendering via react-test-renderer + store mutations.
 *
 * Note on useKeyboard mocking:
 *   We use mock.module("@opentui/react", ...) (same pattern as screen-manager.test.ts)
 *   to capture the keyboard handler. This lets us drive keyboard events from tests
 *   without a real OpenTUI renderer. The mock is set up at module scope so it applies
 *   before the pages-router module is imported.
 *
 * Esc-pop behavior was deliberately moved out of the router (see
 * pages-router.tsx header). Tests reflect that: bare escape is a noop here.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Page, PageKind } from "../data/pages-store.js";
import { PagesStore } from "../data/pages-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Group 1 — pure reducer (no rendering, no mocks needed)
// ---------------------------------------------------------------------------

import type { RouterKeyState } from "./pages-router.js";
// Import the pure functions directly — safe before any mock.module() calls
import { reduceRouterKey } from "./pages-router.js";

describe("reduceRouterKey", () => {
  const closed: RouterKeyState = { dialogOpen: false };
  const withDialog: RouterKeyState = { dialogOpen: true };

  test("dialogOpen=true + y → popAndCloseDialog", () => {
    expect(reduceRouterKey(withDialog, "y")).toEqual({ type: "popAndCloseDialog" });
  });

  test("dialogOpen=true + n → closeDialog", () => {
    expect(reduceRouterKey(withDialog, "n")).toEqual({ type: "closeDialog" });
  });

  test("dialogOpen=true + escape → closeDialog", () => {
    expect(reduceRouterKey(withDialog, "escape")).toEqual({ type: "closeDialog" });
  });

  test("dialogOpen=true + any other key → noop", () => {
    expect(reduceRouterKey(withDialog, "j")).toEqual({ type: "noop" });
    expect(reduceRouterKey(withDialog, "q")).toEqual({ type: "noop" });
    expect(reduceRouterKey(withDialog, "return")).toEqual({ type: "noop" });
  });

  test("dialogOpen=false + escape → noop (router does NOT pop or quit)", () => {
    expect(reduceRouterKey(closed, "escape")).toEqual({ type: "noop" });
  });

  test("dialogOpen=false + any non-escape key → noop", () => {
    expect(reduceRouterKey(closed, "j")).toEqual({ type: "noop" });
    expect(reduceRouterKey(closed, "q")).toEqual({ type: "noop" });
    expect(reduceRouterKey(closed, "tab")).toEqual({ type: "noop" });
    expect(reduceRouterKey(closed, "y")).toEqual({ type: "noop" });
    expect(reduceRouterKey(closed, "n")).toEqual({ type: "noop" });
  });
});

// ---------------------------------------------------------------------------
// Group 2 — component rendering
// ---------------------------------------------------------------------------

type KeyboardHandler = (key: { name: string }) => void;
let capturedKeyboardHandler: KeyboardHandler | undefined;

// Mock @opentui/react before importing pages-router component so the handler
// is captured during component mount.
mock.module("@opentui/react", () => ({
  useKeyboard: (handler: KeyboardHandler): void => {
    capturedKeyboardHandler = handler;
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
}));

// Import the component AFTER mock.module so the mock is applied
const { PagesRouter } = await import("./pages-router.js");

import type { PagesRouterComponentMap } from "./pages-router.js";

// Minimal stub components for each PageKind used in tests
function makeStubComponents(): PagesRouterComponentMap {
  const kinds: PageKind[] = [
    "preset-select",
    "goal-input",
    "agent-detect",
    "launch-preview",
    "spawning",
    "running",
    "complete",
    "inspect",
    "panel",
    "entity-detail",
  ];
  const map: Partial<PagesRouterComponentMap> = {};
  for (const kind of kinds) {
    const label = kind.toUpperCase().replace(/-/g, "_");
    map[kind] = ({ page }: { page: Page }) => (
      <text>{`STUB_${label}:${page.params?.panel ?? ""}`}</text>
    );
  }
  return map as PagesRouterComponentMap;
}

const STUB_COMPONENTS = makeStubComponents();

function makeStore(...pages: Page[]): PagesStore {
  const store = new PagesStore();
  for (const page of pages) {
    store.push(page);
  }
  return store;
}

interface RenderRouterOptions {
  readonly presetName?: string;
  readonly sessionId?: string;
}

function renderRouter(
  store: PagesStore,
  options: RenderRouterOptions = {},
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PagesRouter, {
        store,
        components: STUB_COMPONENTS,
        width: 120,
        ...(options.presetName !== undefined ? { presetName: options.presetName } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      }),
    );
  });
  if (!renderer) throw new Error("PagesRouter did not mount");
  return renderer;
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  capturedKeyboardHandler = undefined;
});

afterEach(() => {
  for (const r of mountedRenderers.splice(0)) {
    r.unmount();
  }
});

async function pressKey(name: string): Promise<void> {
  const handler = capturedKeyboardHandler;
  if (!handler) throw new Error("No keyboard handler registered");
  await act(async () => {
    handler({ name });
  });
}

describe("PagesRouter rendering", () => {
  test("renders the running stub when a running page is on the stack", () => {
    const store = makeStore({ kind: "running" });
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("STUB_RUNNING");
  });

  test("pushing a panel page swaps to the panel stub", () => {
    const store = makeStore({ kind: "running" });
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    act(() => {
      store.push({ kind: "panel", params: { panel: "agents" } });
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("STUB_PANEL");
    expect(flat).not.toContain("STUB_RUNNING");
  });

  test("breadcrumb shows Running for a running page (width 120)", () => {
    const store = makeStore({ kind: "running" });
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    const flat = JSON.stringify(renderer.toJSON());
    // BreadcrumbBar renders "Running" as the current label
    expect(flat).toContain("Running");
  });

  test("breadcrumb shows Panel page label after pushing a panel", () => {
    const store = makeStore({ kind: "running" });
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    act(() => {
      store.push({ kind: "panel", params: { panel: "agents" } });
    });

    const flat = JSON.stringify(renderer.toJSON());
    // BreadcrumbBar renders "Agents" for panel:agents
    expect(flat).toContain("Agents");
  });

  test("breadcrumb forwards presetName during the wizard", () => {
    const store = makeStore({ kind: "goal-input" });
    const renderer = renderRouter(store, { presetName: "review-loop" });
    mountedRenderers.push(renderer);

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("review-loop");
  });

  // Keyboard-driven tests: use mock-captured handler.
  // The router no longer pops or opens dialogs on bare escape — those
  // responsibilities live in inner screens (running-view, etc.). The
  // dialog-handling branch is dormant in production; Task 9 will rewire it.

  test("esc when dialog is closed is a noop (no pop, stack unchanged)", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    expect(store.depth()).toBe(2);
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    await pressKey("escape");

    // Router does NOT pop on bare escape — stack should be unchanged.
    expect(store.depth()).toBe(2);
    expect(store.top()?.kind).toBe("panel");
  });

  test("esc when dialog is closed at depth=1 does not call onQuit (no quit prop)", async () => {
    const store = makeStore({ kind: "running" });
    expect(store.depth()).toBe(1);
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    await pressKey("escape");

    // Stack stays the same — router never quits on its own.
    expect(store.depth()).toBe(1);
    expect(store.top()?.kind).toBe("running");
  });

  test("esc when dirty top is registered does NOT open dialog (router no longer auto-opens)", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    store.registerDirtyCheck("panel", () => true);

    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    await pressKey("escape");

    const flat = JSON.stringify(renderer.toJSON());
    // Dialog stays dormant; the dirty-confirm UX is rewired in a later task.
    expect(flat).not.toContain("Discard unsaved changes?");
    // Stack unchanged.
    expect(store.depth()).toBe(2);
  });

  test("renders null when the store is empty", () => {
    const store = new PagesStore(); // empty
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);
    expect(renderer.toJSON()).toBeNull();
  });

  test("HintBar reflects current top page (#309 wiring)", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PagesRouter store={store} components={STUB_COMPONENTS} width={120} />
        ) as React.ReactElement,
      );
    });

    // Running hints visible (SupervisionScreen hints — successor to RUNNING_VIEW_HINTS)
    expect(JSON.stringify(renderer.toJSON())).toContain("[h/j/k/l]");
    expect(JSON.stringify(renderer.toJSON())).toContain("Move");
    expect(JSON.stringify(renderer.toJSON())).toContain("[/]");
    expect(JSON.stringify(renderer.toJSON())).toContain("Filter");

    // Push panel:dag → DAG hints
    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });
    const dagFlat = JSON.stringify(renderer.toJSON());
    expect(dagFlat).toContain("[Enter]");
    expect(dagFlat).toContain("Focus");
    expect(dagFlat).toContain("[Space]");
    expect(dagFlat).toContain("Expand");
    expect(dagFlat).toContain("[R]");
    expect(dagFlat).toContain("Review");
    expect(dagFlat).toContain("[M]");
    expect(dagFlat).toContain("Merge");
    expect(dagFlat).toContain("[L]");
    expect(dagFlat).toContain("Logs");

    // Pop → running hints again (supervision hints)
    await act(async () => {
      store.pop();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Move");

    renderer.unmount();
  });
});
