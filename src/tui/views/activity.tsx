/**
 * Activity stream view — live feed of contributions.
 *
 * PR2 (#388) migrated from `usePolledData(provider.getActivity)` to
 * `useEntities("Contribution", …)`. Pagination is applied to the
 * informer cache snapshot (sorted by createdAt desc + sliced by
 * pageOffset/pageSize). The cache is bounded by the listFn snapshot;
 * "load more" beyond that window will see the same set until a relist
 * pulls a fresh snapshot.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { useInformerFactoryOptional } from "../hooks/informer-context.js";
import { useEntities } from "../hooks/use-entities.js";
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

/** Project a ContributionEntity back to the flat Contribution shape this view's
 * row formatter expects. The fields the table reads are: cid, kind, mode,
 * summary, agent, tags, createdAt. */
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
    const factory = useInformerFactoryOptional();
    const useInformerPath = factory?.supportsKind("Contribution") === true;

    const entityResult = useEntities("Contribution");

    const fetcher = useCallback(
      () => provider.getActivity({ limit: pageSize, offset: pageOffset }),
      [provider, pageSize, pageOffset],
    );
    const polled = usePolledData<readonly Contribution[]>(
      fetcher,
      intervalMs,
      active && !useInformerPath,
    );

    const data = useMemo<readonly Contribution[] | undefined>(() => {
      if (useInformerPath) {
        const all = entityResult.data;
        // Sort newest-first by creationTimestamp; entities without a
        // timestamp sort last (they're typically synthetic / pre-#287).
        const sorted = [...all].sort((a, b) =>
          (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""),
        );
        return sorted.slice(pageOffset, pageOffset + pageSize).map(entityToContribution);
      }
      return polled.data ?? undefined;
    }, [useInformerPath, entityResult.data, polled.data, pageOffset, pageSize]);

    const loading = useInformerPath
      ? !entityResult.hasSynced && data === undefined
      : polled.loading;

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
      summary:
        (c.summary ?? "").length > 36 ? `${(c.summary ?? "").slice(0, 34)}..` : (c.summary ?? ""),
      agent: c.agent?.agentName ?? c.agent?.agentId ?? "unknown",
      tags: (c.tags ?? []).slice(0, 3).join(", "),
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
