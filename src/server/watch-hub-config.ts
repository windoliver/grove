/**
 * Boot-time resolution of WatchHubOptions from environment variables.
 * Extracted from serve.ts so the env→config mapping is unit-testable
 * without standing up the full server (#293).
 */

import { clampInt } from "../core/clamp.js";
import type { WatchHubOptions } from "../core/watch-hub.js";

export interface ResolveOptions {
  readonly warn?: (msg: string) => void;
}

export function resolveWatchHubConfig(
  env: Readonly<Record<string, string | undefined>>,
  opts: ResolveOptions = {},
): Pick<WatchHubOptions, "maxAgeMsPerKey" | "maxEventsPerKey"> {
  return {
    maxAgeMsPerKey: clampInt({
      raw: env.GROVE_WATCH_RETENTION_MS,
      fallback: 300_000,
      min: 1_000,
      max: 86_400_000,
      name: "GROVE_WATCH_RETENTION_MS",
      ...(opts.warn ? { warn: opts.warn } : {}),
    }),
    maxEventsPerKey: clampInt({
      raw: env.GROVE_WATCH_MAX_EVENTS,
      fallback: 1024,
      min: 16,
      max: 1_000_000,
      name: "GROVE_WATCH_MAX_EVENTS",
      ...(opts.warn ? { warn: opts.warn } : {}),
    }),
  };
}
