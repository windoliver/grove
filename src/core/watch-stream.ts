/**
 * WatchStream — common contract implemented by remote (HTTP/SSE) and
 * in-process watch clients. Consumed by Informer (#294) so the cache
 * layer can be backend-agnostic.
 */

import type { WatchClientEvent } from "./watch-client.js";

export interface WatchStream {
  run(opts: {
    onEvent: (e: WatchClientEvent) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<void>;
}

export type { WatchClientEvent };
