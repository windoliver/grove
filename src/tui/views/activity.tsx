/**
 * Activity stream view — live feed of contributions.
 */

import React, { useCallback, useEffect } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the Activity view. */
export interface ActivityProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly pageOffset: number;
  readonly pageSize: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 22 },
  { header: "KIND", key: "kind", width: 14 },
  { header: "MODE", key: "mode", width: 12 },
  { header: "SUMMARY", key: "summary", width: 36 },
  { header: "AGENT", key: "agent", width: 16 },
  { header: "TAGS", key: "tags", width: 16 },
  { header: "CREATED", key: "created", width: 12 },
] as const;

/** Activity stream view component. */
export const ActivityView: React.NamedExoticComponent<ActivityProps> = React.memo(
  function ActivityView({
    provider,
    intervalMs,
    active,
    cursor,
    pageOffset,
    pageSize,
    onContributionsLoaded,
  }: ActivityProps): React.ReactNode {
    const fetcher = useCallback(
      () => provider.getActivity({ limit: pageSize, offset: pageOffset }),
      [provider, pageSize, pageOffset],
    );
    const { data, loading } = usePolledData<readonly Contribution[]>(fetcher, intervalMs, active);

    useEffect(() => {
      if (data && onContributionsLoaded) {
        onContributionsLoaded(data);
      }
    }, [data, onContributionsLoaded]);

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
      mode: c.mode,
      summary: c.summary.length > 36 ? `${c.summary.slice(0, 34)}..` : c.summary,
      agent: c.agent.agentName ?? c.agent.agentId,
      tags: c.tags.slice(0, 3).join(", "),
      created: formatTimestamp(c.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Activity Stream</text>
          {contributions.length > 0 ? (
            <text opacity={0.5}>
              {`  showing ${pageOffset + 1}-${pageOffset + contributions.length}`}
            </text>
          ) : pageOffset > 0 ? (
            <text opacity={0.5}>{"  "}(no more results — press p to go back)</text>
          ) : null}
        </box>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
