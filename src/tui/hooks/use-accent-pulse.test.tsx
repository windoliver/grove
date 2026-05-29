/**
 * Tests for {@link useAccentPulse} (#192) — the shared focus-change accent
 * pulse hook extracted from <DetailView> and <ArtifactPreviewView>.
 *
 * The hook must be test-safe under react-test-renderer: all timeline/timer
 * calls live inside useEffect, so a plain mount + trigger update is a no-op
 * (no throw, no timer leak). It returns a boolean pulse flag.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useAccentPulse } from "./use-accent-pulse.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Tiny harness component: exposes the returned pulse flag as a string leaf so
// the test can read it from the rendered tree, and exposes the raw value for
// type assertions via a captured ref.
// ---------------------------------------------------------------------------

let lastPulse: unknown;

function Harness({ trigger }: { readonly trigger?: number | undefined }): React.ReactNode {
  const pulse = useAccentPulse(trigger);
  lastPulse = pulse;
  return <text>{String(pulse)}</text>;
}

describe("useAccentPulse (#192)", () => {
  test("renders without throwing and returns a boolean", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<Harness trigger={0} />) as React.ReactElement);
    });
    expect(renderer.toJSON()).toBeDefined();
    expect(typeof lastPulse).toBe("boolean");
    renderer.unmount();
  });

  test("renders without throwing when trigger is undefined", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<Harness />) as React.ReactElement);
    });
    expect(renderer.toJSON()).toBeDefined();
    expect(typeof lastPulse).toBe("boolean");
    renderer.unmount();
  });

  test("mounting then updating the trigger re-renders without throwing", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<Harness trigger={0} />) as React.ReactElement);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update((<Harness trigger={1} />) as React.ReactElement);
    });
    expect(renderer.toJSON()).toBeDefined();
    expect(typeof lastPulse).toBe("boolean");
    renderer.unmount();
  });

  // Regression (F3 / round-1 review): after a trigger change the pulse must
  // return to false within ~durationMs. The original effect listed the
  // per-render `timeline` instance in its deps, so setPulse(true)'s re-render
  // re-ran the effect, cleared the fallback timer, then early-returned —
  // leaving the pulse stuck on permanently. With deps [trigger, durationMs]
  // the fallback timer survives and clears the pulse.
  test("pulse returns to false within ~durationMs after a trigger change (no stuck-on)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create((<Harness trigger={0} />) as React.ReactElement);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Change the trigger -> pulse flips true.
    await act(async () => {
      renderer.update((<Harness trigger={1} />) as React.ReactElement);
    });
    // Wait past the fallback clear (durationMs default 150 + 20 slack).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(lastPulse).toBe(false);
    renderer.unmount();
  });
});
