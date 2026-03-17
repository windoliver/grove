/**
 * Activity panel — recent contributions filtered by kind/agent/tags.
 *
 * Distinct from the existing ActivityView tab: this is a dedicated
 * operator panel (toggled via key 9) with compact formatting.
 */

import React, { useCallback, useEffect } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the ActivityPanel view. */
export interface ActivityPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 16 },
  { header: "KIND", key: "kind", width: 12 },
  { header: "SUMMARY", key: "summary", width: 32 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "TAGS", key: "tags", width: 14 },
  { header: "TIME", key: "time", width: 10 },
] as const;

/** Activity panel showing recent contributions. */
export const ActivityPanelView: React.NamedExoticComponent<ActivityPanelProps> = React.memo(
  function ActivityPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: ActivityPanelProps): React.ReactNode {
    const fetcher = useCallback(() => provider.getActivity({ limit: 30 }), [provider]);
    const { data, loading, isStale, error } = usePolledData<readonly Contribution[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading activity...</text>
        </box>
      );
    }

    const contributions = data ?? [];

    const rows = contributions.map((c) => ({
      cid: truncateCid(c.cid),
      kind: c.kind,
      summary: c.summary.length > 32 ? `${c.summary.slice(0, 30)}..` : c.summary,
      agent: c.agent.role ?? c.agent.agentName ?? c.agent.agentId,
      tags: c.tags.slice(0, 2).join(", "),
      time: formatTimestamp(c.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Activity</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {`${contributions.length} recent`}
          </text>
        </box>
        {rows.length === 0 ? (
          <EmptyState
            title="No recent activity."
            hint="Activity appears as agents publish contributions."
          />
        ) : (
          <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
        )}
      </box>
    );
  },
);
