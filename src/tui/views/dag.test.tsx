/**
 * Component-level tests for the xray-style DagView (#311 Task 6).
 *
 * Covers:
 *   - linear-chain tree rendering (root + child both appear)
 *   - collapsed root hides descendants
 *   - highlightText colors matching rows without filtering non-matches
 *   - awaiting-review status glyph for a fresh work contribution
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";
import type * as TestRendererTypes from "react-test-renderer";
import { ContributionKind, RelationType } from "../../core/models.js";
import { makeContribution, makeRelation } from "../../core/test-helpers.js";

// Captured useKeyboard handler — tests fire synthetic key events through
// this reference to exercise the production keybinding path.
const capturedKeyHandlers: ((key: { name?: string; shift?: boolean }) => void)[] = [];

mock.module("@opentui/react", () => ({
  useKeyboard: (handler: (key: { name?: string; shift?: boolean }) => void): void => {
    capturedKeyHandlers.push(handler);
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): unknown => ({}),
  useOnResize: (): void => undefined,
  useAppContext: (): unknown => ({}),
  createPortal: (children: unknown): unknown => children,
  createRoot: (): unknown => ({}),
  createElement: (): unknown => null,
  flushSync: (fn: () => void): void => fn(),
  extend: (): void => undefined,
  getComponentCatalogue: (): unknown => ({}),
  componentCatalogue: {},
  baseComponents: {},
  TimeToFirstDraw: (): null => null,
  AppContext: {},
}));

function fireKey(key: { name?: string; shift?: boolean }): void {
  // Only fire the most-recently-registered handler. useKeyboard's mock
  // accumulates handlers across renders; the latest closes over the freshest
  // state and is the one that would have replaced its predecessor inside a
  // real opentui mount.
  const latest = capturedKeyHandlers[capturedKeyHandlers.length - 1];
  if (latest) latest(key);
}

const TestRendererModule = await import("react-test-renderer");
const TestRenderer = (TestRendererModule as unknown as { default: typeof TestRendererTypes })
  .default;
const { act } = TestRendererModule;
const { theme } = await import("../theme.js");
const { DagStateStore } = await import("../data/dag-state-store.js");
const { DagStateProvider } = await import("../hooks/dag-state-context.js");
const { DagView } = await import("./dag.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeStubProvider(contributions: readonly ReturnType<typeof makeContribution>[]): unknown {
  return {
    capabilities: { outcomes: false },
    getDag: async () => ({ contributions }),
    getClaims: async () => [],
    close: () => undefined,
  };
}

describe("DagView (xray)", () => {
  test("renders tree rows top-down for a linear chain", async () => {
    const root = makeContribution({ summary: "root contribution" });
    const child = makeContribution({
      summary: "child contribution",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
    });
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView provider={makeStubProvider([root, child]) as never} active cursor={-1} />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    // Wait one microtask for the stub provider's promise to resolve.
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("root contribution");
    expect(flat).toContain("child contribution");
    renderer.unmount();
  });

  test("collapsed cid hides descendants", async () => {
    const root = makeContribution({ summary: "root-c" });
    const child = makeContribution({
      summary: "child-c",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
    });
    const store = new DagStateStore();
    store.toggleCollapsed(root.cid);
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView provider={makeStubProvider([root, child]) as never} active cursor={-1} />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("root-c");
    expect(flat).not.toContain("child-c");
    renderer.unmount();
  });

  test("highlightText changes matching row foreground but does not remove non-matches", async () => {
    const a = makeContribution({ summary: "match-foo" });
    const b = makeContribution({ summary: "other" });
    const store = new DagStateStore();
    store.setHighlight("foo");
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView
              provider={makeStubProvider([a, b]) as never}
              active
              cursor={-1}
              highlightText="foo"
            />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("match-foo");
    expect(flat).toContain("other"); // not filtered out
    // Highlight color appears at least once.
    expect(flat).toContain(theme.highlightMatch);
    renderer.unmount();
  });

  test("status icon appears for awaiting-review work contribution", async () => {
    const c = makeContribution({ kind: ContributionKind.Work, summary: "needs review" });
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView provider={makeStubProvider([c]) as never} active cursor={-1} />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("?"); // awaiting-review glyph
    renderer.unmount();
  });

  test("space keybinding toggles collapse on the focused row in production path", async () => {
    const root = makeContribution({ summary: "root-kb" });
    const child = makeContribution({
      summary: "child-kb",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
    });
    const store = new DagStateStore();
    capturedKeyHandlers.length = 0;
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView
              provider={makeStubProvider([root, child]) as never}
              active
              cursor={0}
              keysEnabled
            />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.snapshot().collapsed.has(root.cid)).toBe(false);
    await act(async () => {
      fireKey({ name: "space" });
    });
    expect(store.snapshot().collapsed.has(root.cid)).toBe(true);
    await act(async () => {
      fireKey({ name: "space" });
    });
    expect(store.snapshot().collapsed.has(root.cid)).toBe(false);
    renderer.unmount();
  });

  test("Shift+A expands all collapsed cids in production path", async () => {
    const root = makeContribution({ summary: "root-kb-A" });
    const child = makeContribution({
      summary: "child-kb-A",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
    });
    const store = new DagStateStore();
    store.toggleCollapsed(root.cid);
    capturedKeyHandlers.length = 0;
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView
              provider={makeStubProvider([root, child]) as never}
              active
              cursor={0}
              keysEnabled
            />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.snapshot().collapsed.size).toBe(1);
    await act(async () => {
      fireKey({ name: "a", shift: true });
    });
    expect(store.snapshot().collapsed.size).toBe(0);
    renderer.unmount();
  });

  test("accepts filterRole prop without crashing or changing default render", async () => {
    const root = makeContribution({ summary: "root contribution" });
    const child = makeContribution({
      summary: "child contribution",
      createdAt: "2026-05-11T11:30:00Z",
      relations: [makeRelation({ targetCid: root.cid, relationType: RelationType.DerivesFrom })],
    });
    const store = new DagStateStore();
    let renderer!: TestRendererTypes.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <DagStateProvider store={store}>
            <DagView
              provider={makeStubProvider([root, child]) as never}
              active
              cursor={-1}
              filterRole="agent-x"
            />
          </DagStateProvider>
        ) as React.ReactElement,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).not.toBeNull();
    expect(flat).toContain("root contribution");
    expect(flat).toContain("child contribution");
    renderer.unmount();
  });
});
