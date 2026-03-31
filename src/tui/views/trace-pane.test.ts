/**
 * Tests for TracePane component — rendering contract with mock data.
 *
 * Tests the data flow: given buffer state and selection, verify the correct
 * lines appear. Uses AgentLogBuffer directly (not mocks) for realistic behavior.
 */

import { describe, expect, test } from "bun:test";
import { AgentLogBuffer, type LogLine } from "../data/agent-log-buffer.js";

// ---------------------------------------------------------------------------
// We test the rendering logic extracted from the component, not the React
// component itself (which requires OpenTUI renderer). This tests the core
// viewport computation and data flow that the component relies on.
// ---------------------------------------------------------------------------

/** Replicate the viewport computation from TracePane. */
function computeViewport(
  buffer: AgentLogBuffer | undefined,
  scrollOffset: number,
  viewportLines: number,
): LogLine[] {
  if (!buffer || buffer.isEmpty) return [];
  const total = buffer.size;
  const end = Math.max(0, total - scrollOffset);
  const start = Math.max(0, end - viewportLines);
  return buffer.slice(start, end);
}

describe("TracePane viewport computation", () => {
  test("returns empty for empty buffer", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    expect(computeViewport(buf, 0, 25)).toEqual([]);
  });

  test("returns empty for undefined buffer", () => {
    expect(computeViewport(undefined, 0, 25)).toEqual([]);
  });

  test("returns all lines when buffer < viewport", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1000, line: "line1", type: "output" });
    buf.push({ ts: 2000, line: "line2", type: "output" });
    const viewport = computeViewport(buf, 0, 25);
    expect(viewport.length).toBe(2);
    expect(viewport[0]?.line).toBe("line1");
    expect(viewport[1]?.line).toBe("line2");
  });

  test("returns last N lines when buffer > viewport (auto-scroll)", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 50; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    const viewport = computeViewport(buf, 0, 10);
    expect(viewport.length).toBe(10);
    expect(viewport[0]?.line).toBe("line-40");
    expect(viewport[9]?.line).toBe("line-49");
  });

  test("scroll offset shifts viewport up", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 50; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    // Scroll up by 5 lines
    const viewport = computeViewport(buf, 5, 10);
    expect(viewport.length).toBe(10);
    expect(viewport[0]?.line).toBe("line-35");
    expect(viewport[9]?.line).toBe("line-44");
  });

  test("large scroll offset shows oldest lines", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 50; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    // Scroll to top
    const viewport = computeViewport(buf, 40, 10);
    expect(viewport.length).toBe(10);
    expect(viewport[0]?.line).toBe("line-0");
    expect(viewport[9]?.line).toBe("line-9");
  });

  test("scroll offset beyond buffer shows what's available", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 5; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    const viewport = computeViewport(buf, 100, 10);
    // end = max(0, 5 - 100) = 0, start = max(0, 0 - 10) = 0 → empty
    expect(viewport.length).toBe(0);
  });
});

describe("TracePane line classification display", () => {
  test("different line types are preserved for coloring", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1, line: "[tool] Read file.ts", type: "tool" });
    buf.push({ ts: 2, line: "Normal output", type: "output" });
    buf.push({ ts: 3, line: "[IPC from reviewer]", type: "ipc" });
    buf.push({ ts: 4, line: "[done] end_turn", type: "turn" });

    const viewport = computeViewport(buf, 0, 10);
    expect(viewport.length).toBe(4);
    expect(viewport[0]?.type).toBe("tool");
    expect(viewport[1]?.type).toBe("output");
    expect(viewport[2]?.type).toBe("ipc");
    expect(viewport[3]?.type).toBe("turn");
  });

  test("historical lines are flagged", () => {
    const buf = new AgentLogBuffer("coder", "sess-1");
    buf.push({ ts: 1, line: "old", type: "output", historical: true });
    buf.push({ ts: 2, line: "new", type: "output" });

    const viewport = computeViewport(buf, 0, 10);
    expect(viewport[0]?.historical).toBe(true);
    expect(viewport[1]?.historical).toBeUndefined();
  });
});

describe("TracePane agent selection", () => {
  test("selecting different agents shows their buffers", () => {
    const bufs = new Map<string, AgentLogBuffer>();
    const coderBuf = new AgentLogBuffer("coder", "sess-1");
    coderBuf.push({ ts: 1, line: "coder output", type: "output" });
    bufs.set("coder", coderBuf);

    const reviewerBuf = new AgentLogBuffer("reviewer", "sess-1");
    reviewerBuf.push({ ts: 2, line: "reviewer output", type: "output" });
    bufs.set("reviewer", reviewerBuf);

    const roles = ["coder", "reviewer"];

    // Select coder (index 0)
    const coderView = computeViewport(bufs.get(roles[0]!), 0, 10);
    expect(coderView[0]?.line).toBe("coder output");

    // Select reviewer (index 1)
    const reviewerView = computeViewport(bufs.get(roles[1]!), 0, 10);
    expect(reviewerView[0]?.line).toBe("reviewer output");
  });

  test("empty role list produces no viewport", () => {
    const viewport = computeViewport(undefined, 0, 10);
    expect(viewport).toEqual([]);
  });
});

describe("TracePane auto-scroll behavior", () => {
  test("scrollOffset=0 means auto-scroll ON (shows newest lines)", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 30; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    const viewport = computeViewport(buf, 0, 10);
    expect(viewport[9]?.line).toBe("line-29"); // newest
  });

  test("scrollOffset>0 means auto-scroll OFF (pinned)", () => {
    const buf = new AgentLogBuffer("coder", "sess-1", 100);
    for (let i = 0; i < 30; i++) {
      buf.push({ ts: i, line: `line-${i}`, type: "output" });
    }
    const viewport = computeViewport(buf, 10, 10);
    expect(viewport[9]?.line).toBe("line-19"); // not newest
  });
});
