/**
 * Tests for `useInterval` / `startInterval` (#391 / A8.5 PR5 Task 3).
 *
 * Uses real (short) timers because bun:test does not ship vitest's
 * `advanceTimersByTimeAsync`. React hook is exercised via
 * `react-test-renderer` + `act`, the same pattern used elsewhere in this
 * repo (see src/tui/hooks/use-derived.mount.test.tsx).
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { startInterval, useInterval } from "./use-interval.js";

// React 19 requires this flag when calling `act()` outside Jest.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ProbeProps {
  readonly callback: () => void;
  readonly intervalMs: number;
  readonly active?: boolean;
}

function Probe({ callback, intervalMs, active = true }: ProbeProps): ReactNode {
  useInterval(callback, intervalMs, active);
  return null;
}

describe("useInterval", () => {
  test("fires callback multiple times at the requested cadence", async () => {
    const cb = mock(() => undefined);

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { callback: cb, intervalMs: 25 }));
    });

    await sleep(120); // expect ~4 fires (120/25); use >=2 to avoid flakes
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      renderer?.unmount();
    });
  });

  test("stops when the component unmounts", async () => {
    const cb = mock(() => undefined);

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { callback: cb, intervalMs: 20 }));
    });

    await sleep(80);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      renderer?.unmount();
    });
    const callsAtUnmount = cb.mock.calls.length;

    await sleep(80);
    expect(cb.mock.calls.length).toBe(callsAtUnmount);
  });

  test("does not run when active=false", async () => {
    const cb = mock(() => undefined);

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Probe, { callback: cb, intervalMs: 20, active: false }),
      );
    });

    await sleep(100);
    expect(cb.mock.calls.length).toBe(0);

    await act(async () => {
      renderer?.unmount();
    });
  });

  test("picks up the latest callback (cbRef pattern) across re-renders", async () => {
    // Component re-renders on each `tick` change, passing a *fresh* closure
    // that captures the current `value`. Without the cbRef indirection, the
    // timer would still call the original closure that captured value=0.
    interface ParentState {
      readonly value: number;
    }
    type SetState = (v: number) => void;
    let setVal: SetState | undefined;
    const observed: number[] = [];

    function Parent(): ReactNode {
      const [value, setValue] = useState<number>(0);
      setVal = setValue;
      const state: ParentState = { value };
      // Fresh closure each render — captures `state.value`.
      return createElement(Probe, {
        callback: () => observed.push(state.value),
        intervalMs: 20,
      });
    }

    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Parent));
    });

    // Let one or two ticks fire with value=0.
    await sleep(50);
    const beforeBumpLen = observed.length;
    expect(beforeBumpLen).toBeGreaterThanOrEqual(1);
    expect(observed.every((v) => v === 0)).toBe(true);

    // Bump value — re-render with a new closure capturing value=42.
    await act(async () => {
      setVal?.(42);
    });

    // Subsequent ticks must see the latest value. Wait long enough for the
    // existing timer to fire at least once after the re-render.
    await sleep(80);

    const afterBump = observed.slice(beforeBumpLen);
    expect(afterBump.length).toBeGreaterThanOrEqual(1);
    expect(afterBump.some((v) => v === 42)).toBe(true);

    await act(async () => {
      renderer?.unmount();
    });
  });
});

describe("startInterval", () => {
  test("fires callback repeatedly while running", async () => {
    const cb = mock(() => undefined);
    const stop = startInterval(cb, 25);

    await sleep(120);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);

    stop();
  });

  test("returned stop function clears the timer", async () => {
    const cb = mock(() => undefined);
    const stop = startInterval(cb, 20);

    await sleep(60);
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);

    stop();
    const callsAtStop = cb.mock.calls.length;

    await sleep(80);
    expect(cb.mock.calls.length).toBe(callsAtStop);
  });
});
