/**
 * `grove uptime` — print seconds since grove init.
 *
 * Derives the init time from the `.grove/` directory birthtime (robust against
 * contribution pruning), with a fallback to the oldest contribution's createdAt.
 */

import { stat } from "node:fs/promises";
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

/**
 * Resolve the grove init time. Prefers `.grove/` directory birthtime;
 * falls back to the oldest contribution's createdAt if stat fails.
 */
async function resolveInitTime(deps: CliDeps): Promise<Date | undefined> {
  try {
    const st = await stat(deps.groveRoot);
    // birthtimeMs is 0 on some Linux filesystems — fall through if so
    if (st.birthtimeMs > 0) return st.birthtime;
  } catch {
    // stat failed — fall through to contribution-based fallback
  }

  // Fallback: oldest contribution (list returns ASC order)
  const oldest = await deps.store.list({ limit: 1 });
  if (oldest.length > 0) {
    return new Date(oldest[0]!.createdAt);
  }

  return undefined;
}

export async function runUptime(opts: { json: boolean }, deps: CliDeps): Promise<void> {
  const initTime = await resolveInitTime(deps);

  if (initTime === undefined) {
    if (opts.json) {
      outputJson({ seconds: 0, message: "no contributions yet" });
    } else {
      console.log("no contributions yet");
    }
    return;
  }

  const seconds = Math.floor((Date.now() - initTime.getTime()) / 1000);

  if (opts.json) {
    outputJson({ seconds, since: initTime.toISOString() });
  } else {
    console.log(String(seconds));
  }
}
