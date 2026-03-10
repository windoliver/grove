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

import type { CliDeps, Writer } from "../context.js";
import { formatHotThreads } from "../format.js";

const DEFAULT_LIMIT = 10;

export interface ThreadsOptions {
  readonly tags: readonly string[];
  readonly limit: number;
  readonly json: boolean;
}

export function parseThreadsArgs(argv: string[]): ThreadsOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
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
  };
}

export async function runThreads(
  options: ThreadsOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const summaries = await deps.store.hotThreads({
    tags: options.tags.length > 0 ? options.tags : undefined,
    limit: options.limit,
  });

  if (summaries.length === 0) {
    if (options.json) {
      writer("[]");
    } else {
      writer("(no active threads)");
    }
    return;
  }

  if (options.json) {
    writer(
      JSON.stringify(
        summaries.map((s) => ({
          cid: s.contribution.cid,
          summary: s.contribution.summary,
          kind: s.contribution.kind,
          replyCount: s.replyCount,
          lastReplyAt: s.lastReplyAt,
          tags: s.contribution.tags,
          agent: s.contribution.agent.agentName ?? s.contribution.agent.agentId,
          createdAt: s.contribution.createdAt,
        })),
        null,
        2,
      ),
    );
    return;
  }

  writer(formatHotThreads(summaries));
}
