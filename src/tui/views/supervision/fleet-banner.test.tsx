import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FleetBanner } from "./fleet-banner.js";
import type { FleetSummary } from "./types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    total: 7,
    byState: {
      running: 4,
      silent: 1,
      stuck: 0,
      blocked: 1,
      thrashing: 0,
      awaiting: 1,
      done: 0,
      idle: 0,
    },
    approvalsPending: 1,
    costUsd: 4.21,
    costSpikeCount: 0,
    contextHotCount: 1,
    ...over,
  };
}

async function renderBanner(props: React.ComponentProps<typeof FleetBanner>) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(FleetBanner, props));
  });
  return renderer!;
}

describe("FleetBanner", () => {
  test("renders state counts and cost", async () => {
    const renderer = await renderBanner({
      summary: summary(),
      filterText: "",
      filterMode: "idle",
      sort: "severity",
      stateFilter: "all",
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toMatch(/4 run/);
    expect(s).toMatch(/1 blk/);
    expect(s).toMatch(/1 silent/);
    expect(s).toMatch(/cost \$4\.21/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("shows approval chip when approvalsPending > 0", async () => {
    const renderer = await renderBanner({
      summary: summary({ approvalsPending: 3 }),
      filterText: "",
      filterMode: "idle",
      sort: "severity",
      stateFilter: "all",
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toMatch(/3 ⏸ approve/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("hides approval chip when 0 pending", async () => {
    const renderer = await renderBanner({
      summary: summary({ approvalsPending: 0 }),
      filterText: "",
      filterMode: "idle",
      sort: "severity",
      stateFilter: "all",
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).not.toMatch(/⏸ approve/);
    await act(async () => {
      renderer.unmount();
    });
  });

  test("filter mode shows trailing cursor _", async () => {
    const renderer = await renderBanner({
      summary: summary(),
      filterText: "rev",
      filterMode: "filter",
      sort: "severity",
      stateFilter: "all",
    });
    const s = JSON.stringify(renderer.toJSON());
    expect(s).toMatch(/\/rev_/);
    await act(async () => {
      renderer.unmount();
    });
  });
});
