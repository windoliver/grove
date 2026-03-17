/**
 * Threads panel — hot discussion threads with reply counts.
 *
 * Operator panel showing the most active discussion threads
 * sorted by recent activity.
 */

import React, { useCallback, useEffect } from "react";
import type { ThreadSummary } from "../../core/store.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the ThreadsPanel view. */
export interface ThreadsPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 16 },
  { header: "SUMMARY", key: "summary", width: 32 },
  { header: "REPLIES", key: "replies", width: 8 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "LAST REPLY", key: "lastReply", width: 12 },
] as const;

/** Threads panel showing hot discussion threads. */
export const ThreadsPanelView: React.NamedExoticComponent<ThreadsPanelProps> = React.memo(
  function ThreadsPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: ThreadsPanelProps): React.ReactNode {
    const fetcher = useCallback(() => provider.getHotThreads(20), [provider]);
    const { data, loading, isStale, error } = usePolledData<readonly ThreadSummary[]>(
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
          <text opacity={0.5}>Loading threads...</text>
        </box>
      );
    }

    const threads = data ?? [];

    const rows = threads.map((t) => ({
      cid: truncateCid(t.contribution.cid),
      summary:
        t.contribution.summary.length > 32
          ? `${t.contribution.summary.slice(0, 30)}..`
          : t.contribution.summary,
      replies: String(t.replyCount),
      agent:
        t.contribution.agent.role ?? t.contribution.agent.agentName ?? t.contribution.agent.agentId,
      lastReply: t.lastReplyAt ? formatTimestamp(t.lastReplyAt) : "-",
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Threads</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {`${threads.length} active`}
          </text>
        </box>
        {threads.length === 0 ? (
          <EmptyState
            title="No discussion threads yet."
            hint="Threads appear when agents reply to contributions."
          />
        ) : (
          <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
        )}
      </box>
    );
  },
);
