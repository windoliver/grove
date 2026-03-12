/**
 * grove thread — view a discussion thread from its root.
 *
 * Usage:
 *   grove thread blake3:abc123              # view thread
 *   grove thread blake3:abc123 --depth 5    # limit depth
 *   grove thread blake3:abc123 -n 20        # limit nodes
 *   grove thread blake3:abc123 --json       # JSON output
 */

import { parseArgs } from "node:util";

import { threadOperation } from "../../core/operations/index.js";
import type { CliDeps, Writer } from "../context.js";
import { formatThread } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";

const DEFAULT_DEPTH = 50;
const DEFAULT_LIMIT = 100;

export interface ThreadOptions {
  readonly cid: string;
  readonly depth: number;
  readonly limit: number;
  readonly json: boolean;
}

export function parseThreadArgs(argv: string[]): ThreadOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      depth: { type: "string" },
      n: { type: "string", short: "n" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const cid = positionals[0];
  if (cid === undefined || cid.trim().length === 0) {
    throw new Error("Usage: grove thread <cid> [--depth N] [-n N] [--json]");
  }

  const depth = values.depth !== undefined ? Number.parseInt(values.depth, 10) : DEFAULT_DEPTH;
  if (Number.isNaN(depth) || depth <= 0) {
    throw new Error(`Invalid depth: '${values.depth}'. Must be a positive integer.`);
  }

  const limit = values.n !== undefined ? Number.parseInt(values.n, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit <= 0) {
    throw new Error(`Invalid limit: '${values.n}'. Must be a positive integer.`);
  }

  return {
    cid,
    depth,
    limit,
    json: values.json ?? false,
  };
}

export async function runThread(
  options: ThreadOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const result = await threadOperation(
    {
      cid: options.cid,
      maxDepth: options.depth,
      limit: options.limit,
    },
    toOperationDeps(deps),
  );

  if (!result.ok) {
    throw new Error(`Contribution '${options.cid}' not found or has no thread.`);
  }

  const nodes = result.value.nodes;

  if (options.json) {
    writer(
      JSON.stringify(
        nodes.map((n) => ({
          cid: n.cid,
          depth: n.depth,
          kind: n.kind,
          summary: n.summary,
          agent: n.agentId,
          createdAt: n.createdAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  // The formatThread function expects ThreadNode[] (store types).
  // Fetch the full contributions to build ThreadNode-compatible objects for display.
  const cids = nodes.map((n) => n.cid);
  const fullMap = await deps.store.getMany(cids);

  const threadNodes = nodes
    .map((n) => {
      const contribution = fullMap.get(n.cid);
      if (contribution === undefined) return undefined;
      return { contribution, depth: n.depth };
    })
    .filter((n): n is import("../../core/store.js").ThreadNode => n !== undefined);

  writer(formatThread(threadNodes));
}
