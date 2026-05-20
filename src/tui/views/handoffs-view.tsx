/**
 * Handoffs panel — shows topology routing coordination records.
 *
 * Displays pending, delivered, replied, and expired handoffs so operators
 * and agents can see what work is in-flight between roles, with receipt
 * tracking (seen/acked) and deadline/overdue indicators.
 *
 * Accessible via key "5" in the running view.
 */

import React, { useCallback } from "react";
import type { HandoffQuery } from "../../core/handoff.js";
import { type Handoff, HandoffStatus } from "../../core/handoff.js";
import {
  countHandoffOperatorStates,
  deriveHandoffOperatorProjection,
  type HandoffHealthSignal,
} from "../../core/handoff-operator-state.js";
import { truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { isHandoffProvider } from "../provider.js";
import { theme } from "../theme.js";

const COLUMNS = [
  { header: "FROM", key: "from", width: 10 },
  { header: "TO", key: "to", width: 10 },
  { header: "STATE", key: "state", width: 16 },
  { header: "REASON", key: "reason", width: 22 },
  { header: "RECEIPT", key: "receipt", width: 10 },
  { header: "DEADLINE", key: "deadline", width: 12 },
  { header: "ACTIONS", key: "actions", width: 40 },
  { header: "SOURCE CID", key: "cid", width: 18 },
] as const;

const OPERATOR_TERMINAL_STATUSES: ReadonlySet<HandoffStatus> = new Set([
  HandoffStatus.Cancelled,
  HandoffStatus.ManuallyResolved,
]);

/**
 * Receipt state — derived from seenAt/ackedAt timestamps.
 * Follows opencode's colored-dot status pattern.
 */
function receiptLabel(h: Handoff): string {
  if (h.ackedAt !== undefined) return "\u25CF acked"; // ● solid dot
  if (h.seenAt !== undefined) return "\u25D0 seen"; // ◐ half dot
  return "\u25CB unseen"; // ○ empty dot
}

/** Deadline state — shows remaining time or overdue indicator. */
function deadlineLabel(h: Handoff): string {
  if (h.replyDueAt === undefined) return "\u2014"; // — no deadline
  const now = Date.now();
  const deadline = new Date(h.replyDueAt).getTime();
  const diff = deadline - now;

  // Already resolved — show checkmark
  if (h.status === HandoffStatus.Replied) return "\u2713 met";
  if (h.status === HandoffStatus.Expired) return "\u2717 expired";
  if (OPERATOR_TERMINAL_STATUSES.has(h.status)) return "\u2713 closed";

  // Overdue
  if (diff < 0) {
    const overdueMins = Math.floor(-diff / 60_000);
    if (overdueMins < 60) return `\uD83D\uDD34 ${overdueMins}m over`;
    return `\uD83D\uDD34 ${Math.floor(overdueMins / 60)}h over`;
  }

  // Remaining
  const remainMins = Math.floor(diff / 60_000);
  if (remainMins < 60) return `${remainMins}m left`;
  return `${Math.floor(remainMins / 60)}h left`;
}

export interface HandoffsViewProps {
  readonly provider: TuiDataProvider;
  /** Unused after A8.4 migration to useEventDrivenData; kept for caller-stability. */
  readonly intervalMs?: number;
  readonly active: boolean;
  readonly cursor: number;
  /** Filter by status. Omit to show all. */
  readonly statusFilter?: string | undefined;
  /** Filter by target role. Omit to show all roles. */
  readonly toRoleFilter?: string | undefined;
  /** ISO timestamp — only show handoffs created at or after this time (current session). */
  readonly sessionStartedAt?: string | undefined;
  /** Pre-fetched handoffs from parent. When provided, skips the internal fetch. */
  readonly handoffs?: readonly Handoff[] | undefined;
  readonly healthSignals?: readonly HandoffHealthSignal[] | undefined;
}

/** Handoffs panel component. */
export const HandoffsView: React.NamedExoticComponent<HandoffsViewProps> = React.memo(
  function HandoffsView({
    provider,
    active,
    cursor,
    statusFilter,
    toRoleFilter,
    sessionStartedAt,
    handoffs: prefetched,
    healthSignals,
  }: HandoffsViewProps): React.ReactNode {
    // When parent provides pre-fetched handoffs, use those directly.
    const fetcher = useCallback(async () => {
      if (!isHandoffProvider(provider)) return [] as readonly Handoff[];
      const q: HandoffQuery = {
        ...(statusFilter !== undefined ? { status: statusFilter as HandoffStatus } : {}),
        ...(toRoleFilter !== undefined ? { toRole: toRoleFilter } : {}),
        limit: 200,
      };
      const all = await provider.getHandoffs(q);
      const cutoff = sessionStartedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      return all.filter((h) => h.createdAt >= cutoff);
    }, [provider, statusFilter, toRoleFilter, sessionStartedAt]);

    const driven = useEventDrivenData<readonly Handoff[]>(
      fetcher,
      undefined,
      undefined,
      active && !prefetched,
    );
    const data = prefetched ?? driven.data;
    const loading = prefetched ? false : driven.loading;

    if (!isHandoffProvider(provider)) {
      return (
        <box>
          <text opacity={0.5}>Handoffs not available — topology routing not active.</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading handoffs...</text>
        </box>
      );
    }

    const handoffs = data ?? [];
    const projections = handoffs.map((handoff) =>
      deriveHandoffOperatorProjection(handoff, { healthSignals }),
    );
    const counts = countHandoffOperatorStates(projections);

    const rows = projections.map((projection) => ({
      from: projection.handoff.fromRole,
      to: projection.handoff.toRole,
      state: projection.state,
      reason: projection.reason,
      receipt: receiptLabel(projection.handoff),
      deadline: deadlineLabel(projection.handoff),
      actions: projection.actions.join(", "),
      cid: truncateCid(projection.handoff.sourceCid),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Handoffs</text>
          <text opacity={0.5}>
            {handoffs.length > 0
              ? `  ${handoffs.length} total, ${counts.pending} pending, ${counts.overdue} overdue, ${counts.blocked} blocked, ${counts.deadLettered} failed`
              : "  (no handoffs yet)"}
          </text>
          {counts.deadLettered > 0 && (
            <text color={theme.error}>{`  ${counts.deadLettered} failed`}</text>
          )}
        </box>
        {handoffs.length === 0 ? (
          <text opacity={0.4}>
            No handoffs yet. Handoffs appear when contributions are routed between roles.
          </text>
        ) : (
          <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
        )}
      </box>
    );
  },
);
