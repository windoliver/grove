/**
 * `grove uptime` — print seconds since grove init.
 *
 * Derives the init time from the grove.db file's birthtime,
 * which is created during `grove init`.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
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
  const dbPath = join(deps.groveRoot, "grove.db");
  let birthtime: Date;
  try {
    const info = await stat(dbPath);
    birthtime = info.birthtime;
  } catch {
    if (opts.json) {
      outputJson({ seconds: 0, message: "grove not initialized" });
    } else {
      console.log("grove not initialized");
    }
    return;
  }

  const seconds = Math.floor((Date.now() - birthtime.getTime()) / 1000);
  const since = birthtime.toISOString();

  if (opts.json) {
    outputJson({ seconds, since });
  } else {
    console.log(String(seconds));
  }
}
