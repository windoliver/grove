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
import { truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { isHandoffProvider } from "../provider.js";
import { theme } from "../theme.js";

const COLUMNS = [
  { header: "FROM", key: "from", width: 10 },
  { header: "TO", key: "to", width: 10 },
  { header: "STATUS", key: "status", width: 16 },
  { header: "RECEIPT", key: "receipt", width: 10 },
  { header: "DEADLINE", key: "deadline", width: 12 },
  { header: "SOURCE CID", key: "cid", width: 18 },
  { header: "CREATED", key: "created", width: 7 },
] as const;

/** Status labels with emoji indicators. */
const STATUS_LABELS: Record<string, string> = {
  [HandoffStatus.PendingPickup]: "\u23F3 pending",
  [HandoffStatus.Delivered]: "\uD83D\uDCEC delivered",
  [HandoffStatus.Replied]: "\u2705 [done]",
  [HandoffStatus.Expired]: "\u231B expired",
};

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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "--:--";
  }
}

/** Check if a handoff is overdue (has deadline, unresolved, past due). */
function isOverdue(h: Handoff): boolean {
  if (h.replyDueAt === undefined) return false;
  if (h.status === HandoffStatus.Replied || h.status === HandoffStatus.Expired) return false;
  return new Date(h.replyDueAt).getTime() < Date.now();
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
  /** Optional: scope to handoffs touching this agent's role. Omitted =
   *  no narrowing (#193). */
  readonly filterAgentId?: string | undefined;
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
    filterAgentId,
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
    const scoped =
      filterAgentId === undefined
        ? handoffs
        : handoffs.filter((h) => h.fromRole === filterAgentId || h.toRole === filterAgentId);
    const pending = scoped.filter((h) => h.status === HandoffStatus.PendingPickup).length;
    const overdueCount = scoped.filter(isOverdue).length;

    const rows = scoped.map((h) => ({
      from: h.fromRole,
      to: h.toRole,
      status: STATUS_LABELS[h.status] ?? h.status,
      receipt: receiptLabel(h),
      deadline: deadlineLabel(h),
      cid: truncateCid(h.sourceCid),
      created: formatTime(h.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Handoffs</text>
          <text opacity={0.5}>
            {scoped.length > 0
              ? `  ${scoped.length} total, ${pending} pending`
              : "  (no handoffs yet)"}
          </text>
          {overdueCount > 0 && <text color={theme.error}>{`  ${overdueCount} overdue`}</text>}
        </box>
        {scoped.length === 0 ? (
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
