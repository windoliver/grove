import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { GaugeSnapshot, PulseSnapshot, SeriesSnapshot } from "../data/pulse-aggregator.js";
import { isPulseBackKey, PulseView } from "./pulse-view.js";

const noop = (): void => undefined;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeAggregator {
  private subs: Array<() => void> = [];
  snapshot: PulseSnapshot = makeSnapshot({ running: 1, waitingApproval: 0, failed: 0 });
  subscribe(fn: () => void): () => void {
    this.subs.push(fn);
    return () => {
      this.subs = this.subs.filter((s) => s !== fn);
    };
  }
  getSnapshot(): PulseSnapshot {
    return this.snapshot;
  }
  notify(): void {
    for (const s of [...this.subs]) s();
  }
}

function makeSnapshot(gauges: GaugeSnapshot, series?: Partial<SeriesSnapshot>): PulseSnapshot {
  const zero = new Array(60).fill(0);
  return {
    gauges,
    series: {
      spawnRate: series?.spawnRate ?? zero,
      eventRate: series?.eventRate ?? zero,
      reviewIterations: series?.reviewIterations ?? zero,
      contribRate: series?.contribRate ?? zero,
    },
    tickedAt: 1,
  };
}

describe("PulseView", () => {
  test("renders three gauges and three sparkline rows", async () => {
    const agg = new FakeAggregator();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PulseView aggregator={agg as unknown as never} active={true} onBack={noop} />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("running");
    expect(flat).toContain("waiting-approval");
    expect(flat).toContain("failed");
    expect(flat).toContain("spawn");
    expect(flat).toContain("events");
    expect(flat).toContain("reviews");
    expect(flat).toContain("contribs");
    renderer.unmount();
  });

  test("re-renders when aggregator notifies", async () => {
    const agg = new FakeAggregator();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PulseView aggregator={agg as unknown as never} active={true} onBack={noop} />
        ) as React.ReactElement,
      );
    });
    const initial = JSON.stringify(renderer.toJSON());
    expect(initial).toContain("   1"); // initial running=1 value cell
    await act(async () => {
      agg.snapshot = makeSnapshot({ running: 7, waitingApproval: 2, failed: 0 });
      agg.notify();
    });
    const updated = JSON.stringify(renderer.toJSON());
    expect(updated).toContain("   7");
    expect(updated).toContain("   2");
    renderer.unmount();
  });

  test("renders the back hint", async () => {
    const agg = new FakeAggregator();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <PulseView aggregator={agg as unknown as never} active={true} onBack={noop} />
        ) as React.ReactElement,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Esc / Ctrl+G: back");
    renderer.unmount();
  });
});

describe("isPulseBackKey", () => {
  test("Esc requests back", () => {
    expect(isPulseBackKey({ name: "escape" })).toBe(true);
  });

  test("Ctrl+G requests back", () => {
    expect(isPulseBackKey({ name: "g", ctrl: true })).toBe(true);
  });

  test("plain 'g' (no ctrl) does NOT request back", () => {
    expect(isPulseBackKey({ name: "g" })).toBe(false);
    expect(isPulseBackKey({ name: "g", ctrl: false })).toBe(false);
  });

  test("unrelated keys do not request back", () => {
    expect(isPulseBackKey({ name: "p" })).toBe(false);
    expect(isPulseBackKey({ name: "j" })).toBe(false);
    expect(isPulseBackKey({})).toBe(false);
  });
});
