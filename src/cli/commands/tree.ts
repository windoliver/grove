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
import type { CliDeps, Writer } from "../context.js";
import { contributionsToDagNodes, formatDag, renderDag } from "../format-dag.js";

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
 * Performs a level-wise BFS over derives_from and adopts edges, batching
 * `store.get` / `store.relatedTo` to avoid N+1 round-trips on deep graphs.
 *
 * For each visited node we already have the outgoing relations in memory
 * (on the fetched Contribution), so only incoming edges need a DB call.
 */
async function collectSubgraph(
  deps: CliDeps,
  fromCid: string,
  maxDepth: number,
): Promise<readonly Contribution[]> {
  const visited = new Map<string, Contribution>();
  let frontier: readonly { cid: string; depth: number }[] = [{ cid: fromCid, depth: 0 }];

  while (frontier.length > 0) {
    // Batch-fetch all nodes in the current frontier that we haven't seen yet.
    const current = frontier.filter((f) => !visited.has(f.cid) && f.depth <= maxDepth);
    const toFetch = current.map((f) => f.cid);
    const fetched =
      toFetch.length > 0 ? await deps.store.getMany(toFetch) : new Map<string, Contribution>();

    const expandable: Array<{ cid: string; depth: number; contribution: Contribution }> = [];
    for (const { cid, depth } of current) {
      const contribution = fetched.get(cid);
      if (contribution === undefined) continue;
      visited.set(cid, contribution);
      if (depth < maxDepth) {
        expandable.push({ cid, depth, contribution });
      }
    }

    const nextFrontier: { cid: string; depth: number }[] = [];

    // Outgoing edges live on the contribution — no DB call needed.
    for (const { depth, contribution } of expandable) {
      for (const rel of contribution.relations) {
        if (
          (rel.relationType === "derives_from" || rel.relationType === "adopts") &&
          !visited.has(rel.targetCid)
        ) {
          nextFrontier.push({ cid: rel.targetCid, depth: depth + 1 });
        }
      }
    }

    // Incoming edges: fetch all current frontier nodes in parallel, then
    // filter for derives_from/adopts in memory.
    const incomingLists = await Promise.all(expandable.map((n) => deps.store.relatedTo(n.cid)));
    for (let i = 0; i < expandable.length; i++) {
      const node = expandable[i];
      if (node === undefined) continue;
      const incoming = incomingLists[i] ?? [];
      for (const child of incoming) {
        if (visited.has(child.cid)) continue;
        const hasEdge = child.relations.some(
          (rel) =>
            rel.targetCid === node.cid &&
            (rel.relationType === RelationType.DerivesFrom ||
              rel.relationType === RelationType.Adopts),
        );
        if (hasEdge) {
          nextFrontier.push({ cid: child.cid, depth: node.depth + 1 });
        }
      }
    }

    frontier = nextFrontier;
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
    // Validate the CID exists before walking. Previously this double-walked:
    // one traversal via treeOperation, then another in collectSubgraph.
    const root = await deps.store.get(options.from);
    if (root === undefined) {
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
