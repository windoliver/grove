/**
 * `grove uptime` — print seconds since grove init.
 *
 * Derives the init time from the earliest contribution's createdAt timestamp.
 */

import { parseArgs } from "node:util";

import type { CliDeps } from "../context.js";
import { outputJson } from "../format.js";

export function parseUptimeArgs(args: readonly string[]): { json: boolean } {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return { json: values.json ?? false };
}

export async function runUptime(opts: { json: boolean }, deps: CliDeps): Promise<void> {
  const all = await deps.store.list({ limit: 1 });
  if (all.length === 0) {
    if (opts.json) {
      outputJson({ seconds: 0, message: "no contributions yet" });
    } else {
      console.log("0");
    }
    return;
  }

  const first = all[0]!;
  const startTime = Date.parse(first.createdAt);
  const seconds = Math.floor((Date.now() - startTime) / 1000);

  if (opts.json) {
    outputJson({ seconds, since: first.createdAt });
  } else {
    console.log(String(seconds));
  }
}
