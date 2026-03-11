/**
 * Dashboard view — the default TUI view.
 *
 * Shows:
 * - Grove metadata (name, mode, contribution count)
 * - Active claims with agent, target, lease remaining
 * - Recent contributions (reverse chronological)
 * - Frontier summary (top contributions per metric)
 */

import { Box, Text } from "ink";
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
  /** Called when contributions are loaded, for cursor-based drill-down. */
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
  }: DashboardProps): React.ReactElement {
    const fetcher = useCallback(() => provider.getDashboard(), [provider]);
    const { data, loading, error } = usePolledData<DashboardData>(fetcher, intervalMs, active);

    // Report loaded contributions for cursor-based drill-down
    useEffect(() => {
      if (data && onContributionsLoaded) {
        onContributionsLoaded(data.recentContributions);
      }
    }, [data, onContributionsLoaded]);

    if (loading && !data) {
      return (
        <Box>
          <Text dimColor>Loading dashboard...</Text>
        </Box>
      );
    }

    if (!data) {
      return (
        <Box>
          <Text color="red">Failed to load dashboard{error ? `: ${error.message}` : ""}</Text>
        </Box>
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
      <Box flexDirection="column">
        {/* Metadata header */}
        <Box marginBottom={1}>
          <Text bold color="green">
            {metadata.name}
          </Text>
          <Text dimColor>
            {"  "}mode:{metadata.mode} contributions:{metadata.contributionCount} claims:
            {metadata.activeClaimCount}
          </Text>
        </Box>

        {/* Active claims */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold underline>
            Active Claims ({activeClaims.length})
          </Text>
          {activeClaims.length === 0 ? (
            <Text dimColor>No active claims</Text>
          ) : (
            <Table columns={[...CLAIM_COLUMNS]} rows={claimRows} />
          )}
        </Box>

        {/* Frontier summary */}
        {(frontierSummary.topByMetric.length > 0 || frontierSummary.topByAdoption.length > 0) && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold underline>
              Frontier
            </Text>
            {frontierSummary.topByMetric.map((m) => (
              <Text key={m.metric}>
                <Text color="yellow">{m.metric}</Text>: {truncateCid(m.cid)} {m.summary} (
                {m.value.toFixed(2)})
              </Text>
            ))}
            {frontierSummary.topByAdoption.map((a) => (
              <Text key={a.cid}>
                <Text color="magenta">adoption</Text>: {truncateCid(a.cid)} {a.summary} ({a.count}{" "}
                refs)
              </Text>
            ))}
          </Box>
        )}

        {/* Recent contributions */}
        <Box flexDirection="column">
          <Text bold underline>
            Recent Contributions ({recentContributions.length})
          </Text>
          <Table columns={[...CONTRIBUTION_COLUMNS]} rows={contributionRows} cursor={cursor} />
        </Box>
      </Box>
    );
  },
);
