/**
 * Handoffs panel — shows topology routing coordination records.
 *
 * Displays pending, delivered, replied, and expired handoffs so operators
 * and agents can see what work is in-flight between roles.
 *
 * Accessible via key "5" in the running view.
 */

import React, { useCallback } from "react";
import type { HandoffQuery } from "../../core/handoff.js";
import { type Handoff, HandoffStatus } from "../../core/handoff.js";
import { truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";
import { isHandoffProvider } from "../provider.js";

const COLUMNS = [
  { header: "FROM", key: "from", width: 12 },
  { header: "TO", key: "to", width: 12 },
  { header: "STATUS", key: "status", width: 16 },
  { header: "SOURCE CID", key: "cid", width: 22 },
  { header: "CREATED", key: "created", width: 12 },
] as const;

const STATUS_LABELS: Record<string, string> = {
  [HandoffStatus.PendingPickup]: "⏳ pending",
  [HandoffStatus.Delivered]: "📬 delivered",
  [HandoffStatus.Replied]: "✅ replied",
  [HandoffStatus.Expired]: "⌛ expired",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "--:--";
  }
}

export interface HandoffsViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  /** Filter by status. Omit to show all. */
  readonly statusFilter?: string | undefined;
  /** Filter by target role. Omit to show all roles. */
  readonly toRoleFilter?: string | undefined;
  /** ISO timestamp — only show handoffs created at or after this time (current session). */
  readonly sessionStartedAt?: string | undefined;
}

/** Handoffs panel component. */
export const HandoffsView: React.NamedExoticComponent<HandoffsViewProps> = React.memo(
  function HandoffsView({
    provider,
    intervalMs,
    active,
    cursor,
    statusFilter,
    toRoleFilter,
    sessionStartedAt,
  }: HandoffsViewProps): React.ReactNode {
    const fetcher = useCallback(async () => {
      if (!isHandoffProvider(provider)) return [] as readonly Handoff[];
      const q: HandoffQuery = {
        ...(statusFilter !== undefined ? { status: statusFilter as HandoffStatus } : {}),
        ...(toRoleFilter !== undefined ? { toRole: toRoleFilter } : {}),
        limit: 200,
      };
      const all = await provider.getHandoffs(q);
      // Show only handoffs from the current session's agent spawn time.
      // Fall back to last 2 hours to avoid showing stale data from old sessions.
      const cutoff = sessionStartedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      return all.filter((h) => h.createdAt >= cutoff);
    }, [provider, statusFilter, toRoleFilter, sessionStartedAt]);

    const { data, loading } = usePolledData<readonly Handoff[]>(fetcher, intervalMs, active);

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
    const pending = handoffs.filter((h) => h.status === HandoffStatus.PendingPickup).length;

    const rows = handoffs.map((h) => ({
      from: h.fromRole,
      to: h.toRole,
      status: STATUS_LABELS[h.status] ?? h.status,
      cid: truncateCid(h.sourceCid),
      created: formatTime(h.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Handoffs</text>
          <text opacity={0.5}>
            {handoffs.length > 0
              ? `  ${handoffs.length} total, ${pending} pending`
              : "  (no handoffs yet)"}
          </text>
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
