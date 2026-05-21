/**
 * Render correctness tests for <LogViewport>: viewport slicing, filter,
 * pause-freeze, autoscroll re-clamp. Pure component — no SSE.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { LogViewport } from "./log-viewport.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBuffer(n: number, flushMs = 50): AgentLogBuffer {
  const buf = new AgentLogBuffer("coder", "sess-vp", 10_000, flushMs);
  for (let i = 0; i < n; i++) {
    buf.push({ ts: i, line: `line-${i}`, type: "output" });
  }
  return buf;
}

describe("LogViewport", () => {
  test("renders the last `viewportLines` lines when scrollOffset=0", async () => {
    const buf = makeBuffer(100);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogViewport buffer={buf} paused={false} filter="" scrollOffset={0} viewportLines={5} />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("line-95");
    expect(flat).toContain("line-99");
    expect(flat).not.toContain("line-94");
    renderer.unmount();
    buf.dispose();
  });

  test("scrollOffset>0 pins viewport above the tail", async () => {
    const buf = makeBuffer(100);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogViewport buffer={buf} paused={false} filter="" scrollOffset={10} viewportLines={5} />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("line-85");
    expect(flat).toContain("line-89");
    expect(flat).not.toContain("line-90");
    renderer.unmount();
    buf.dispose();
  });

  test("filter restricts to matching lines and shows match count", async () => {
    const buf = new AgentLogBuffer("coder", "sess-f", 10_000, 50);
    buf.push({ ts: 0, line: "apple pie", type: "output" });
    buf.push({ ts: 1, line: "banana bread", type: "output" });
    buf.push({ ts: 2, line: "apple cider", type: "output" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogViewport
            buffer={buf}
            paused={false}
            filter="apple"
            scrollOffset={0}
            viewportLines={10}
          />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("apple pie");
    expect(flat).toContain("apple cider");
    expect(flat).not.toContain("banana bread");
    expect(flat).toContain("2/3");
    renderer.unmount();
    buf.dispose();
  });

  test("paused=true freezes the rendered tail despite new pushes", async () => {
    const buf = makeBuffer(10);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogViewport buffer={buf} paused={true} filter="" scrollOffset={0} viewportLines={5} />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });

    await act(async () => {
      buf.push({ ts: 100, line: "line-99-after-pause", type: "output" });
      await new Promise((r) => setTimeout(r, 80));
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("line-5");
    expect(flat).toContain("line-9");
    expect(flat).not.toContain("after-pause");
    expect(flat).toContain("PAUSED");
    renderer.unmount();
    buf.dispose();
  });

  test("autoscroll re-clamps to bottom when buffer grows with scrollOffset=0", async () => {
    const buf = makeBuffer(10);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogViewport buffer={buf} paused={false} filter="" scrollOffset={0} viewportLines={5} />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });

    // Initial viewport tail: line-5..line-9.
    let flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("line-9");

    // Push new lines while autoscroll is on; viewport must advance.
    await act(async () => {
      buf.push({ ts: 100, line: "line-fresh-A", type: "output" });
      buf.push({ ts: 101, line: "line-fresh-B", type: "output" });
      await new Promise((r) => setTimeout(r, 80));
    });

    flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("line-fresh-A");
    expect(flat).toContain("line-fresh-B");
    // Tail advanced: line-5 should have fallen off the 5-line viewport.
    expect(flat).not.toContain("line-5");

    renderer.unmount();
    buf.dispose();
  });
});
