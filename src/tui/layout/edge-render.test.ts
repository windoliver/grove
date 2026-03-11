/**
 * Tests for Unicode edge renderer.
 */

import { describe, expect, test } from "bun:test";
import { renderGraph } from "./edge-render.js";
import type { GraphLayout } from "./graph-layout.js";
import { layoutGraph } from "./graph-layout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function role(
  name: string,
  edges?: readonly { readonly target: string; readonly edgeType: string }[],
  maxInstances?: number,
): {
  readonly name: string;
  readonly maxInstances?: number | undefined;
  readonly edges?: readonly { readonly target: string; readonly edgeType: string }[] | undefined;
} {
  return {
    name,
    ...(edges !== undefined && { edges }),
    ...(maxInstances !== undefined && { maxInstances }),
  };
}

function allText(lines: readonly string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Empty layout
// ---------------------------------------------------------------------------

describe("renderGraph — empty layout", () => {
  test("returns empty buffer for empty layout", () => {
    const emptyLayout: GraphLayout = {
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      layers: 0,
    };
    const result = renderGraph(emptyLayout);
    expect(result.lines).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single node
// ---------------------------------------------------------------------------

describe("renderGraph — single node", () => {
  test("renders a box for a single node", () => {
    const layout = layoutGraph([role("lead", undefined, 1)], "flat");
    const result = renderGraph(layout);

    expect(result.lines.length).toBeGreaterThanOrEqual(3);
    const text = allText(result.lines);

    // Node box uses box-drawing characters
    expect(text).toContain("\u250C"); // ┌
    expect(text).toContain("\u2510"); // ┐
    expect(text).toContain("\u2514"); // └
    expect(text).toContain("\u2518"); // ┘
  });

  test("node box contains role name", () => {
    const layout = layoutGraph([role("worker")], "flat");
    const result = renderGraph(layout);
    const text = allText(result.lines);

    expect(text).toContain("worker");
  });

  test("node box contains status indicator", () => {
    const liveAgents = new Map([["lead", [{ agentId: "a1", status: "running" as const }]]]);
    const layout = layoutGraph([role("lead", undefined, 1)], "flat", liveAgents);
    const result = renderGraph(layout);
    const text = allText(result.lines);

    // Should contain the running indicator
    expect(text).toContain("\u25CF"); // ●
    expect(text).toContain("running");
  });

  test("idle agent shows idle indicator", () => {
    const liveAgents = new Map([["lead", [{ agentId: "a1", status: "idle" as const }]]]);
    const layout = layoutGraph([role("lead", undefined, 1)], "flat", liveAgents);
    const result = renderGraph(layout);
    const text = allText(result.lines);

    expect(text).toContain("\u25CB"); // ○
  });

  test("error agent shows error indicator", () => {
    const liveAgents = new Map([["lead", [{ agentId: "a1", status: "error" as const }]]]);
    const layout = layoutGraph([role("lead", undefined, 1)], "flat", liveAgents);
    const result = renderGraph(layout);
    const text = allText(result.lines);

    expect(text).toContain("\u2717"); // ✗
  });
});

// ---------------------------------------------------------------------------
// Two connected nodes
// ---------------------------------------------------------------------------

describe("renderGraph — connected nodes", () => {
  test("renders edge between two connected nodes", () => {
    const roles = [
      role("lead", [{ target: "worker", edgeType: "delegates" }], 1),
      role("worker", undefined, 3),
    ];
    const layout = layoutGraph(roles, "graph");
    const result = renderGraph(layout);

    expect(result.lines.length).toBeGreaterThan(3);
    const text = allText(result.lines);

    // Should contain both role names
    expect(text).toContain("lead");
    expect(text).toContain("worker");
  });

  test("arrow direction matches edge direction (downward)", () => {
    const roles = [role("a", [{ target: "b", edgeType: "delegates" }]), role("b")];
    const layout = layoutGraph(roles, "graph");
    const result = renderGraph(layout);
    const text = allText(result.lines);

    // Down arrow for vertical edges
    expect(text).toContain("\u25BC"); // ▼
  });

  test("edge type label appears in output", () => {
    const roles = [role("a", [{ target: "b", edgeType: "delegates" }]), role("b")];
    const layout = layoutGraph(roles, "graph");
    const result = renderGraph(layout);
    const text = allText(result.lines);

    expect(text).toContain("delegates");
  });
});

// ---------------------------------------------------------------------------
// Buffer dimensions
// ---------------------------------------------------------------------------

describe("renderGraph — buffer dimensions", () => {
  test("render buffer dimensions are positive for non-empty layout", () => {
    const layout = layoutGraph([role("x")], "flat");
    const result = renderGraph(layout);

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test("multiple nodes produce wider output", () => {
    const singleLayout = layoutGraph([role("a")], "flat");
    const multiLayout = layoutGraph([role("a"), role("b"), role("c")], "flat");

    const singleResult = renderGraph(singleLayout);
    const multiResult = renderGraph(multiLayout);

    expect(multiResult.width).toBeGreaterThanOrEqual(singleResult.width);
  });
});

// ---------------------------------------------------------------------------
// Diamond topology rendering
// ---------------------------------------------------------------------------

describe("renderGraph — diamond topology", () => {
  test("renders all four nodes and edges", () => {
    const roles = [
      role("a", [
        { target: "b", edgeType: "delegates" },
        { target: "c", edgeType: "delegates" },
      ]),
      role("b", [{ target: "d", edgeType: "reports" }]),
      role("c", [{ target: "d", edgeType: "reports" }]),
      role("d"),
    ];
    const layout = layoutGraph(roles, "graph");
    const result = renderGraph(layout);
    const text = allText(result.lines);

    for (const name of ["a", "b", "c", "d"]) {
      expect(text).toContain(name);
    }
  });
});
