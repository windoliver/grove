/**
 * Drain a fire-and-forget AcpxTurn in the background and surface any
 * terminal error to the supplied logger. Used by control-plane callers
 * (SessionOrchestrator, SpawnManager, NexusWsBridge, AcpxRuntime's own
 * initial-goal side effect) that don't otherwise consume the turn.
 *
 * We intentionally do not throw: the pattern is fire-and-forget delivery
 * and these callers have no retry channel. The goal is to make silent
 * delivery failures observable by an operator.
 */

import type { AcpxTurn } from "./types.js";

export function watchTurnError(
  turn: AcpxTurn,
  context: string,
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): void {
  void turn.result
    .then((r) => {
      if (r.stopReason === "error") {
        const code = r.error?.code ? ` (code=${r.error.code})` : "";
        const msg = r.error?.message ?? "unknown error";
        log(`[watchTurn] ${context} turn ${turn.turnId} ended with error${code}: ${msg}`);
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[watchTurn] ${context} turn ${turn.turnId} rejected: ${msg}`);
    });
}
