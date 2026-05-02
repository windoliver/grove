/**
 * DAG view — ASCII tree of the contribution graph with outcome color-coding.
 *
 * Reuses the existing git-style DAG renderer from the CLI.
 * Outcome badges are displayed alongside each node when available.
 *
 * PR3 (#389) migrates the contribution source from `usePolledData(getDag)`
 * to `useDerived(() => contribInformer.list(), ["Contribution"])` when the
 * informer path is enabled. Outcomes still flow through `usePolledData` —
 * PR4 will swap that to an event-driven hook once the outcome producer
 * exposes a coarse change event.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import { contributionsToDagNodes, renderDag } from "../../cli/format-dag.js";
import type { ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { compareTimestampsDesc } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { OutcomeBadge } from "../components/outcome-badge.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { shallowArraysEqual } from "../hooks/use-entities.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DagData, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Cap on newest "head" contributions seeded into the DAG; matches the
 *  polled `dagFromStore` cap (`store.list({ limit: 200 })`). */
const DAG_CONTRIBUTION_LIMIT = 200;

/** Hard upper bound after BFS-including ancestors of the head set. Allows
 *  reachable parents within budget; prevents pathological cases where a
 *  deeply-chained graph blows up render/navigation state. */
const DAG_TOTAL_CAP = 500;

/** Project a ContributionEntity back to the flat Contribution shape the DAG
 *  renderer reads (cid, summary, kind, relations, agent, createdAt). */
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
  const useInformerPath = useEntityWatchEnabled(provider, "Contribution");

  // Informer path: project the cache snapshot through useDerived so the DAG
  // recomputes only when the Contribution kind actually changes. Cap matches
  // the polled `dagFromStore` path (`store.list({ limit: 200 })`) to keep
  // render and navigation state bounded on large repositories — without
  // this, a synced informer with thousands of cached contributions would
  // freeze the TUI.
  //
  // Topology-aware cap: a naive newest-first slice would silently drop
  // parents whose CID falls outside the window, causing children to render
  // as orphans (contributionsToDagNodes filters parent refs to in-set
  // CIDs only). Instead, take the newest budget as heads, then walk
  // `derives_from`/`adopts` relations to include reachable ancestors up to
  // a hard upper bound — preserving correct edges within the rendered set.
  const contribInformer = useInformerOptional("Contribution");
  const derived = useDerived<readonly Contribution[]>(
    () => {
      const all = contribInformer.list() as readonly ContributionEntity[];
      // Chronological DESC compare — string sort breaks on timezone-offset
      // timestamps; the dedicated DESC helper preserves invalid-last so
      // bad-timestamp rows can't displace real recent contributions when
      // we slice the head set below.
      const sorted = [...all].sort((a, b) =>
        compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
      );
      if (sorted.length <= DAG_CONTRIBUTION_LIMIT) {
        return sorted.map(entityToContribution);
      }
      const byId = new Map(sorted.map((e) => [e.id, e]));
      const kept = new Set<string>();
      const queue: ContributionEntity[] = [];
      for (const e of sorted) {
        if (kept.size >= DAG_CONTRIBUTION_LIMIT) break;
        kept.add(e.id);
        queue.push(e);
      }
      while (queue.length > 0 && kept.size < DAG_TOTAL_CAP) {
        const head = queue.shift();
        if (!head) continue;
        for (const r of head.spec.relations) {
          if (r.relationType !== "derives_from" && r.relationType !== "adopts") continue;
          const parent = byId.get(r.targetCid);
          if (parent && !kept.has(parent.id)) {
            kept.add(parent.id);
            queue.push(parent);
            if (kept.size >= DAG_TOTAL_CAP) break;
          }
        }
      }
      return sorted.filter((e) => kept.has(e.id)).map(entityToContribution);
    },
    ["Contribution"],
    shallowArraysEqual,
  );

  // Only switch to informer data once it has synced and is healthy. A
  // remote watch failure (auth/config/server) would otherwise leave the view
  // stuck on "Loading DAG…" with no fallback path; gating on hasSynced +
  // !error keeps `getDag()` polling alive until the watch is actually
  // delivering data.
  const informerReady = useInformerPath && derived.hasSynced && !derived.error;

  // Polled fallback retained for backends that don't mount an InformerProvider
  // AND for cold start / terminal watch failure on the informer path.
  const fetcher = useCallback(() => provider.getDag(), [provider]);
  const polled = usePolledData<DagData>(fetcher, intervalMs, active && !informerReady);

  const contributions: readonly Contribution[] = useMemo(() => {
    if (informerReady) return derived.data ?? [];
    return polled.data?.contributions ?? [];
  }, [informerReady, derived.data, polled.data]);

  const loading = informerReady ? false : polled.loading;
  const isStale = informerReady ? false : polled.isStale;
  // Surface informer errors even while polled-fallback runs so operators
  // see watch-pipeline failures alongside the polled data.
  const error = derived.error ?? polled.error;

  // Batch-fetch outcomes if provider supports it. Outcome polling stays —
  // PR4 will replace it with an event-driven re-fetch.
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;

  const cids = useMemo(() => contributions.map((c) => c.cid), [contributions]);

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
    if (contributions.length > 0 && onContributionsLoaded) {
      onContributionsLoaded(contributions);
    }
  }, [contributions, onContributionsLoaded]);

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

  if (loading && contributions.length === 0) {
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
        <DataStatus loading={loading} isStale={isStale} error={error?.message} />
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
