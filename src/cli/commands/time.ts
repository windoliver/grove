/**
 * `grove time` — print current timestamp.
 */

import { parseArgs } from "node:util";

import { outputJson } from "../format.js";

export async function handleTime(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const now = new Date();

  if (values.json) {
    outputJson({ iso: now.toISOString(), epoch: now.getTime() });
    return;
  }

  console.log(now.toISOString());
}
