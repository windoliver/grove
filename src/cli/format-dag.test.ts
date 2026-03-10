/**
 * Tests for the git-style ASCII DAG renderer.
 */

import { describe, expect, test } from "bun:test";
import { ContributionKind, RelationType, ScoreDirection } from "../core/models.js";
import { makeContribution, makeRelation } from "../core/test-helpers.js";
import type { DagNode } from "./format-dag.js";
import { contributionsToDagNodes, formatDag, renderDag } from "./format-dag.js";

// ---------------------------------------------------------------------------
// renderDag
// ---------------------------------------------------------------------------

describe("renderDag", () => {
  test("renders empty graph", () => {
    expect(renderDag([])).toEqual([]);
  });

  test("renders single node", () => {
    const nodes: DagNode[] = [{ id: "a", label: "node A", parents: [] }];
    const lines = renderDag(nodes);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBeDefined();
    expect(lines[0]?.graphPrefix).toContain("*");
    expect(lines[0]?.label).toBe("node A");
  });

  test("renders linear chain", () => {
    // c -> b -> a (newest first)
    const nodes: DagNode[] = [
      { id: "c", label: "node C", parents: ["b"] },
      { id: "b", label: "node B", parents: ["a"] },
      { id: "a", label: "node A", parents: [] },
    ];
    const lines = renderDag(nodes);

    // All nodes should be in the same column
    const nodeLines = lines.filter((l) => l.label !== "");
    expect(nodeLines.length).toBe(3);
    for (const line of nodeLines) {
      expect(line.graphPrefix).toContain("*");
    }
  });

  test("renders fork (one parent, two children)", () => {
    // b and c both derive from a
    const nodes: DagNode[] = [
      { id: "c", label: "branch 2", parents: ["a"] },
      { id: "b", label: "branch 1", parents: ["a"] },
      { id: "a", label: "root", parents: [] },
    ];
    const lines = renderDag(nodes);
    const nodeLines = lines.filter((l) => l.label !== "");
    expect(nodeLines.length).toBe(3);
  });

  test("renders merge (two parents, one child)", () => {
    // c derives from both a and b
    const nodes: DagNode[] = [
      { id: "c", label: "merged", parents: ["a", "b"] },
      { id: "a", label: "parent A", parents: [] },
      { id: "b", label: "parent B", parents: [] },
    ];
    const lines = renderDag(nodes);
    // Should have merge connector lines
    expect(lines.length).toBeGreaterThan(3);
  });

  test("handles diamond DAG", () => {
    // d -> b, c ; b -> a ; c -> a
    const nodes: DagNode[] = [
      { id: "d", label: "merged", parents: ["b", "c"] },
      { id: "c", label: "branch 2", parents: ["a"] },
      { id: "b", label: "branch 1", parents: ["a"] },
      { id: "a", label: "root", parents: [] },
    ];
    const lines = renderDag(nodes);
    const nodeLines = lines.filter((l) => l.label !== "");
    expect(nodeLines.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// formatDag
// ---------------------------------------------------------------------------

describe("formatDag", () => {
  test("returns empty graph message", () => {
    expect(formatDag([])).toBe("(empty graph)");
  });

  test("formats lines with labels", () => {
    const lines = [
      { graphPrefix: "*", label: "node A" },
      { graphPrefix: "|", label: "" },
      { graphPrefix: "*", label: "node B" },
    ];
    const output = formatDag(lines);
    expect(output).toContain("* node A");
    expect(output).toContain("* node B");
    // Connector line has no trailing label
    const outputLines = output.split("\n");
    expect(outputLines[1]).toBe("|");
  });
});

// ---------------------------------------------------------------------------
// contributionsToDagNodes
// ---------------------------------------------------------------------------

describe("contributionsToDagNodes", () => {
  test("extracts parents from derives_from relations", () => {
    const parent = makeContribution({ summary: "parent" });
    const child = makeContribution({
      summary: "child",
      relations: [makeRelation({ targetCid: parent.cid, relationType: RelationType.DerivesFrom })],
      createdAt: "2026-01-02T00:00:00Z",
    });

    const nodes = contributionsToDagNodes([child, parent]);
    expect(nodes.length).toBe(2);

    const childNode = nodes[0];
    expect(childNode).toBeDefined();
    expect(childNode?.parents).toEqual([parent.cid]);
    expect(childNode?.label).toContain("[work]");
    expect(childNode?.label).toContain("child");
  });

  test("extracts parents from adopts relations", () => {
    const parent = makeContribution({ summary: "adopted" });
    const child = makeContribution({
      summary: "adopter",
      kind: ContributionKind.Adoption,
      relations: [makeRelation({ targetCid: parent.cid, relationType: RelationType.Adopts })],
      createdAt: "2026-01-02T00:00:00Z",
    });

    const nodes = contributionsToDagNodes([child, parent]);
    const childNode = nodes[0];
    expect(childNode).toBeDefined();
    expect(childNode?.parents).toEqual([parent.cid]);
  });

  test("ignores relations to CIDs not in the set", () => {
    const child = makeContribution({
      summary: "orphan",
      relations: [
        makeRelation({
          targetCid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          relationType: RelationType.DerivesFrom,
        }),
      ],
    });

    const nodes = contributionsToDagNodes([child]);
    expect(nodes[0]).toBeDefined();
    expect(nodes[0]?.parents).toEqual([]);
  });

  test("includes scores in label", () => {
    const c = makeContribution({
      summary: "scored",
      scores: { throughput: { value: 42, direction: ScoreDirection.Maximize } },
    });

    const nodes = contributionsToDagNodes([c]);
    expect(nodes[0]).toBeDefined();
    expect(nodes[0]?.label).toContain("throughput=42");
  });
});
