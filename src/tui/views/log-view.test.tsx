/**
 * Tests for <LogView>: prop wiring and rendering. State (paused, filter,
 * scrollOffset) is controlled by the parent; LogView just forwards to
 * <LogViewport>. Keyboard dispatch lives in running-keyboard.ts and is
 * exercised in its own test suite.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AgentLogBuffer } from "../data/agent-log-buffer.js";
import { LogView } from "./log-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBuffer(n: number): AgentLogBuffer {
  const buf = new AgentLogBuffer("coder", "sess-lv", 10_000, 50);
  for (let i = 0; i < n; i++) {
    buf.push({ ts: i, line: `line-${i}`, type: "output" });
  }
  return buf;
}

describe("LogView", () => {
  test("renders fallback when buffer is undefined", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogView
            sessionId="missing"
            buffer={undefined}
            paused={false}
            filter=""
            filterMode={false}
            scrollOffset={0}
          />
        ) as React.ReactElement,
      );
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("No log buffer");
    renderer.unmount();
  });

  test("forwards state to LogViewport: pause badge shown when paused=true", async () => {
    const buf = makeBuffer(10);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogView
            sessionId="sess-lv"
            buffer={buf}
            paused={true}
            filter=""
            filterMode={false}
            scrollOffset={0}
          />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("PAUSED");
    renderer.unmount();
    buf.dispose();
  });

  test("filterMode renders the filter prompt", async () => {
    const buf = makeBuffer(5);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        (
          <LogView
            sessionId="sess-lv"
            buffer={buf}
            paused={false}
            filter="abc"
            filterMode={true}
            scrollOffset={0}
          />
        ) as React.ReactElement,
      );
      await new Promise((r) => setTimeout(r, 80));
    });
    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("filter:");
    expect(flat).toContain("abc");
    renderer.unmount();
    buf.dispose();
  });
});
