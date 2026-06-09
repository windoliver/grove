import { GarbageCollector, type GcStore } from "../core/garbage-collector.js";
import type { GcAction } from "../core/owner-graph.js";

export function garbageCollectorEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.GROVE_GC !== "0";
}

export interface GarbageCollectorWiringOptions {
  readonly store: GcStore;
  readonly workerCount?: number | undefined;
  readonly resyncIntervalMs?: number | undefined;
  readonly onError?: ((error: unknown, key: string) => void) | undefined;
  readonly onAction?: ((action: GcAction) => void) | undefined;
}

export interface GarbageCollectorWiring {
  readonly collector: GarbageCollector;
}

export function createGarbageCollectorWiring(
  options: GarbageCollectorWiringOptions,
): GarbageCollectorWiring {
  const collector = new GarbageCollector({
    store: options.store,
    workerCount: options.workerCount,
    resyncIntervalMs: options.resyncIntervalMs,
    onError: options.onError,
    onAction: options.onAction,
  });
  return { collector };
}
