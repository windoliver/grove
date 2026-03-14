/**
 * grove threads — list active discussion threads sorted by activity.
 *
 * Usage:
 *   grove threads                      # hot threads (default limit 10)
 *   grove threads --tag architecture   # filter by tag
 *   grove threads --limit 20           # custom limit
 *   grove threads --json               # JSON output
 */

import { parseArgs } from "node:util";

import { threadsOperation } from "../../core/operations/index.js";
import type { CliDeps, Writer } from "../context.js";
import { formatHotThreads, outputJson } from "../format.js";
import { toOperationDeps } from "../operation-adapter.js";

const DEFAULT_LIMIT = 10;

export interface ThreadsOptions {
  readonly tags: readonly string[];
  readonly limit: number;
  readonly json: boolean;
  readonly wide: boolean;
}

export function parseThreadsArgs(argv: string[]): ThreadsOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      wide: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const limit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : DEFAULT_LIMIT;
  if (Number.isNaN(limit) || limit <= 0) {
    throw new Error(`Invalid limit: '${values.limit}'. Must be a positive integer.`);
  }

  return {
    tags: values.tag as string[],
    limit,
    json: values.json ?? false,
    wide: values.wide ?? false,
  };
}

export async function runThreads(
  options: ThreadsOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const result = await threadsOperation(
    {
      ...(options.tags.length > 0 ? { tags: options.tags } : {}),
      limit: options.limit,
    },
    toOperationDeps(deps),
  );

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  const summaries = result.value.threads;

  if (options.json) {
    outputJson(result.value);
    return;
  }

  if (summaries.length === 0) {
    writer("(no active threads)");
    return;
  }

  // Fetch full contributions for the formatHotThreads function
  const cids = summaries.map((s) => s.cid);
  const fullMap = await deps.store.getMany(cids);

  const threadSummaries = summaries
    .map((s) => {
      const contribution = fullMap.get(s.cid);
      if (contribution === undefined) return undefined;
      return {
        contribution,
        replyCount: s.replyCount,
        lastReplyAt: s.lastReplyAt,
      };
    })
    .filter((t): t is import("../../core/store.js").ThreadSummary => t !== undefined);

  writer(formatHotThreads(threadSummaries, { wide: options.wide }));
}
