/**
 * Tests for graph layout algorithm.
 */

import { describe, expect, test } from "bun:test";
import type { LiveAgentStatus } from "./graph-layout.js";
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

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe("layoutGraph — empty input", () => {
  test("returns empty layout for empty roles array", () => {
    const result = layoutGraph([], "graph");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.layers).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single node
// ---------------------------------------------------------------------------

describe("layoutGraph — single node", () => {
  test("places single node at layer 0, order 0", () => {
    const result = layoutGraph([role("lead")], "graph");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node).toBeDefined();
    expect(node?.id).toBe("lead");
    expect(node?.layer).toBe(0);
    expect(node?.order).toBe(0);
    expect(node?.x).toBe(0);
    expect(node?.y).toBe(0);
  });

  test("single node has 1 layer", () => {
    const result = layoutGraph([role("lead")], "graph");
    expect(result.layers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flat structure
// ---------------------------------------------------------------------------

describe("layoutGraph — flat structure", () => {
  test("all nodes placed at layer 0", () => {
    const roles = [role("alpha"), role("beta"), role("gamma")];
    const result = layoutGraph(roles, "flat");

    for (const node of result.nodes) {
      expect(node.layer).toBe(0);
    }
    expect(result.layers).toBe(1);
  });

  test("nodes are ordered horizontally", () => {
    const roles = [role("beta"), role("alpha"), role("gamma")];
    const result = layoutGraph(roles, "flat");

    // Alphabetically sorted within layer 0
    const names = result.nodes.map((n) => n.id);
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("x positions increase with order", () => {
    const roles = [role("a"), role("b"), role("c")];
    const result = layoutGraph(roles, "flat");

    for (let i = 1; i < result.nodes.length; i++) {
      const prevX = result.nodes[i - 1]?.x ?? 0;
      expect(result.nodes[i]?.x).toBeGreaterThan(prevX);
    }
  });
});

// ---------------------------------------------------------------------------
// Linear chain (A → B → C)
// ---------------------------------------------------------------------------

describe("layoutGraph — linear chain", () => {
  test("assigns 3 layers for A → B → C", () => {
    const roles = [
      role("a", [{ target: "b", edgeType: "delegates" }]),
      role("b", [{ target: "c", edgeType: "delegates" }]),
      role("c"),
    ];
    const result = layoutGraph(roles, "graph");

    expect(result.layers).toBe(3);

    const nodeA = result.nodes.find((n) => n.id === "a");
    const nodeB = result.nodes.find((n) => n.id === "b");
    const nodeC = result.nodes.find((n) => n.id === "c");

    expect(nodeA?.layer).toBe(0);
    expect(nodeB?.layer).toBe(1);
    expect(nodeC?.layer).toBe(2);
  });

  test("edges are collected correctly", () => {
    const roles = [
      role("a", [{ target: "b", edgeType: "delegates" }]),
      role("b", [{ target: "c", edgeType: "reports" }]),
      role("c"),
    ];
    const result = layoutGraph(roles, "graph");

    expect(result.edges).toHaveLength(2);
    expect(result.edges).toEqual([
      { from: "a", to: "b", edgeType: "delegates" },
      { from: "b", to: "c", edgeType: "reports" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Diamond pattern (A → B, A → C, B → D, C → D)
// ---------------------------------------------------------------------------

describe("layoutGraph — diamond pattern", () => {
  test("assigns correct layers for diamond", () => {
    const roles = [
      role("a", [
        { target: "b", edgeType: "delegates" },
        { target: "c", edgeType: "delegates" },
      ]),
      role("b", [{ target: "d", edgeType: "reports" }]),
      role("c", [{ target: "d", edgeType: "reports" }]),
      role("d"),
    ];
    const result = layoutGraph(roles, "graph");

    const layerOf = (id: string): number | undefined =>
      result.nodes.find((n) => n.id === id)?.layer;

    expect(layerOf("a")).toBe(0);
    expect(layerOf("b")).toBe(1);
    expect(layerOf("c")).toBe(1);
    expect(layerOf("d")).toBe(2);
  });

  test("diamond has 4 edges", () => {
    const roles = [
      role("a", [
        { target: "b", edgeType: "delegates" },
        { target: "c", edgeType: "delegates" },
      ]),
      role("b", [{ target: "d", edgeType: "reports" }]),
      role("c", [{ target: "d", edgeType: "reports" }]),
      role("d"),
    ];
    const result = layoutGraph(roles, "graph");
    expect(result.edges).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Tree with multiple children
// ---------------------------------------------------------------------------

describe("layoutGraph — tree with children", () => {
  test("root at layer 0, children at layer 1", () => {
    const roles = [
      role("root", [
        { target: "child-a", edgeType: "delegates" },
        { target: "child-b", edgeType: "delegates" },
        { target: "child-c", edgeType: "delegates" },
      ]),
      role("child-a"),
      role("child-b"),
      role("child-c"),
    ];
    const result = layoutGraph(roles, "tree");

    const rootNode = result.nodes.find((n) => n.id === "root");
    expect(rootNode?.layer).toBe(0);

    for (const name of ["child-a", "child-b", "child-c"]) {
      const child = result.nodes.find((n) => n.id === name);
      expect(child?.layer).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Graph with cycle
// ---------------------------------------------------------------------------

describe("layoutGraph — cycle handling", () => {
  test("handles A → B → C → A without infinite loop", () => {
    const roles = [
      role("a", [{ target: "b", edgeType: "delegates" }]),
      role("b", [{ target: "c", edgeType: "delegates" }]),
      role("c", [{ target: "a", edgeType: "feedback" }]),
    ];

    // Should not throw or hang
    const result = layoutGraph(roles, "graph");
    expect(result.nodes).toHaveLength(3);
    expect(result.layers).toBeGreaterThanOrEqual(1);
  });

  test("all cycle nodes are assigned layers", () => {
    const roles = [
      role("x", [{ target: "y", edgeType: "delegates" }]),
      role("y", [{ target: "x", edgeType: "feedback" }]),
    ];
    const result = layoutGraph(roles, "graph");

    for (const node of result.nodes) {
      expect(node.layer).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Live agents
// ---------------------------------------------------------------------------

describe("layoutGraph — live agents", () => {
  test("populates agents on correct nodes", () => {
    const roles = [role("lead", undefined, 1), role("worker", undefined, 3)];
    const liveAgents = new Map<string, readonly LiveAgentStatus[]>([
      ["lead", [{ agentId: "claude-1", status: "running", target: "src/auth" }]],
      [
        "worker",
        [
          { agentId: "claude-2", status: "running" },
          { agentId: "claude-3", status: "idle" },
        ],
      ],
    ]);

    const result = layoutGraph(roles, "flat", liveAgents);

    const leadNode = result.nodes.find((n) => n.id === "lead");
    expect(leadNode?.agents).toHaveLength(1);
    expect(leadNode?.agents[0]?.agentId).toBe("claude-1");
    expect(leadNode?.maxInstances).toBe(1);

    const workerNode = result.nodes.find((n) => n.id === "worker");
    expect(workerNode?.agents).toHaveLength(2);
    expect(workerNode?.maxInstances).toBe(3);
  });

  test("nodes without live agents have empty agents array", () => {
    const roles = [role("orphan")];
    const result = layoutGraph(roles, "flat");
    expect(result.nodes[0]?.agents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe("layoutGraph — dimensions", () => {
  test("width and height are positive for non-empty layout", () => {
    const result = layoutGraph([role("a")], "graph");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test("width accounts for multiple nodes in same layer", () => {
    const roles = [role("a"), role("b"), role("c")];
    const singleResult = layoutGraph([role("a")], "flat");
    const multiResult = layoutGraph(roles, "flat");
    expect(multiResult.width).toBeGreaterThan(singleResult.width);
  });

  test("height accounts for multiple layers", () => {
    const singleLayer = layoutGraph([role("a")], "flat");
    const multiLayer = layoutGraph(
      [role("a", [{ target: "b", edgeType: "delegates" }]), role("b")],
      "graph",
    );
    expect(multiLayer.height).toBeGreaterThan(singleLayer.height);
  });
});
