/**
 * `grove uptime` — show how long the grove has been running.
 *
 * Derives init time from the filesystem birthtime of the .grove directory,
 * which is set once at `grove init` and never changes. This avoids relying
 * on contribution ordering (store.list returns DESC, not ASC).
 */

import { statSync } from "node:fs";
import { parseArgs } from "node:util";

import { resolveGroveDir } from "../utils/grove-dir.js";

export interface UptimeOptions {
  readonly json: boolean;
}

export function parseUptimeArgs(args: readonly string[]): UptimeOptions {
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

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function runUptime(opts: UptimeOptions, groveOverride?: string): void {
  const { groveDir } = resolveGroveDir(groveOverride);
  const stat = statSync(groveDir);
  const initTime = stat.birthtime;
  const now = new Date();
  const uptimeSeconds = Math.floor((now.getTime() - initTime.getTime()) / 1000);

  if (opts.json) {
    console.log(
      JSON.stringify({
        uptimeSeconds,
        initTime: initTime.toISOString(),
        currentTime: now.toISOString(),
      }),
    );
  } else {
    console.log(`Uptime: ${formatDuration(uptimeSeconds)} (${uptimeSeconds}s)`);
    console.log(`Init:   ${initTime.toISOString()}`);
  }
}

export async function handleUptime(args: readonly string[], groveOverride?: string): Promise<void> {
  const opts = parseUptimeArgs([...args]);
  runUptime(opts, groveOverride);
}
