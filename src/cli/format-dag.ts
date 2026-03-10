/**
 * Git-style ASCII DAG column renderer.
 *
 * Renders a contribution DAG as a git-log-style graph where each node
 * occupies a column (lane). Merge/fork points are shown with column
 * connectors. Nodes must be provided in topological order (newest first).
 */

import type { Contribution } from "../core/models.js";
import { truncateCid } from "./format.js";

/** A node in the DAG with its parent CIDs. */
export interface DagNode {
  readonly id: string;
  readonly label: string;
  readonly parents: readonly string[];
}

/** A rendered line of the DAG graph. */
export interface GraphLine {
  readonly graphPrefix: string;
  readonly label: string;
}

/**
 * Convert contributions to DagNodes.
 * Parents are extracted from relations (derives_from, adopts).
 */
export function contributionsToDagNodes(
  contributions: readonly Contribution[],
): readonly DagNode[] {
  const cidSet = new Set(contributions.map((c) => c.cid));

  return contributions.map((c) => {
    const parents = c.relations
      .filter(
        (r) =>
          (r.relationType === "derives_from" || r.relationType === "adopts") &&
          cidSet.has(r.targetCid),
      )
      .map((r) => r.targetCid);

    const scores = c.scores
      ? Object.entries(c.scores)
          .map(([k, v]) => `${k}=${v.value}`)
          .join(", ")
      : "";
    const scoreStr = scores ? ` (${scores})` : "";

    return {
      id: c.cid,
      label: `${truncateCid(c.cid)} [${c.kind}] ${c.summary}${scoreStr}`,
      parents,
    };
  });
}

/**
 * Render a DAG as git-style ASCII graph lines.
 *
 * Uses a column-based lane tracking algorithm:
 * - Each active branch occupies a column
 * - When a node is rendered, its column shows "*"
 * - Other active columns show "|"
 * - Fork/merge points use "/" connectors
 *
 * @param nodes - Nodes in topological order (newest first).
 */
export function renderDag(nodes: readonly DagNode[]): readonly GraphLine[] {
  if (nodes.length === 0) return [];

  // columns[i] = node ID currently being tracked in lane i, or "" for empty
  const columns: string[] = [];
  const lines: GraphLine[] = [];

  for (const node of nodes) {
    // Find which column this node occupies (if already being tracked)
    let col = columns.indexOf(node.id);
    if (col === -1) {
      // New head — assign to first empty slot or append
      col = columns.indexOf("");
      if (col === -1) {
        col = columns.length;
        columns.push(node.id);
      } else {
        columns[col] = node.id;
      }
    }

    // Build the graph prefix: "|" for other columns, "*" for this node
    const graphChars = columns.map((_, i) => (i === col ? "*" : columns[i] ? "|" : " "));
    lines.push({
      graphPrefix: graphChars.join(" "),
      label: node.label,
    });

    const [firstParent, ...extraParents] = node.parents;

    // Continue tracking first parent in this column
    if (firstParent !== undefined) {
      columns[col] = firstParent;
    } else {
      columns[col] = ""; // dead end — free the lane
    }

    // Handle additional parents (merge lines)
    for (const parent of extraParents) {
      const existingCol = columns.indexOf(parent);
      if (existingCol !== -1) {
        // Parent already tracked — draw a merge connector
        const mergeChars = columns.map((c, i) => {
          if (i === col) return "|";
          if (i === existingCol) return "/";
          if (c) return "|";
          return " ";
        });
        lines.push({ graphPrefix: mergeChars.join(" "), label: "" });
      } else {
        // Need a new lane for this parent
        const freeCol = columns.indexOf("");
        const newCol = freeCol === -1 ? columns.length : freeCol;
        if (freeCol === -1) {
          columns.push(parent);
        } else {
          columns[freeCol] = parent;
        }
        const mergeChars = columns.map((c, i) => {
          if (i === col) return "|";
          if (i === newCol) return "/";
          if (c) return "|";
          return " ";
        });
        lines.push({ graphPrefix: mergeChars.join(" "), label: "" });
      }
    }

    // Trim trailing empty columns
    while (columns.length > 0 && columns[columns.length - 1] === "") {
      columns.pop();
    }
  }

  return lines;
}

/** Format graph lines into a single string. */
export function formatDag(lines: readonly GraphLine[]): string {
  if (lines.length === 0) return "(empty graph)";
  return lines.map((l) => (l.label ? `${l.graphPrefix} ${l.label}` : l.graphPrefix)).join("\n");
}
