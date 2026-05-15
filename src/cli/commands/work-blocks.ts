import { parseArgs } from "node:util";
import type { CliDeps, Writer } from "../context.js";

export interface WorkBlocksOptions {
  readonly sessionId?: string | undefined;
}

export function parseWorkBlocksArgs(argv: string[]): WorkBlocksOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    ...(values.session === undefined ? {} : { sessionId: values.session }),
  };
}

export async function runWorkBlocks(
  options: WorkBlocksOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const timelineStore = deps.timelineStore;
  if (timelineStore === undefined) {
    throw new Error("Timeline store is not available.");
  }
  const items = await timelineStore.listWorkBlocks({
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  writer(JSON.stringify({ items }, null, 2));
}
