/**
 * Pure adapter over the approval data already surfaced by useAgentMonitor.
 * Sorts FIFO by requestedAt, deduplicates by (agentId, requestId), and
 * delegates accept/reject to the caller-provided mutation functions.
 *
 * Wrapping with confirm-and-mutate is the modal's responsibility — the
 * queue itself stays pure so unit tests do not touch React or the safety
 * pipeline.
 */

import type { PendingApproval } from "./types.js";

export interface ApprovalQueue {
  readonly pending: readonly PendingApproval[];
  readonly head: PendingApproval | undefined;
  forAgent(agentId: string): PendingApproval | undefined;
  accept(requestId: string): Promise<void>;
  reject(requestId: string): Promise<void>;
}

export interface ApprovalMutations {
  accept(requestId: string): Promise<void>;
  reject(requestId: string): Promise<void>;
}

export function createApprovalQueue(
  incoming: readonly PendingApproval[],
  mutate: ApprovalMutations,
): ApprovalQueue {
  const seen = new Set<string>();
  const deduped: PendingApproval[] = [];
  for (const a of incoming) {
    const key = `${a.agentId}::${a.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }
  deduped.sort((a, b) => a.requestedAt - b.requestedAt);

  const index = new Map(deduped.map((a) => [a.requestId, a]));

  return {
    pending: deduped,
    head: deduped[0],
    forAgent(agentId) {
      return deduped.find((a) => a.agentId === agentId);
    },
    async accept(requestId) {
      if (!index.has(requestId)) throw new Error(`unknown approval ${requestId}`);
      await mutate.accept(requestId);
    },
    async reject(requestId) {
      if (!index.has(requestId)) throw new Error(`unknown approval ${requestId}`);
      await mutate.reject(requestId);
    },
  };
}
