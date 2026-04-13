/**
 * Unit tests for workspace strategy resolution via explicit edge.workspace field.
 *
 * Verifies that resolveRoleWorkspaceStrategies() and topologicalSortRoles()
 * only create branch dependencies when `workspace: "branch_from_source"` is set.
 * Edge type alone does NOT determine workspace behavior.
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

  test("edge without workspace field: both use HEAD (default independent)", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("reviewer")).toBe("HEAD");
  });

  test("workspace: branch_from_source: target branches off source", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates", workspace: "branch_from_source" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("coder")).toBe("HEAD");
    expect(strategies.get("reviewer")).toBe("grove/sess-abc/coder");
  });

  test("workspace: independent: explicit independent even on delegates edge", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates", workspace: "independent" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-abc");
    expect(strategies.get("reviewer")).toBe("HEAD");
  });

  test("branch_from_source works on any edge type", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "coder", edges: [{ target: "reviewer", edgeType: "feedback", workspace: "branch_from_source" }] },
        { name: "reviewer" },
      ],
    };
    const strategies = resolveRoleWorkspaceStrategies(topology, "sess-fb");
    expect(strategies.get("reviewer")).toBe("grove/sess-fb/coder");
  });

  test("mixed edges: only branch_from_source creates dependency", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        {
          name: "coder",
          edges: [
            { target: "reviewer", edgeType: "delegates", workspace: "branch_from_source" },
            { target: "monitor", edgeType: "reports" }, // no workspace field → independent
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

  test("edge without workspace: no ordering constraint", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "reviewer" },
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates" }] },
      ],
    };
    // No workspace field → no ordering → original order preserved
    const sorted = topologicalSortRoles(topology);
    expect(sorted.map((r) => r.name)).toEqual(["reviewer", "coder"]);
  });

  test("branch_from_source: source before target", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "reviewer" }, // listed first
        { name: "coder", edges: [{ target: "reviewer", edgeType: "delegates", workspace: "branch_from_source" }] },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    const coderIdx = sorted.findIndex((r) => r.name === "coder");
    const reviewerIdx = sorted.findIndex((r) => r.name === "reviewer");
    expect(coderIdx).toBeLessThan(reviewerIdx);
  });

  test("chain with branch_from_source: A→B→C sorted A,B,C", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "C" },
        { name: "B", edges: [{ target: "C", edgeType: "delegates", workspace: "branch_from_source" }] },
        { name: "A", edges: [{ target: "B", edgeType: "feeds", workspace: "branch_from_source" }] },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    const names = sorted.map((r) => r.name);
    expect(names.indexOf("A")).toBeLessThan(names.indexOf("B"));
    expect(names.indexOf("B")).toBeLessThan(names.indexOf("C"));
  });

  test("independent workspace: no ordering even with delegates edge", () => {
    const topology: AgentTopology = {
      structure: "graph",
      roles: [
        { name: "reviewer", edges: [{ target: "coder", edgeType: "feedback", workspace: "independent" }] },
        { name: "coder" },
      ],
    };
    const sorted = topologicalSortRoles(topology);
    expect(sorted).toHaveLength(2);
    // Original order preserved — no dependency
    expect(sorted.map((r) => r.name)).toEqual(["reviewer", "coder"]);
  });
});
