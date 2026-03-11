/**
 * Dashboard view — the default TUI view.
 *
 * Shows grove metadata, active claims, frontier summary, and recent contributions.
 */

import React, { useCallback, useEffect } from "react";
import type { Contribution } from "../../core/models.js";
import { formatDuration } from "../../shared/duration.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { DashboardData, TuiDataProvider } from "../provider.js";

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
  { header: "KIND", key: "kind", width: 14 },
  { header: "SUMMARY", key: "summary", width: 40 },
  { header: "AGENT", key: "agent", width: 16 },
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
    const fetcher = useCallback(() => provider.getDashboard(), [provider]);
    const { data, loading, error } = usePolledData<DashboardData>(fetcher, intervalMs, active);

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
          <text color="#ff0000">Failed to load dashboard{error ? `: ${error.message}` : ""}</text>
        </box>
      );
    }

    const { metadata, activeClaims, recentContributions, frontierSummary } = data;

    const claimRows = activeClaims.map((c) => {
      const remaining = new Date(c.leaseExpiresAt).getTime() - Date.now();
      return {
        agent: c.agent.agentName ?? c.agent.agentId,
        target: c.targetRef.length > 24 ? `${c.targetRef.slice(0, 22)}..` : c.targetRef,
        lease: remaining > 0 ? formatDuration(remaining) : "expired",
        intent: c.intentSummary.length > 30 ? `${c.intentSummary.slice(0, 28)}..` : c.intentSummary,
      };
    });

    const contributionRows = recentContributions.map((c) => ({
      cid: truncateCid(c.cid),
      kind: c.kind,
      summary: c.summary.length > 40 ? `${c.summary.slice(0, 38)}..` : c.summary,
      agent: c.agent.agentName ?? c.agent.agentId,
      created: formatTimestamp(c.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text color="#00cc00">{metadata.name}</text>
          <text opacity={0.5}>
            {"  "}mode:{metadata.mode} contributions:{metadata.contributionCount} claims:
            {metadata.activeClaimCount}
          </text>
        </box>

        <box flexDirection="column" marginBottom={1}>
          <text>Active Claims ({activeClaims.length})</text>
          {activeClaims.length === 0 ? (
            <text opacity={0.5}>No active claims</text>
          ) : (
            <Table columns={[...CLAIM_COLUMNS]} rows={claimRows} />
          )}
        </box>

        {(frontierSummary.topByMetric.length > 0 || frontierSummary.topByAdoption.length > 0) && (
          <box flexDirection="column" marginBottom={1}>
            <text>Frontier</text>
            {frontierSummary.topByMetric.map((m) => (
              <text key={m.metric}>
                <text color="#cccc00">{m.metric}</text>: {truncateCid(m.cid)} {m.summary} (
                {m.value.toFixed(2)})
              </text>
            ))}
            {frontierSummary.topByAdoption.map((a) => (
              <text key={a.cid}>
                <text color="#cc00cc">adoption</text>: {truncateCid(a.cid)} {a.summary} ({a.count}{" "}
                refs)
              </text>
            ))}
          </box>
        )}

        <box flexDirection="column">
          <text>Recent Contributions ({recentContributions.length})</text>
          <Table columns={[...CONTRIBUTION_COLUMNS]} rows={contributionRows} cursor={cursor} />
        </box>
      </box>
    );
  },
);
