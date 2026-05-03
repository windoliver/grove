/**
 * Dashboard view — the default TUI view.
 *
 * Shows grove metadata, active claims, frontier summary, and recent contributions.
 *
 * PR3 (#389) migrates the cross-kind aggregates (activeClaims +
 * recentContributions + counts) from `usePolledData(getDashboard)` to
 * `useDerived(...)` over the `Claim` + `Contribution` informers. The
 * remaining polled call still supplies `metadata` (name/backendLabel) and
 * `frontierSummary` — both require server compute that does not flow
 * through the watch protocol — at the same cadence as before.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { ContributionEntity } from "../../core/entity.js";
import type { Contribution } from "../../core/models.js";
import { formatDuration } from "../../shared/duration.js";
import { compareTimestampsDesc, formatTimestamp, truncateCid } from "../../shared/format.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Limit the recent-contribution slice projected from the informer cache. */
const RECENT_CONTRIBUTIONS_LIMIT = 50;

/** Cross-cut snapshot derived from the Contribution informer. Active claims
 *  are NOT migrated here: their "active" status is lease-aware (a claim ages
 *  out when wall-clock time crosses `leaseExpiresAt`) and the watch protocol
 *  emits no event for that transition. The polled `getDashboard()` path
 *  computes it correctly via the lease-aware store query, so we keep claim
 *  list/count on that path and only swap contributions to the informer. */
interface DashboardCrossCut {
  readonly recentContributions: readonly Contribution[];
  readonly contributionCount: number;
}

const EMPTY_CROSS_CUT: DashboardCrossCut = {
  recentContributions: [],
  contributionCount: 0,
};

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

/** Compare every visible column the contribution table renders: cid, kind,
 *  summary, agent display identity, createdAt. Even though contributions are
 *  conceptually append-only, the watch protocol carries MODIFIED events and
 *  late agent-name backfills can change the rendered row for a stable cid. */
function contributionsEqual(a: Contribution, b: Contribution): boolean {
  if (a === b) return true;
  return (
    a.cid === b.cid &&
    a.kind === b.kind &&
    a.summary === b.summary &&
    a.createdAt === b.createdAt &&
    a.agent.agentId === b.agent.agentId &&
    a.agent.agentName === b.agent.agentName
  );
}

/** Structural cross-cut compare — fields, then per-row projected compare. */
export function crossCutEquals(a: DashboardCrossCut, b: DashboardCrossCut): boolean {
  if (a === b) return true;
  if (a.contributionCount !== b.contributionCount) return false;
  if (a.recentContributions.length !== b.recentContributions.length) return false;
  for (let i = 0; i < a.recentContributions.length; i++) {
    const ai = a.recentContributions[i];
    const bi = b.recentContributions[i];
    if (!ai || !bi || !contributionsEqual(ai, bi)) return false;
  }
  return true;
}

/** Props for the Dashboard view. */
export interface DashboardProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onContributionsLoaded?: (contributions: readonly Contribution[]) => void;
}

const CLAIM_COLUMNS = [
  { header: "AGENT", key: "agent", width: 16 },
  { header: "TARGET", key: "target", width: 24 },
  { header: "LEASE", key: "lease", width: 12 },
  { header: "INTENT", key: "intent", width: 30 },
] as const;

const CONTRIBUTION_COLUMNS = [
  { header: "CID", key: "cid", width: 22 },
  { header: "KIND", key: "kind", width: 10 },
  { header: "SUMMARY", key: "summary", width: 32 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "CREATED", key: "created", width: 12 },
] as const;

/** Dashboard view component. */
export const DashboardView: React.NamedExoticComponent<DashboardProps> = React.memo(
  function DashboardView({
    provider,
    intervalMs,
    active,
    cursor,
    onContributionsLoaded,
  }: DashboardProps): React.ReactNode {
    const useInformerPath = useEntityWatchEnabled(provider, "Contribution");
    const contribInformer = useInformerOptional("Contribution");

    // Contribution-only derived snapshot. Claims stay on the polled
    // (lease-aware) path because lease expiry is wall-clock-driven and
    // emits no watch event — see DashboardCrossCut docstring.
    const derived = useDerived<DashboardCrossCut>(
      () => {
        const allContribs = contribInformer.list() as readonly ContributionEntity[];
        // DESC chronological compare — invalid-last so missing/malformed
        // timestamps can't displace real recent contributions in the slice.
        const recent = [...allContribs]
          .sort((a, b) =>
            compareTimestampsDesc(a.metadata.creationTimestamp, b.metadata.creationTimestamp),
          )
          .slice(0, RECENT_CONTRIBUTIONS_LIMIT)
          .map(entityToContribution);
        return {
          recentContributions: recent,
          contributionCount: allContribs.length,
        };
      },
      ["Contribution"],
      crossCutEquals,
    );

    const fetcher = useCallback(() => provider.getDashboard(), [provider]);
    const {
      data: polledData,
      loading,
      error,
    } = useEventDrivenData<DashboardData>(fetcher, undefined, undefined, active);

    // Compose the rendered DashboardData: prefer informer-derived
    // contributions when the path is active AND has synced without error;
    // claims, metadata, and frontierSummary always come from the polled
    // call (claims because they're lease-aware, the others because they
    // require server compute outside the watch protocol).
    //
    // Why hasSynced gating: without it, cold start (informer up but no
    // RELIST_END yet) or terminal watch failure would inject EMPTY_CROSS_CUT
    // — fabricating a zeroed dashboard over real polled data.
    const informerReady = useInformerPath && derived.hasSynced && !derived.error;
    const data: DashboardData | undefined = useMemo(() => {
      if (!polledData) return undefined;
      if (!informerReady) return polledData;
      const cross = derived.data ?? EMPTY_CROSS_CUT;
      return {
        ...polledData,
        metadata: {
          ...polledData.metadata,
          contributionCount: cross.contributionCount,
        },
        recentContributions: cross.recentContributions,
      };
    }, [polledData, informerReady, derived.data]);

    useEffect(() => {
      if (data && onContributionsLoaded) {
        onContributionsLoaded(data.recentContributions);
      }
    }, [data, onContributionsLoaded]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading dashboard...</text>
        </box>
      );
    }

    if (!data) {
      return (
        <box>
          <text color={theme.error}>
            Failed to load dashboard{error ? `: ${error.message}` : ""}
          </text>
        </box>
      );
    }

    const metadata = data.metadata ?? {
      name: "",
      backendLabel: "",
      contributionCount: 0,
      activeClaimCount: 0,
    };
    const activeClaims = data.activeClaims ?? [];
    const recentContributions = data.recentContributions ?? [];
    const frontierSummary = data.frontierSummary ?? { topByMetric: [], topByAdoption: [] };

    const claimRows = activeClaims.map((c) => {
      const remaining = new Date(c.leaseExpiresAt).getTime() - Date.now();
      return {
        agent: c.agent.agentName ?? c.agent.agentId,
        target: c.targetRef.length > 24 ? `${c.targetRef.slice(0, 22)}..` : c.targetRef,
        lease: remaining > 0 ? formatDuration(remaining) : "expired",
        intent:
          (c.intentSummary ?? "").length > 30
            ? `${(c.intentSummary ?? "").slice(0, 28)}..`
            : (c.intentSummary ?? ""),
      };
    });

    const contributionRows = recentContributions.map((c) => ({
      cid: truncateCid(c.cid),
      kind: c.kind,
      summary: c.summary.length > 32 ? `${c.summary.slice(0, 30)}..` : c.summary,
      agent: c.agent.agentName ?? c.agent.agentId,
      created: formatTimestamp(c.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text color={theme.success}>{metadata.name}</text>
          <text opacity={0.5}>
            {"  "}
            {`${metadata.backendLabel} contributions:${metadata.contributionCount} claims:${metadata.activeClaimCount}`}
          </text>
        </box>

        <box flexDirection="column" marginBottom={1}>
          <text>{`Active Claims (${activeClaims.length})`}</text>
          {activeClaims.length === 0 ? (
            <EmptyState
              title="No active claims."
              hint="Spawn agents with Ctrl+P. Claims are created automatically to prevent duplicate work."
            />
          ) : (
            <Table columns={[...CLAIM_COLUMNS]} rows={claimRows} />
          )}
        </box>

        {((frontierSummary.topByMetric?.length ?? 0) > 0 ||
          (frontierSummary.topByAdoption?.length ?? 0) > 0) && (
          <box flexDirection="column" marginBottom={1}>
            <text>Frontier</text>
            {(frontierSummary.topByMetric ?? []).map((m) => (
              <box key={m.metric} flexDirection="row">
                <text color={theme.review}>{m.metric}</text>
                <text>{`: ${truncateCid(m.cid)} ${m.summary} (${m.value.toFixed(2)})`}</text>
              </box>
            ))}
            {(frontierSummary.topByAdoption ?? []).map((a) => (
              <box key={a.cid} flexDirection="row">
                <text color={theme.adoption}>adoption</text>
                <text>{`: ${truncateCid(a.cid)} ${a.summary} (${a.count} refs)`}</text>
              </box>
            ))}
          </box>
        )}

        <box flexDirection="column">
          <text>{`Recent Contributions (${recentContributions.length})`}</text>
          {contributionRows.length === 0 ? (
            <EmptyState
              title="Grove dashboard. Shows active claims and recent contributions."
              hint="Spawn agents with Ctrl+P or run grove contribute to publish work."
            />
          ) : (
            <Table columns={[...CONTRIBUTION_COLUMNS]} rows={contributionRows} cursor={cursor} />
          )}
        </box>
      </box>
    );
  },
);
