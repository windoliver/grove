/**
 * Unit tests for edge-type-aware workspace strategy resolution.
 *
 * Verifies that resolveRoleWorkspaceStrategies() and topologicalSortRoles()
 * correctly derive base branches and ordering from topology edge types.
 */

import { describe, expect, test } from "bun:test";
import type { AgentTopology } from "./topology.js";
import { resolveRoleWorkspaceStrategies, topologicalSortRoles } from "./topology.js";

// ---------------------------------------------------------------------------
// resolveRoleWorkspaceStrategies
// ---------------------------------------------------------------------------

describe("resolveRoleWorkspaceStrategies", () => {
  test("flat topology: all roles use HEAD", () => {
    const topology: AgentTopology = {
      structure: "flat",
      roles: [
        { name: "coder", description: "writes code" },
        { name: "tester", description: "tests code" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("tester")).toBe("HEAD");
  });

  test("delegates edge: target branches off source", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("reviewer")).toBe("grove/sess-abc/coder");
  });

  test("feeds edge: target branches off source", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "researcher", edges: [{ target: "writer", edgeType: "feeds" }] },
        { name: "writer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-xyz");
    expect(strategies.get("researcher")).toBe("HEAD");
    expect(strategies.get("writer")).toBe("grove/sess-xyz/researcher");
  });

  test("escalates edge: target branches off source", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "worker", edges: [{ target: "supervisor", edgeType: "escalates" }] },
        { name: "supervisor" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-123");
    expect(strategies.get("worker")).toBe("HEAD");
    expect(strategies.get("supervisor")).toBe("grove/sess-123/worker");
  });

  test("feedback edge: independent workspaces (HEAD)", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "feedback" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("reviewer")).toBe("HEAD");
  });

  test("reports edge: independent workspaces (HEAD)", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "agent", edges: [{ target: "monitor", edgeType: "reports" }] },
        { name: "monitor" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("agent")).toBe("HEAD");
    expect(strategies.get("monitor")).toBe("HEAD");
  });

  test("requests edge: independent workspaces (HEAD)", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "orchestrator", edges: [{ target: "worker", edgeType: "requests" }] },
        { name: "worker" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("orchestrator")).toBe("HEAD");
    expect(strategies.get("worker")).toBe("HEAD");
  });

  test("mixed edges: only WORKSPACE_BRANCH_EDGES create branch dependency", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        {
          name: "coder",
          edges: [
            { target: "reviewer", edgeType: "delegates" }, // workspace branch
            { target: "monitor", edgeType: "reports" },    // independent
          ],
        },
        { name: "reviewer" },
        { name: "monitor" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-mix");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("reviewer")).toBe("grove/sess-mix/coder");
    expect(strategies.get("monitor")).toBe("HEAD");
  });
});

// ---------------------------------------------------------------------------
// topologicalSortRoles
// ---------------------------------------------------------------------------

describe("topologicalSortRoles", () => {
  test("flat topology: original order preserved", () => {
    const topology: AgentTopology = {
      structure: "flat",
      roles: [
        { name: "alpha" },
        { name: "beta" },
        { name: "gamma" },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    expect(sorted.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("delegates edge: source before target", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "reviewer" }, // listed first
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    const coderIdx = sorted.findIndex((r) => r.name === "coder");
    const reviewerIdx = sorted.findIndex((r) => r.name === "reviewer");
    expect(coderIdx).toBeLessThan(reviewerIdx);
  });

  test("feeds edge: source before target", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "writer" }, // listed first
        { name: "researcher", edges: [{ target: "writer", edgeType: "feeds" }] },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    const resIdx = sorted.findIndex((r) => r.name === "researcher");
    const writerIdx = sorted.findIndex((r) => r.name === "writer");
    expect(resIdx).toBeLessThan(writerIdx);
  });

  test("feedback edge: no ordering constraint", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "reviewer", edges: [{ target: "coder", edgeType: "feedback" }] },
        { name: "coder" },
      ],
    };
    // feedback does not create workspace ordering — both roles are roots
    const sorted = topologicalSortRoles(topology);
    expect(sorted).toHaveLength(2);
  });

  test("chain: A→B→C sorted A,B,C", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "C" }, // listed last
        { name: "B", edges: [{ target: "C", edgeType: "delegates" }] },
        { name: "A", edges: [{ target: "B", edgeType: "feeds" }] },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    const names = sorted.map((r) => r.name);
    expect(names.indexOf("A")).toBeLessThan(names.indexOf("B"));
    expect(names.indexOf("B")).toBeLessThan(names.indexOf("C"));
  });
});
