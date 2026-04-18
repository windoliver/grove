/**
 * Drain a fire-and-forget AcpxTurn in the background and surface any
 * abnormal terminal state to the supplied logger. Used by control-plane
 * callers (SessionOrchestrator, SpawnManager, NexusWsBridge, AcpxRuntime's
 * own initial-goal side effect) that don't otherwise consume the turn.
 *
 * For control-plane traffic, the only "success" stop reason is `end_turn`.
 * `cancelled` means the provider aborted mid-prompt; `max_tokens` means the
 * response was truncated before completion; `error` means explicit failure;
 * any unknown stop reason from a future ACP spec update is also abnormal
 * until proven otherwise. Treat everything ≠ end_turn as a failure signal
 * worth logging — otherwise a cancelled bootstrap or truncated handoff
 * would be silently accepted as successful delivery.
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
      if (r.stopReason !== "end_turn") {
        const code = r.error?.code ? ` (code=${r.error.code})` : "";
        const msg = r.error?.message ?? "no error payload";
        log(
          `[watchTurn] ${context} turn ${turn.turnId} ended abnormally stopReason=${r.stopReason}${code}: ${msg}`,
        );
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[watchTurn] ${context} turn ${turn.turnId} rejected: ${msg}`);
    });
}
