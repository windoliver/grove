/**
 * Unicode box-drawing renderer for agent topology graphs.
 *
 * Renders a GraphLayout into a text buffer using box-drawing characters
 * for node boxes and orthogonal edge routing between layers.
 *
 * Pure functions only — no side effects, no mutation of inputs.
 */

import type { GraphLayout, LayoutNode } from "./graph-layout.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A rendered text buffer. */
export interface RenderBuffer {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_BOX_WIDTH = 18;
const NODE_BOX_HEIGHT = 3;

/** Status indicators for agent states. */
const STATUS_ICONS: Record<string, string> = {
  running: "\u25CF",
  idle: "\u25CB",
  error: "\u2717",
};

// ---------------------------------------------------------------------------
// Internal: mutable grid operations
// ---------------------------------------------------------------------------

/** Create a mutable 2D grid filled with spaces. */
function createGrid(width: number, height: number): string[][] {
  const grid: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      row.push(" ");
    }
    grid.push(row);
  }
  return grid;
}

/** Write a string into the grid starting at (startX, y). */
function writeString(grid: string[][], x: number, y: number, text: string): void {
  const row = grid[y];
  if (!row) return;
  for (let i = 0; i < text.length; i++) {
    const col = x + i;
    if (col >= 0 && col < row.length) {
      const ch = text[i];
      if (ch !== undefined) {
        row[col] = ch;
      }
    }
  }
}

/** Write a single character into the grid at (x, y). */
function writeChar(grid: string[][], x: number, y: number, ch: string): void {
  const row = grid[y];
  if (row && x >= 0 && x < row.length) {
    row[x] = ch;
  }
}

// ---------------------------------------------------------------------------
// Internal: node rendering
// ---------------------------------------------------------------------------

/** Render a node box onto the grid. */
function renderNodeBox(grid: string[][], node: LayoutNode): void {
  const { x, y, label, agents, maxInstances } = node;
  const innerWidth = NODE_BOX_WIDTH - 2;

  // --- Top border: ┌─ label ────┐ ---
  const labelTrunc = label.length > innerWidth - 4 ? label.slice(0, innerWidth - 4) : label;
  const dashesAfterLabel = innerWidth - labelTrunc.length - 2;
  const topBorder = `\u250C\u2500 ${labelTrunc} ${"\u2500".repeat(Math.max(0, dashesAfterLabel))}\u2510`;
  writeString(grid, x, y, topBorder);

  // --- Middle: │ status line │ ---
  const agentCount = agents.length;
  const maxInst = maxInstances ?? "?";
  const primaryStatus = agents.length > 0 ? (agents[0]?.status ?? "idle") : "idle";
  const icon = STATUS_ICONS[primaryStatus] ?? "\u25CB";
  const statusText = `${agentCount}/${String(maxInst)} ${icon} ${primaryStatus}`;
  const statusTrunc = statusText.length > innerWidth ? statusText.slice(0, innerWidth) : statusText;
  const padding = innerWidth - statusTrunc.length;
  const middleLine = `\u2502 ${statusTrunc}${" ".repeat(Math.max(0, padding))} \u2502`;
  writeString(grid, x, y + 1, middleLine);

  // --- Bottom border: └──────────────┘ ---
  const bottomBorder = `\u2514${"\u2500".repeat(innerWidth)}\u2518`;
  writeString(grid, x, y + 2, bottomBorder);
}

// ---------------------------------------------------------------------------
// Internal: edge rendering
// ---------------------------------------------------------------------------

/** Route and draw an edge between two nodes using orthogonal segments. */
function renderEdge(
  grid: string[][],
  fromNode: LayoutNode,
  toNode: LayoutNode,
  edgeType: string,
): void {
  // Source: bottom-center of from node
  const fromCenterX = fromNode.x + Math.floor(NODE_BOX_WIDTH / 2);
  const fromBottomY = fromNode.y + NODE_BOX_HEIGHT;

  // Target: top-center of to node
  const toCenterX = toNode.x + Math.floor(NODE_BOX_WIDTH / 2);
  const toTopY = toNode.y - 1;

  if (fromBottomY > toTopY) {
    // Nodes overlap vertically or are on the same layer — draw horizontal edge
    renderHorizontalEdge(grid, fromNode, toNode, edgeType);
    return;
  }

  if (fromCenterX === toCenterX) {
    // Straight vertical edge
    for (let row = fromBottomY; row <= toTopY; row++) {
      writeChar(grid, fromCenterX, row, "\u2502");
    }
    writeChar(grid, toCenterX, toTopY, "\u25BC");
    // Edge label at midpoint
    const midY = Math.floor((fromBottomY + toTopY) / 2);
    writeEdgeLabel(grid, fromCenterX + 1, midY, edgeType);
  } else {
    // L-shaped routing: go down, then across, then down
    const midY = Math.floor((fromBottomY + toTopY) / 2);

    // Vertical segment from source down to midpoint
    for (let row = fromBottomY; row <= midY; row++) {
      writeChar(grid, fromCenterX, row, "\u2502");
    }

    // Corner at (fromCenterX, midY)
    if (toCenterX > fromCenterX) {
      writeChar(grid, fromCenterX, midY, "\u2514");
    } else {
      writeChar(grid, fromCenterX, midY, "\u2518");
    }

    // Horizontal segment
    const minX = Math.min(fromCenterX, toCenterX);
    const maxX = Math.max(fromCenterX, toCenterX);
    for (let col = minX + 1; col < maxX; col++) {
      writeChar(grid, col, midY, "\u2500");
    }

    // Corner at (toCenterX, midY)
    if (toCenterX > fromCenterX) {
      writeChar(grid, toCenterX, midY, "\u2510");
    } else {
      writeChar(grid, toCenterX, midY, "\u250C");
    }

    // Vertical segment from midpoint down to target
    for (let row = midY + 1; row <= toTopY; row++) {
      writeChar(grid, toCenterX, row, "\u2502");
    }
    writeChar(grid, toCenterX, toTopY, "\u25BC");

    // Edge label near horizontal segment midpoint
    const labelX = Math.floor((minX + maxX) / 2);
    writeEdgeLabel(grid, labelX, midY - 1, edgeType);
  }
}

/** Render a horizontal edge between nodes on the same layer. */
function renderHorizontalEdge(
  grid: string[][],
  fromNode: LayoutNode,
  toNode: LayoutNode,
  edgeType: string,
): void {
  const fromRightX = fromNode.x + NODE_BOX_WIDTH;
  const toLeftX = toNode.x;
  const midY = fromNode.y + 1;

  if (fromRightX < toLeftX) {
    // Left to right
    for (let col = fromRightX; col < toLeftX; col++) {
      writeChar(grid, col, midY, "\u2500");
    }
    writeChar(grid, toLeftX - 1, midY, "\u25B6");
    const labelX = Math.floor((fromRightX + toLeftX) / 2);
    writeEdgeLabel(grid, labelX - Math.floor(edgeType.length / 2), midY - 1, edgeType);
  } else {
    // Right to left
    const rightX = fromNode.x;
    const leftEnd = toNode.x + NODE_BOX_WIDTH;
    for (let col = leftEnd; col < rightX; col++) {
      writeChar(grid, col, midY, "\u2500");
    }
    writeChar(grid, leftEnd, midY, "\u25C0");
    const labelX = Math.floor((leftEnd + rightX) / 2);
    writeEdgeLabel(grid, labelX - Math.floor(edgeType.length / 2), midY - 1, edgeType);
  }
}

/** Write an edge type label at the given position. */
function writeEdgeLabel(grid: string[][], x: number, y: number, label: string): void {
  if (y >= 0 && y < grid.length) {
    writeString(grid, Math.max(0, x), y, label);
  }
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render a graph layout as a text buffer using Unicode box-drawing characters.
 *
 * @param layout - The computed graph layout
 * @returns A rendered text buffer with lines, width, and height
 */
export function renderGraph(layout: GraphLayout): RenderBuffer {
  if (layout.nodes.length === 0) {
    return { lines: [], width: 0, height: 0 };
  }

  // Compute required grid dimensions with padding
  const gridWidth = Math.max(layout.width + 4, 1);
  const gridHeight = Math.max(layout.height + 4, 1);
  const grid = createGrid(gridWidth, gridHeight);

  // Build node lookup
  const nodeMap = new Map<string, LayoutNode>();
  for (const node of layout.nodes) {
    nodeMap.set(node.id, node);
  }

  // Draw edges first (nodes will overwrite any overlapping characters)
  for (const edge of layout.edges) {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (fromNode && toNode) {
      renderEdge(grid, fromNode, toNode, edge.edgeType);
    }
  }

  // Draw nodes on top
  for (const node of layout.nodes) {
    renderNodeBox(grid, node);
  }

  // Convert grid to lines, trimming trailing spaces
  const lines = grid.map((row) => row.join("").replace(/\s+$/, ""));

  // Trim trailing empty lines
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && lines[lastNonEmpty] === "") {
    lastNonEmpty--;
  }
  const trimmedLines = lines.slice(0, lastNonEmpty + 1);

  return {
    lines: trimmedLines,
    width: gridWidth,
    height: trimmedLines.length,
  };
}
