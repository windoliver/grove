import { parseArgs } from "node:util";
import type { CliDeps, Writer } from "../context.js";
import { parseLimit } from "../utils/parse-helpers.js";

const DEFAULT_LIMIT = 100;

export interface TimelineOptions {
  readonly sessionId?: string | undefined;
  readonly afterRv?: string | undefined;
  readonly limit: number;
  readonly includeWorkBlocks: boolean;
}

export function parseTimelineArgs(argv: string[]): TimelineOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      "after-rv": { type: "string" },
      limit: { type: "string" },
      "include-work-blocks": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    ...(values.session === undefined ? {} : { sessionId: values.session }),
    ...(values["after-rv"] === undefined ? {} : { afterRv: values["after-rv"] }),
    limit: parseLimit(values.limit, DEFAULT_LIMIT),
    includeWorkBlocks: values["include-work-blocks"] ?? false,
  };
}

export async function runTimeline(
  options: TimelineOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const timelineStore = deps.timelineStore;
  if (timelineStore === undefined) {
    throw new Error("Timeline store is not available.");
  }
  const query = {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.afterRv === undefined ? {} : { afterRv: options.afterRv }),
    limit: options.limit,
  };
  const events = await timelineStore.listTimelineEvents(query);
  const workBlocks = options.includeWorkBlocks
    ? await timelineStore.listWorkBlocks({
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      })
    : undefined;
  const timelineResourceVersion = await timelineStore.currentTimelineResourceVersion(
    options.sessionId,
  );
  writer(
    JSON.stringify(
      {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        events,
        ...(workBlocks === undefined ? {} : { workBlocks }),
        timelineResourceVersion,
      },
      null,
      2,
    ),
  );
}
