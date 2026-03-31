/**
 * DAG view — ASCII tree of the contribution graph with outcome color-coding.
 *
 * Reuses the existing git-style DAG renderer from the CLI.
 * Outcome badges are displayed alongside each node when available.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import { contributionsToDagNodes, renderDag } from "../../cli/format-dag.js";
import type { Contribution } from "../../core/models.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { OutcomeBadge } from "../components/outcome-badge.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DagData, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the DAG view. */
export interface DagProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

/** Color map for contribution kinds. */
const KIND_COLORS: Record<string, string> = {
  work: theme.work,
  review: theme.review,
  discussion: theme.discussion,
  adoption: theme.adoption,
  reproduction: theme.reproduction,
};

/** DAG view component. */
export const DagView: React.NamedExoticComponent<DagProps> = React.memo(function DagView({
  provider,
  intervalMs,
  active,
  cursor,
  onContributionsLoaded,
}: DagProps): React.ReactNode {
  const fetcher = useCallback(() => provider.getDag(), [provider]);
  const { data, loading, isStale, error } = usePolledData<DagData>(fetcher, intervalMs, active);

  // Batch-fetch outcomes if provider supports it
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;

  const cids = useMemo(() => data?.contributions?.map((c) => c.cid) ?? [], [data]);

  const outcomeFetcher = useCallback(
    () => outcomeProvider?.getOutcomes(cids) ?? Promise.resolve(new Map()),
    [outcomeProvider, cids],
  );
  const { data: outcomes } = usePolledData<ReadonlyMap<string, OutcomeRecord>>(
    outcomeFetcher,
    intervalMs,
    active && cids.length > 0,
  );

  useEffect(() => {
    if (data && onContributionsLoaded) {
      onContributionsLoaded(data.contributions);
    }
  }, [data, onContributionsLoaded]);

  const contributions = data?.contributions ?? [];

  const kindMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contributions) {
      map.set(c.cid, c.kind);
    }
    return map;
  }, [contributions]);

  const dagLines = useMemo(() => {
    if (contributions.length === 0) return [];
    const nodes = contributionsToDagNodes(contributions);
    return renderDag(nodes);
  }, [contributions]);

  const cidList = useMemo(() => {
    return dagLines
      .filter((l) => l.label !== "")
      .map((l) => {
        const match = /^(blake3:\S+)/.exec(l.label);
        return match?.[1] ?? "";
      });
  }, [dagLines]);

  if (loading && !data) {
    return (
      <box>
        <text opacity={0.5}>Loading DAG...</text>
      </box>
    );
  }

  if (dagLines.length === 0) {
    return (
      <EmptyState
        title="Contribution graph showing agent work."
        hint="Spawn agents with Ctrl+P to see activity here. Each node is a contribution linked to its parents."
      />
    );
  }

  let nodeIndex = 0;

  return (
    <box flexDirection="column">
      <box marginBottom={1} flexDirection="row">
        <text>{`Contribution DAG (${contributions.length} nodes) `}</text>
        <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
        <box opacity={0.5} flexDirection="row">
          <text color={theme.work}>work</text>
          <text> </text>
          <text color={theme.review}>review</text>
          <text> </text>
          <text color={theme.discussion}>discussion</text>
          <text> </text>
          <text color={theme.adoption}>adoption</text>
          <text> </text>
          <text color={theme.reproduction}>reproduction</text>
        </box>
      </box>
      {dagLines.map((line, i) => {
        const isNodeLine = line.label !== "";
        const currentNodeIndex = isNodeLine ? nodeIndex++ : -1;
        const isSelected = isNodeLine && currentNodeIndex === cursor;

        const cidInLabel = cidList[currentNodeIndex];
        const fullCid = contributions.find(
          (c) => cidInLabel && c.cid.includes(cidInLabel.replace("blake3:", "").replace("..", "")),
        )?.cid;
        const kind = fullCid ? kindMap.get(fullCid) : undefined;
        const color = kind ? KIND_COLORS[kind] : undefined;
        const outcome = fullCid ? outcomes?.get(fullCid) : undefined;

        return (
          <box key={`dag-${String(i)}`} flexDirection="row">
            {isSelected ? <text color={theme.focus}>{"> "}</text> : <text> </text>}
            <text opacity={0.5}>{line.graphPrefix}</text>
            {isNodeLine && (
              <>
                <text color={isSelected ? theme.focus : color}>
                  {" "}
                  {line.label.length > 50 ? `${line.label.slice(0, 48)}..` : line.label}
                </text>
                {outcome && (
                  <>
                    <text> </text>
                    <OutcomeBadge status={outcome.status} />
                  </>
                )}
              </>
            )}
          </box>
        );
      })}
    </box>
  );
});
