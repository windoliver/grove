/**
 * Tests for PagesRouter.
 *
 * Two groups:
 *   Group 1 — pure reducer (no rendering). All 8 action-mapping cases.
 *   Group 2 — component rendering via react-test-renderer + store mutations.
 *
 * Note on useKeyboard mocking:
 *   We use mock.module("@opentui/react", ...) (same pattern as screen-manager.test.ts)
 *   to capture the keyboard handler. This lets us drive keyboard events from tests
 *   without a real OpenTUI renderer. The mock is set up at module scope so it applies
 *   before the pages-router module is imported.
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
  const clean: RouterKeyState = { dialogOpen: false, dirty: false, depth: 2 };
  const cleanDepth1: RouterKeyState = { dialogOpen: false, dirty: false, depth: 1 };
  const dirty: RouterKeyState = { dialogOpen: false, dirty: true, depth: 2 };
  const withDialog: RouterKeyState = { dialogOpen: true, dirty: false, depth: 2 };

  test("escape + clean + depth=2 → pop", () => {
    expect(reduceRouterKey(clean, "escape")).toEqual({ type: "pop" });
  });

  test("escape + clean + depth=1 → quit", () => {
    expect(reduceRouterKey(cleanDepth1, "escape")).toEqual({ type: "quit" });
  });

  test("escape + dirty → openDialog", () => {
    expect(reduceRouterKey(dirty, "escape")).toEqual({ type: "openDialog" });
  });

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

  test("non-escape key with dialogOpen=false → noop", () => {
    expect(reduceRouterKey(clean, "j")).toEqual({ type: "noop" });
    expect(reduceRouterKey(clean, "q")).toEqual({ type: "noop" });
    expect(reduceRouterKey(clean, "tab")).toEqual({ type: "noop" });
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
    "advanced",
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

function renderRouter(
  store: PagesStore,
  onQuit: () => void = () => undefined,
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PagesRouter, {
        store,
        components: STUB_COMPONENTS,
        onQuit,
        width: 120,
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

  // Keyboard-driven tests: use mock-captured handler
  test("esc on non-dirty top with depth=2 calls store.pop()", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    expect(store.depth()).toBe(2);
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    await pressKey("escape");

    expect(store.depth()).toBe(1);
    expect(store.top()?.kind).toBe("running");
  });

  test("esc on dirty top opens dialog (rendered text contains 'Discard unsaved changes?')", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    // Register a dirty check for the panel page
    store.registerDirtyCheck("panel", () => true);

    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    await pressKey("escape");

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("Discard unsaved changes?");
  });

  test("from open dialog, n closes dialog without popping", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    store.registerDirtyCheck("panel", () => true);

    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    // Open dialog
    await pressKey("escape");
    expect(JSON.stringify(renderer.toJSON())).toContain("Discard unsaved changes?");

    // Close without popping
    await pressKey("n");

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).not.toContain("Discard unsaved changes?");
    // Stack should be unchanged
    expect(store.depth()).toBe(2);
  });

  test("from open dialog, y pops and closes dialog", async () => {
    const store = makeStore({ kind: "running" }, { kind: "panel", params: { panel: "agents" } });
    store.registerDirtyCheck("panel", () => true);

    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);

    // Open dialog
    await pressKey("escape");
    expect(JSON.stringify(renderer.toJSON())).toContain("Discard unsaved changes?");

    // Confirm pop
    await pressKey("y");

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).not.toContain("Discard unsaved changes?");
    // Stack should have been popped
    expect(store.depth()).toBe(1);
    expect(store.top()?.kind).toBe("running");
  });

  test("renders null when the store is empty", () => {
    const store = new PagesStore(); // empty
    const renderer = renderRouter(store);
    mountedRenderers.push(renderer);
    expect(renderer.toJSON()).toBeNull();
  });
});
