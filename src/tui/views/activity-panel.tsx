/**
 * Activity panel — recent contributions filtered by kind/agent/tags.
 *
 * PR2 (#388) migrated from `usePolledData(provider.getActivity({limit:30}))`
 * to `useEntities("Contribution", …)` + `.slice(0, 30)`. Distinct from the
 * full ActivityView tab: this is a dedicated operator panel (toggled via
 * key 9) with compact formatting.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";
import { compareTimestampsDesc, formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { useEntityWatchEnabled } from "../hooks/informer-context.js";
import { useEntities } from "../hooks/use-entities.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
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

const PANEL_LIMIT = 30;

function entityToContribution(e: ContributionEntity): Contribution {
  return {
    cid: e.id,
    manifestVersion: 0,
    kind: e.spec.contributionKind,
    mode: e.spec.mode,
    summary: e.spec.summary,
    description: e.spec.description,
    artifacts: e.spec.artifacts,
    relations: e.spec.relations,
    scores: e.spec.scores,
    tags: e.spec.tags,
    context: e.spec.context,
    agent: e.spec.agent,
    createdAt: e.metadata.creationTimestamp ?? "",
  };
}

/** Activity panel showing recent contributions. */
export const ActivityPanelView: React.NamedExoticComponent<ActivityPanelProps> = React.memo(
  function ActivityPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: ActivityPanelProps): React.ReactNode {
    const useInformerPath = useEntityWatchEnabled(provider, "Contribution");

    const entityResult = useEntities("Contribution");

    const fetcher = useCallback(() => provider.getActivity({ limit: PANEL_LIMIT }), [provider]);
    const polled = useEventDrivenData<readonly Contribution[]>(
      fetcher,
      undefined,
      undefined,
      active && !useInformerPath,
    );

    const data = useMemo<readonly Contribution[] | undefined>(() => {
      if (useInformerPath) {
        const sorted = [...entityResult.data].sort((a, b) =>
          compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
        );
        return sorted.slice(0, PANEL_LIMIT).map(entityToContribution);
      }
      return polled.data ?? undefined;
    }, [useInformerPath, entityResult.data, polled.data]);

    const loading = useInformerPath
      ? !entityResult.hasSynced && data === undefined
      : polled.loading;
    const isStale = useInformerPath ? false : polled.isStale;
    const error = useInformerPath ? entityResult.error : polled.error;

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
      summary:
        (c.summary ?? "").length > 32 ? `${(c.summary ?? "").slice(0, 30)}..` : (c.summary ?? ""),
      agent: c.agent?.role ?? c.agent?.agentName ?? c.agent?.agentId ?? "unknown",
      tags: (c.tags ?? []).slice(0, 2).join(", "),
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
