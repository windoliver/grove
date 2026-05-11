/**
 * Acceptance test for issue #309 — DAG view shows the literal hint chain
 * documented in the issue acceptance criteria, hint bar updates within
 * one render cycle on stack change, no global hint registry exists.
 *
 * Uses react-test-renderer + bun:test per codebase convention. Mocks
 * @opentui/react's useKeyboard so PagesRouter mounts cleanly without
 * a real terminal.
 */

import { describe, expect, mock, test } from "bun:test";
import type React from "react";

// ---------------------------------------------------------------------------
// Mock @opentui/react — required because PagesRouter calls useKeyboard.
// Must be placed before dynamic imports so the mock is applied at component
// load time (same pattern as pages-nav-acceptance.test.tsx).
// ---------------------------------------------------------------------------

mock.module("@opentui/react", () => ({
  useKeyboard: (_handler: unknown): void => {
    /* noop for test */
  },
  useRenderer: (): { destroy: () => void } => ({ destroy: () => undefined }),
  useTerminalDimensions: (): { width: number; height: number } => ({ width: 120, height: 40 }),
  useTimeline: (): unknown => ({}),
  useOnResize: (_handler: unknown): void => undefined,
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

// Import AFTER mock.module so the mock is applied at component load time.
const TestRenderer = (await import("react-test-renderer")).default;
const { act } = await import("react-test-renderer");
const { PagesStore } = await import("../../src/tui/data/pages-store.js");
const { PagesRouter } = await import("../../src/tui/components/pages-router.js");

import type { PagesRouterComponentMap } from "../../src/tui/components/pages-router.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Stub component map — covers all 10 PageKind values (TS forces completeness)
// ---------------------------------------------------------------------------

function makeStubs(): PagesRouterComponentMap {
  const stub = (label: string) =>
    function Stub(): React.ReactNode {
      return <text>{label}</text>;
    };
  return {
    "preset-select": stub("preset"),
    "goal-input": stub("goal"),
    "agent-detect": stub("detect"),
    "launch-preview": stub("preview"),
    spawning: stub("spawning"),
    running: stub("running"),
    complete: stub("complete"),
    advanced: stub("advanced"),
    panel: stub("panel"),
    "entity-detail": stub("detail"),
  };
}

// ---------------------------------------------------------------------------
// Acceptance tests
// ---------------------------------------------------------------------------

describe("issue #309 acceptance", () => {
  test("DAG view shows [Enter]Focus [Space]Expand [R]Review [M]Merge [L]Logs", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<PagesRouter store={store} components={makeStubs()} width={120} />) as React.ReactElement,
      );
    });

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("[Enter]");
    expect(flat).toContain("Focus");
    expect(flat).toContain("[Space]");
    expect(flat).toContain("Expand");
    expect(flat).toContain("[R]");
    expect(flat).toContain("Review");
    expect(flat).toContain("[M]");
    expect(flat).toContain("Merge");
    expect(flat).toContain("[L]");
    expect(flat).toContain("Logs");

    renderer.unmount();
  });

  test("hint bar updates within one render cycle on stack push", async () => {
    const store = new PagesStore();
    store.push({ kind: "running" });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (<PagesRouter store={store} components={makeStubs()} width={120} />) as React.ReactElement,
      );
    });

    const beforePush = JSON.stringify(renderer.toJSON());
    expect(beforePush).toContain("Goto"); // running hint
    expect(beforePush).not.toContain("Focus"); // not DAG hint yet

    await act(async () => {
      store.push({ kind: "panel", params: { panel: "dag" } });
    });

    const afterPush = JSON.stringify(renderer.toJSON());
    expect(afterPush).toContain("Focus");
    expect(afterPush).toContain("Expand");

    renderer.unmount();
  });

  test("no global hint registry: src/tui/ has no useRegisterHints or hintRegistry symbol", async () => {
    // Delegate to `git grep` instead of a JS-level recursive walk — git's
    // native grep parallelizes over tracked files and finishes in <100ms
    // even under heavy `bun test` parallel load. The pre-fix Node.js
    // `walk + readFile` per-file approach hit bun's 5s per-test timeout
    // under full test load and took ~3.8s standalone (#309 round 4 fix).
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");

    const REPO_ROOT = path.join(import.meta.dir, "..", "..");
    const result = spawnSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "grep",
        "--name-only",
        "--extended-regexp",
        "useRegisterHints|hintRegistry",
        "--",
        "src/tui/*.ts",
        "src/tui/*.tsx",
        "src/tui/**/*.ts",
        "src/tui/**/*.tsx",
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    // git grep exit codes: 0 = match, 1 = no match, >1 = error.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git grep failed: ${result.stderr}`);
    }
    const offenders = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(offenders).toEqual([]);
  });
});
