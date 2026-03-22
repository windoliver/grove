/**
 * grove export-dag — export contributions as JSON.
 *
 * Exports the full contribution DAG (or a filtered subset) as a JSON array
 * of complete Contribution objects. Useful for backups, analysis, and
 * interop with external tools.
 *
 * Usage:
 *   grove export-dag                          # all contributions
 *   grove export-dag --kind work              # only work contributions
 *   grove export-dag --agent alice            # only from agent "alice"
 *   grove export-dag --from blake3:abc123     # subgraph from a CID
 *   grove export-dag --from blake3:abc123 --depth 5
 *   grove export-dag -n 50                    # limit to 50
 *   grove export-dag -o dag.json              # write to file
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { Contribution, ContributionKind, ContributionMode } from "../../core/models.js";
import { RelationType } from "../../core/models.js";
import type { CliDeps, Writer } from "../context.js";
import { outputJson } from "../format.js";
import { parseLimit } from "../utils/parse-helpers.js";

const DEFAULT_DEPTH = 10;

export interface ExportDagOptions {
  readonly kind?: string | undefined;
  readonly mode?: string | undefined;
  readonly agent?: string | undefined;
  readonly tag?: string | undefined;
  readonly from?: string | undefined;
  readonly depth: number;
  readonly limit?: number | undefined;
  readonly output?: string | undefined;
}

export function parseExportDagArgs(argv: string[]): ExportDagOptions {
  // Handle --help before strict parsing
  if (argv.includes("--help") || argv.includes("-h")) {
    printExportDagHelp();
    process.exit(0);
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
      tag: { type: "string" },
      from: { type: "string" },
      depth: { type: "string" },
      n: { type: "string", short: "n" },
      output: { type: "string", short: "o" },
    },
    strict: true,
    allowPositionals: false,
  });

  const depth = values.depth !== undefined ? Number.parseInt(values.depth, 10) : DEFAULT_DEPTH;
  if (Number.isNaN(depth) || depth <= 0) {
    throw new Error(`Invalid depth: '${values.depth}'. Must be a positive integer.`);
  }

  const limit = values.n !== undefined ? Number(values.n) : undefined;

  return {
    kind: values.kind,
    mode: values.mode,
    agent: values.agent,
    tag: values.tag,
    from: values.from,
    depth,
    limit,
    output: values.output,
  };
}

/**
 * Collect contributions reachable from a starting CID within a depth limit.
 * BFS over derives_from and adopts relations in both directions.
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

    // Follow outgoing derives_from and adopts edges (ancestors)
    for (const rel of contribution.relations) {
      if (
        (rel.relationType === "derives_from" || rel.relationType === "adopts") &&
        !visited.has(rel.targetCid)
      ) {
        queue.push({ cid: rel.targetCid, depth: item.depth + 1 });
      }
    }

    // Follow incoming derives_from and adopts edges (children)
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

export async function runExportDag(
  options: ExportDagOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  let contributions: readonly Contribution[];

  if (options.from !== undefined) {
    // Validate the CID exists
    const root = await deps.store.get(options.from);
    if (root === undefined) {
      throw new Error(`Contribution '${options.from}' not found.`);
    }
    contributions = await collectSubgraph(deps, options.from, options.depth);
  } else {
    // Full graph with optional filters
    contributions = await deps.store.list({
      kind: options.kind as ContributionKind | undefined,
      mode: options.mode as ContributionMode | undefined,
      agentId: options.agent,
      tags: options.tag !== undefined ? [options.tag] : undefined,
    });
  }

  // Sort newest-first
  const sorted = [...contributions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  // Apply limit
  const result = options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;

  // Output
  if (options.output !== undefined) {
    writeFileSync(options.output, JSON.stringify(result, null, 2) + "\n", "utf-8");
    writer(`Exported ${result.length} contribution(s) to ${options.output}`);
  } else {
    outputJson(result);
  }
}

function printExportDagHelp(): void {
  console.log(`grove export-dag — export contributions as JSON

Usage:
  grove export-dag [options]

Options:
  --kind <kind>        Filter by contribution kind (work, review, discussion, ...)
  --mode <mode>        Filter by mode (evaluation, exploration)
  --agent <id>         Filter by agent ID
  --tag <tag>          Filter by tag
  --from <cid>         Export subgraph reachable from a specific contribution
  --depth <n>          Max traversal depth when using --from (default: 10)
  -n <count>           Limit number of contributions
  -o, --output <file>  Write JSON to file instead of stdout

Examples:
  grove export-dag                                  # export all
  grove export-dag --kind work -o work.json         # export work contributions to file
  grove export-dag --from blake3:abc123 --depth 3   # export subgraph
  grove export-dag -n 100 | jq '.[] | .cid'         # pipe to jq`);
}
