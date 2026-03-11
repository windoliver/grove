/**
 * Graph layout algorithm for agent topology visualization.
 *
 * Computes node positions for a directed graph using a simplified Sugiyama
 * algorithm: layer assignment via longest-path layering (Kahn's algorithm),
 * barycentric ordering for crossing minimization, and fixed-spacing positioning.
 *
 * Pure functions only — no side effects, no mutation of inputs.
 */

// ---------------------------------------------------------------------------
// Local topology interface (avoids circular dependency with core/contract.ts)
// ---------------------------------------------------------------------------

/** Minimal role definition consumed by the layout engine. */
interface TopologyRole {
  readonly name: string;
  readonly maxInstances?: number | undefined;
  readonly edges?: readonly { readonly target: string; readonly edgeType: string }[] | undefined;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of a live agent instance filling a role. */
export interface LiveAgentStatus {
  readonly agentId: string;
  readonly status: "running" | "idle" | "error";
  readonly target?: string | undefined;
}

/** A positioned node in the graph layout. */
export interface LayoutNode {
  readonly id: string;
  readonly label: string;
  readonly layer: number;
  readonly order: number;
  readonly x: number;
  readonly y: number;
  readonly agents: readonly LiveAgentStatus[];
  readonly maxInstances?: number | undefined;
}

/** A positioned edge in the graph layout. */
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly edgeType: string;
}

/** Complete graph layout result. */
export interface GraphLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
  readonly layers: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 20;
const HORIZONTAL_SPACING = 4;
const VERTICAL_SPACING = 3;
const NODE_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build adjacency list from roles. */
function buildAdjacency(
  roles: readonly TopologyRole[],
): ReadonlyMap<string, readonly { readonly target: string; readonly edgeType: string }[]> {
  const adj = new Map<string, { readonly target: string; readonly edgeType: string }[]>();
  for (const role of roles) {
    adj.set(role.name, role.edges ? [...role.edges] : []);
  }
  return adj;
}

/** Compute in-degree for each node. */
function computeInDegree(
  roleNames: readonly string[],
  adj: ReadonlyMap<string, readonly { readonly target: string; readonly edgeType: string }[]>,
): Map<string, number> {
  const inDeg = new Map<string, number>();
  for (const name of roleNames) {
    inDeg.set(name, 0);
  }
  for (const edges of adj.values()) {
    for (const edge of edges) {
      const current = inDeg.get(edge.target);
      if (current !== undefined) {
        inDeg.set(edge.target, current + 1);
      }
    }
  }
  return inDeg;
}

/**
 * Assign layers using longest-path layering with Kahn's algorithm.
 * Handles cycles by detecting back-edges and assigning them to the
 * same layer as their source.
 */
function assignLayers(
  roleNames: readonly string[],
  adj: ReadonlyMap<string, readonly { readonly target: string; readonly edgeType: string }[]>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const inDeg = computeInDegree(roleNames, adj);

  // Kahn's algorithm for topological ordering with longest-path layering
  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) {
      queue.push(name);
      layers.set(name, 0);
    }
  }

  // Working copy of in-degrees for processing
  const workingInDeg = new Map(inDeg);

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    processed++;
    const currentLayer = layers.get(current) ?? 0;
    const edges = adj.get(current) ?? [];

    for (const edge of edges) {
      const deg = workingInDeg.get(edge.target);
      if (deg === undefined) continue;

      // Longest-path: target layer is at least current + 1
      const existingLayer = layers.get(edge.target) ?? 0;
      layers.set(edge.target, Math.max(existingLayer, currentLayer + 1));

      const newDeg = deg - 1;
      workingInDeg.set(edge.target, newDeg);
      if (newDeg === 0) {
        queue.push(edge.target);
      }
    }
  }

  // Handle cycle: any unprocessed nodes get assigned to layer 0
  if (processed < roleNames.length) {
    for (const name of roleNames) {
      if (!layers.has(name)) {
        layers.set(name, 0);
      }
    }
  }

  return layers;
}

/**
 * Order nodes within each layer using the barycentric method.
 * Single pass: for each layer > 0, sort nodes by the average position
 * of their predecessors in the previous layer.
 */
function orderWithinLayers(
  roleNames: readonly string[],
  layerAssignment: ReadonlyMap<string, number>,
  adj: ReadonlyMap<string, readonly { readonly target: string; readonly edgeType: string }[]>,
  layerCount: number,
): ReadonlyMap<number, readonly string[]> {
  // Group nodes by layer
  const layerNodes = new Map<number, string[]>();
  for (let i = 0; i < layerCount; i++) {
    layerNodes.set(i, []);
  }
  for (const name of roleNames) {
    const layer = layerAssignment.get(name) ?? 0;
    const nodes = layerNodes.get(layer);
    if (nodes) {
      nodes.push(name);
    }
  }

  // Build reverse adjacency (predecessors)
  const predecessors = new Map<string, string[]>();
  for (const name of roleNames) {
    predecessors.set(name, []);
  }
  for (const [source, edges] of adj) {
    for (const edge of edges) {
      const preds = predecessors.get(edge.target);
      if (preds) {
        preds.push(source);
      }
    }
  }

  // Assign initial order within layer 0 (alphabetical)
  const nodeOrder = new Map<string, number>();
  const layer0 = layerNodes.get(0);
  if (layer0) {
    const sorted = [...layer0].sort();
    for (let i = 0; i < sorted.length; i++) {
      const name = sorted[i];
      if (name !== undefined) {
        nodeOrder.set(name, i);
      }
    }
    layerNodes.set(0, sorted);
  }

  // Barycentric ordering for subsequent layers
  for (let layer = 1; layer < layerCount; layer++) {
    const nodes = layerNodes.get(layer);
    if (!nodes) continue;

    const barycenters = new Map<string, number>();
    for (const name of nodes) {
      const preds = predecessors.get(name) ?? [];
      const predInPrevLayer = preds.filter((p) => (layerAssignment.get(p) ?? 0) < layer);
      if (predInPrevLayer.length > 0) {
        const sum = predInPrevLayer.reduce((acc, p) => acc + (nodeOrder.get(p) ?? 0), 0);
        barycenters.set(name, sum / predInPrevLayer.length);
      } else {
        barycenters.set(name, 0);
      }
    }

    const sorted = [...nodes].sort((a, b) => (barycenters.get(a) ?? 0) - (barycenters.get(b) ?? 0));
    layerNodes.set(layer, sorted);
    for (let i = 0; i < sorted.length; i++) {
      const name = sorted[i];
      if (name !== undefined) {
        nodeOrder.set(name, i);
      }
    }
  }

  return layerNodes;
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

/**
 * Compute a graph layout for the given agent roles.
 *
 * @param roles - Agent role definitions from the topology
 * @param structure - Layout structure: "graph", "tree", or "flat"
 * @param liveAgents - Optional map of role name to live agent statuses
 * @returns Complete graph layout with positioned nodes and edges
 */
export function layoutGraph(
  roles: readonly TopologyRole[],
  structure: "graph" | "tree" | "flat",
  liveAgents?: ReadonlyMap<string, readonly LiveAgentStatus[]>,
): GraphLayout {
  if (roles.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, layers: 0 };
  }

  const roleNames = roles.map((r) => r.name);
  const adj = buildAdjacency(roles);

  // --- Layer assignment ---
  let layerAssignment: Map<string, number>;

  if (structure === "flat") {
    layerAssignment = new Map<string, number>();
    for (const name of roleNames) {
      layerAssignment.set(name, 0);
    }
  } else {
    layerAssignment = assignLayers(roleNames, adj);
  }

  // Determine layer count
  let maxLayer = 0;
  for (const layer of layerAssignment.values()) {
    maxLayer = Math.max(maxLayer, layer);
  }
  const layerCount = maxLayer + 1;

  // --- Ordering within layers ---
  const orderedLayers = orderWithinLayers(roleNames, layerAssignment, adj, layerCount);

  // --- Position computation ---
  const nodes: LayoutNode[] = [];
  const roleMap = new Map<string, TopologyRole>();
  for (const role of roles) {
    roleMap.set(role.name, role);
  }

  for (let layer = 0; layer < layerCount; layer++) {
    const layerRoles = orderedLayers.get(layer) ?? [];
    for (let order = 0; order < layerRoles.length; order++) {
      const name = layerRoles[order];
      if (name === undefined) continue;
      const role = roleMap.get(name);
      const agents = liveAgents?.get(name) ?? [];

      nodes.push({
        id: name,
        label: name,
        layer,
        order,
        x: order * (NODE_WIDTH + HORIZONTAL_SPACING),
        y: layer * (NODE_HEIGHT + VERTICAL_SPACING),
        agents,
        maxInstances: role?.maxInstances,
      });
    }
  }

  // --- Collect edges ---
  const edges: LayoutEdge[] = [];
  for (const role of roles) {
    if (role.edges) {
      for (const edge of role.edges) {
        edges.push({
          from: role.name,
          to: edge.target,
          edgeType: edge.edgeType,
        });
      }
    }
  }

  // --- Compute overall dimensions ---
  let maxNodesInLayer = 0;
  for (let layer = 0; layer < layerCount; layer++) {
    const count = (orderedLayers.get(layer) ?? []).length;
    maxNodesInLayer = Math.max(maxNodesInLayer, count);
  }

  const width =
    maxNodesInLayer > 0
      ? maxNodesInLayer * NODE_WIDTH + (maxNodesInLayer - 1) * HORIZONTAL_SPACING
      : 0;
  const height =
    layerCount > 0 ? layerCount * NODE_HEIGHT + (layerCount - 1) * VERTICAL_SPACING : 0;

  return { nodes, edges, width, height, layers: layerCount };
}
