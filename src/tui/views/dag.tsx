/**
 * Xray-style collapsible DAG view (issue #311 C5).
 *
 * Replaces the git-style multi-lane renderer with a hierarchical tree
 * rooted at the focused contribution (or all roots if no focus). Each
 * row shows a status icon (running/done/failed/blocked/awaiting-review/
 * idle), the contribution summary, and a relation-type tag when the
 * incoming edge is not a plain derives_from.
 *
 * Expansion state lives in DagStateStore (above the view), so it
 * survives mount/unmount across page switches. Highlight applies
 * model-layer foreground color without filtering rows out.
 *
 * Live updates: useInformerOptional("Contribution") and ("Claim")
 * deliver push updates within the informer's emit window (<200ms in
 * practice; gated only by the underlying RV propagation). When the
 * informer path is unavailable the view falls back to polling
 * provider.getDag() / provider.getClaims({ status: "active" }).
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { ClaimEntity, ContributionEntity } from "../../core/entity.js";
import type { Claim, Contribution } from "../../core/models.js";
import type { OutcomeRecord } from "../../core/outcome.js";
import { compareTimestampsDesc } from "../../shared/format.js";
import { DagStatusIcon } from "../components/dag-status-icon.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { useDagState } from "../hooks/dag-state-context.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { shallowArraysEqual } from "../hooks/use-entities.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { DagData, TuiDataProvider, TuiOutcomeProvider } from "../provider.js";
import { theme } from "../theme.js";
import { projectDagTree, type RenderRow } from "./dag-tree-projection.js";

/** Cap on newest "head" contributions seeded into the DAG; matches the
 *  polled `dagFromStore` cap (`store.list({ limit: 200 })`). */
const DAG_CONTRIBUTION_LIMIT = 200;

/** Hard upper bound after BFS-including ancestors of the head set. */
const DAG_TOTAL_CAP = 500;

/** Project a ContributionEntity back to the flat Contribution shape the
 *  projection renderer reads. */
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

/** Project a ClaimEntity back to the flat Claim shape that
 *  `projectDagTree` consumes. ClaimEntity.spec lacks the `status` and
 *  lease fields — pull them from `status` (the lease-aware view) and
 *  fall back to `metadata.creationTimestamp` for the createdAt. */
function entityToClaim(e: ClaimEntity): Claim {
  return {
    claimId: e.id,
    targetRef: e.spec.targetRef,
    agent: e.spec.agent,
    status: e.status.phase,
    intentSummary: e.spec.intentSummary,
    createdAt: e.metadata.creationTimestamp ?? e.status.heartbeatAt,
    heartbeatAt: e.status.heartbeatAt,
    leaseExpiresAt: e.status.leaseExpiresAt,
    context: e.spec.context,
    attemptCount: e.status.attemptCount,
  };
}

const KIND_COLORS: Record<string, string> = {
  work: theme.work,
  review: theme.review,
  discussion: theme.discussion,
  adoption: theme.adoption,
  reproduction: theme.reproduction,
};

const EDGE_LABEL: Record<string, string> = {
  reviews: "rev",
  reproduces: "rep",
  adopts: "adopt",
  // derives_from rendered without a label.
};

/** Props for the xray DagView. */
export interface DagProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
  /** #311: model-layer match string. Highlights matching rows; does NOT
   *  filter non-matches. Renamed from `filterText` (C2) to reflect the
   *  new no-filter semantics in the xray view. */
  readonly highlightText?: string | undefined;
}

/** Xray-style DAG view (issue #311 C5). */
export const DagView: React.NamedExoticComponent<DagProps> = React.memo(function DagView({
  provider,
  intervalMs: _intervalMs,
  active,
  cursor,
  onContributionsLoaded,
  highlightText,
}: DagProps): React.ReactNode {
  const { store, snapshot } = useDagState();
  const effectiveHighlight = (highlightText ?? snapshot.highlight).trim().toLowerCase();

  // Keep store.highlight in sync with the prop so command-mode /foo flows
  // remain canonical even when other consumers also read from the store.
  useEffect(() => {
    if (highlightText !== undefined && highlightText !== snapshot.highlight) {
      store.setHighlight(highlightText);
    }
  }, [highlightText, snapshot.highlight, store]);

  const useContribWatch = useEntityWatchEnabled(provider, "Contribution");
  const useClaimWatch = useEntityWatchEnabled(provider, "Claim");

  const contribInformer = useInformerOptional("Contribution");
  const claimInformer = useInformerOptional("Claim");

  const derivedContributions = useDerived<readonly Contribution[]>(
    () => {
      const all = contribInformer.list() as readonly ContributionEntity[];
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
          if (
            r.relationType !== "derives_from" &&
            r.relationType !== "adopts" &&
            r.relationType !== "reviews" &&
            r.relationType !== "reproduces"
          )
            continue;
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

  const derivedClaims = useDerived<readonly Claim[]>(
    () => {
      const all = claimInformer.list() as readonly ClaimEntity[];
      return all.filter((e) => e.status.phase === "active").map(entityToClaim);
    },
    ["Claim"],
    shallowArraysEqual,
  );

  const contribInformerReady =
    useContribWatch && derivedContributions.hasSynced && !derivedContributions.error;
  const claimInformerReady = useClaimWatch && derivedClaims.hasSynced && !derivedClaims.error;

  // Polled fallback only when the contribution informer is unavailable.
  const dagFetcher = useCallback(() => provider.getDag(), [provider]);
  const polledDag = useEventDrivenData<DagData>(
    dagFetcher,
    undefined,
    undefined,
    active && !contribInformerReady,
  );

  // Polled claim fallback — same `active` gate as contributions so the
  // panel keeps a consistent freshness story.
  const claimsFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
  const polledClaims = useEventDrivenData<readonly Claim[]>(
    claimsFetcher,
    undefined,
    undefined,
    active && !claimInformerReady,
  );

  const contributions: readonly Contribution[] = useMemo(() => {
    if (contribInformerReady) return derivedContributions.data ?? [];
    return polledDag.data?.contributions ?? [];
  }, [contribInformerReady, derivedContributions.data, polledDag.data]);

  const claims: readonly Claim[] = useMemo(() => {
    if (claimInformerReady) return derivedClaims.data ?? [];
    return polledClaims.data ?? [];
  }, [claimInformerReady, derivedClaims.data, polledClaims.data]);

  const loading = contribInformerReady ? false : polledDag.loading;
  const isStale = contribInformerReady ? false : polledDag.isStale;
  // Surface informer errors even while the polled fallback runs so
  // operators see watch-pipeline failures alongside polled data.
  const error = derivedContributions.error ?? polledDag.error;

  // Outcome batch fetch — kept so done/failed icons remain accurate.
  const outcomeProvider = provider.capabilities.outcomes
    ? (provider as unknown as TuiOutcomeProvider)
    : undefined;
  const cids = useMemo(() => contributions.map((c) => c.cid), [contributions]);
  const outcomeFetcher = useCallback(
    () => outcomeProvider?.getOutcomes(cids) ?? Promise.resolve(new Map()),
    [outcomeProvider, cids],
  );
  const { data: outcomes } = useEventDrivenData<ReadonlyMap<string, OutcomeRecord>>(
    outcomeFetcher,
    undefined,
    undefined,
    active && cids.length > 0,
  );

  useEffect(() => {
    if (contributions.length > 0 && onContributionsLoaded) {
      onContributionsLoaded(contributions);
    }
  }, [contributions, onContributionsLoaded]);

  const projection = useMemo(
    () =>
      projectDagTree({
        contributions,
        outcomes: outcomes ?? new Map(),
        claims,
        now: Date.now(),
        options: {
          collapsed: snapshot.collapsed,
          focusCid: snapshot.focusCid,
          maxNodes: DAG_TOTAL_CAP,
        },
      }),
    [contributions, outcomes, claims, snapshot.collapsed, snapshot.focusCid],
  );

  if (loading && contributions.length === 0) {
    return (
      <box>
        <text opacity={0.5}>Loading DAG...</text>
      </box>
    );
  }

  if (projection.rows.length === 0) {
    return (
      <EmptyState
        title="Contribution graph showing agent work."
        hint="Spawn agents with Ctrl+P to see activity here. Each node is a contribution linked to its parents."
      />
    );
  }

  return (
    <box flexDirection="column">
      <box marginBottom={1} flexDirection="row">
        <text>{`Contribution DAG (${String(projection.rows.length)} rows / ${String(projection.nodes.size)} nodes${projection.truncated ? ", truncated" : ""}) `}</text>
        <DataStatus loading={loading} isStale={isStale} error={error?.message} />
      </box>
      {projection.rows.map((row, i) => (
        <DagRowView
          key={`dag-${row.cid}`}
          row={row}
          isSelected={i === cursor}
          highlight={effectiveHighlight}
        />
      ))}
    </box>
  );
});

interface DagRowProps {
  readonly row: RenderRow;
  readonly isSelected: boolean;
  readonly highlight: string;
}

const DagRowView = React.memo(function DagRowView({
  row,
  isSelected,
  highlight,
}: DagRowProps): React.ReactNode {
  const { node, depth, expander, incomingEdge } = row;
  const indent = "  ".repeat(depth);
  const expanderGlyph = expander === "expanded" ? "▼" : expander === "collapsed" ? "▶" : "·";
  const cidShort = `${node.cid.slice(0, 14)}…`;
  const edgeLabel =
    incomingEdge && incomingEdge !== "derives_from"
      ? `[${EDGE_LABEL[incomingEdge] ?? incomingEdge}] `
      : "";
  const kindColor = KIND_COLORS[node.kind];
  const haystack = `${node.cid} ${node.summary} ${node.kind} ${node.agentLabel}`.toLowerCase();
  const matches = highlight !== "" && haystack.includes(highlight);

  const summaryColor = isSelected ? theme.focus : matches ? theme.highlightMatch : kindColor;
  const truncatedSummary =
    node.summary.length > 60 ? `${node.summary.slice(0, 58)}…` : node.summary;

  return (
    <box flexDirection="row">
      <text color={isSelected ? theme.focus : undefined}>{isSelected ? "> " : "  "}</text>
      <text>{indent}</text>
      <text opacity={0.6}>{`${expanderGlyph} `}</text>
      <DagStatusIcon status={node.status} />
      <text> </text>
      <text opacity={0.5}>{edgeLabel}</text>
      <text opacity={0.6}>{`${cidShort} `}</text>
      <text color={summaryColor}>{`[${node.kind}] ${truncatedSummary}`}</text>
    </box>
  );
});
