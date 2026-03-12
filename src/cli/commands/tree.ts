/**
 * grove tree — ASCII DAG visualization of the contribution graph.
 *
 * Usage:
 *   grove tree                           # full DAG from roots
 *   grove tree --from blake3:abc123      # subtree from specific contribution
 *   grove tree --depth 3                 # limit depth
 *   grove tree --json
 */

import { parseArgs } from "node:util";

import type { Contribution } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import { treeOperation } from "../../core/operations/index.js";
import type { CliDeps, Writer } from "../context.js";
import { contributionsToDagNodes, formatDag, renderDag } from "../format-dag.js";
import { toOperationDeps } from "../operation-adapter.js";

const DEFAULT_DEPTH = 10;

export interface TreeOptions {
  readonly from?: string | undefined;
  readonly depth: number;
  readonly json: boolean;
}

export function parseTreeArgs(argv: string[]): TreeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      depth: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const depth = values.depth !== undefined ? Number.parseInt(values.depth, 10) : DEFAULT_DEPTH;
  if (Number.isNaN(depth) || depth <= 0) {
    throw new Error(`Invalid depth: '${values.depth}'. Must be a positive integer.`);
  }

  return {
    from: values.from,
    depth,
    json: values.json ?? false,
  };
}

/**
 * Collect contributions reachable from a starting CID within a depth limit.
 * Performs a BFS over derives_from and adopts relations (outgoing edges).
 */
async function collectSubgraph(
  deps: CliDeps,
  fromCid: string,
  maxDepth: number,
): Promise<readonly Contribution[]> {
  const visited = new Map<string, Contribution>();
  const queue: { cid: string; depth: number }[] = [{ cid: fromCid, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    if (visited.has(item.cid) || item.depth > maxDepth) continue;

    const contribution = await deps.store.get(item.cid);
    if (contribution === undefined) continue;

    visited.set(item.cid, contribution);

    // Follow derives_from and adopts edges (ancestors)
    for (const rel of contribution.relations) {
      if (
        (rel.relationType === "derives_from" || rel.relationType === "adopts") &&
        !visited.has(rel.targetCid)
      ) {
        queue.push({ cid: rel.targetCid, depth: item.depth + 1 });
      }
    }

    // Follow incoming derives_from and adopts edges (children of this node)
    const derivesChildren = await deps.store.relatedTo(item.cid, RelationType.DerivesFrom);
    const adoptsChildren = await deps.store.relatedTo(item.cid, RelationType.Adopts);
    for (const child of [...derivesChildren, ...adoptsChildren]) {
      if (!visited.has(child.cid)) {
        queue.push({ cid: child.cid, depth: item.depth + 1 });
      }
    }
  }

  return [...visited.values()];
}

export async function runTree(
  options: TreeOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  let contributions: readonly Contribution[];

  if (options.from !== undefined) {
    // Use the treeOperation to validate the CID exists, then collect full subgraph
    // for DAG rendering (the operation only returns summaries, but we need full
    // Contribution objects for the DAG renderer).
    const result = await treeOperation(
      { cid: options.from, direction: "both" },
      toOperationDeps(deps),
    );

    if (!result.ok) {
      throw new Error(`Contribution '${options.from}' not found.`);
    }

    contributions = await collectSubgraph(deps, options.from, options.depth);
  } else {
    // Full graph
    contributions = await deps.store.list();
  }

  if (contributions.length === 0) {
    writer("(empty graph)");
    return;
  }

  // Sort topologically: newest first (for DAG rendering)
  const sorted = [...contributions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  if (options.json) {
    writer(JSON.stringify(sorted, null, 2));
    return;
  }

  const nodes = contributionsToDagNodes(sorted);
  const lines = renderDag(nodes);
  writer(formatDag(lines));
}
