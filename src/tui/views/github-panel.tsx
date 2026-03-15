/**
 * GitHub panel — active PR information.
 *
 * Shows the active GitHub PR summary if the provider exposes a
 * TuiGitHubProvider-compatible interface. Falls back to a "not available"
 * message following the same pattern as gossip-panel.tsx.
 */

import React, { useCallback } from "react";
import { DataStatus } from "../components/data-status.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { GitHubPRSummary, TuiDataProvider, TuiGitHubProvider } from "../provider.js";

/** Props for the GitHubPanel view. */
export interface GitHubPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

/** Check if a provider exposes a getActivePR method. */
function hasGitHub(provider: TuiDataProvider): provider is TuiDataProvider & TuiGitHubProvider {
  return (
    "getActivePR" in provider &&
    typeof (provider as unknown as TuiGitHubProvider).getActivePR === "function"
  );
}

/** GitHub panel showing active PR information. */
export const GitHubPanelView: React.NamedExoticComponent<GitHubPanelProps> = React.memo(
  function GitHubPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: GitHubPanelProps): React.ReactNode {
    const supportsGitHub = hasGitHub(provider);

    // Suppress unused variable warnings for props used by other panel configurations
    void cursor;
    void onRowCountChanged;

    const fetcher = useCallback(async (): Promise<GitHubPRSummary | undefined> => {
      if (!supportsGitHub) return undefined;

      return (provider as unknown as TuiGitHubProvider).getActivePR();
    }, [provider, supportsGitHub]);

    const { data, loading, isStale, error } = usePolledData<GitHubPRSummary | undefined>(
      fetcher,
      intervalMs,
      active,
    );

    if (!supportsGitHub) {
      return (
        <box>
          <text opacity={0.5}>GitHub not available for this backend</text>
        </box>
      );
    }

    if (loading && data === undefined) {
      return (
        <box>
          <text opacity={0.5}>Loading GitHub PR...</text>
        </box>
      );
    }

    const pr = data ?? undefined;

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>GitHub</text>
          <DataStatus
            loading={loading && data === undefined}
            isStale={isStale}
            error={error?.message}
          />
        </box>
        {pr === undefined ? (
          <box>
            <text opacity={0.5}>No active PR</text>
          </box>
        ) : (
          <box flexDirection="column">
            <box>
              <text color="#00cccc">PR #{pr.number}</text>
              <text> {pr.title}</text>
            </box>
            <box>
              <text opacity={0.5}>State: </text>
              <text>{pr.state}</text>
              <text opacity={0.5}> Checks: </text>
              <text>{pr.checksStatus}</text>
              <text opacity={0.5}> Review: </text>
              <text>{pr.reviewStatus}</text>
            </box>
            <box>
              <text opacity={0.5}>Files: </text>
              <text>{pr.filesChanged}</text>
              <text color="#00cc00"> +{pr.additions}</text>
              <text color="#ff4444"> -{pr.deletions}</text>
            </box>
          </box>
        )}
      </box>
    );
  },
);
