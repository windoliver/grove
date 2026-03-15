/**
 * Compare view — fetches two contributions and renders them
 * side-by-side using the SplitDiff component.
 *
 * Displayed in the Artifact panel area when compare mode is active
 * and two frontier entries have been selected.
 */

import React, { useCallback } from "react";
import { SplitDiff } from "../components/split-diff.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ContributionDetail, TuiDataProvider } from "../provider.js";

/** Props for the CompareView component. */
export interface CompareViewProps {
  readonly provider: TuiDataProvider;
  readonly leftCid: string;
  readonly rightCid: string;
  readonly intervalMs: number;
}

/** Side-by-side contribution comparison panel. */
export const CompareView: React.NamedExoticComponent<CompareViewProps> = React.memo(
  function CompareView({
    provider,
    leftCid,
    rightCid,
    intervalMs,
  }: CompareViewProps): React.ReactNode {
    const leftFetcher = useCallback(() => provider.getContribution(leftCid), [provider, leftCid]);
    const rightFetcher = useCallback(
      () => provider.getContribution(rightCid),
      [provider, rightCid],
    );

    const { data: left } = usePolledData<ContributionDetail | undefined>(
      leftFetcher,
      intervalMs,
      true,
    );
    const { data: right } = usePolledData<ContributionDetail | undefined>(
      rightFetcher,
      intervalMs,
      true,
    );

    if (!left || !right) {
      return (
        <box>
          <text opacity={0.5}>Loading comparison...</text>
        </box>
      );
    }

    // Build score comparison strings
    const leftScores = left.contribution.scores
      ? Object.entries(left.contribution.scores)
          .map(([k, v]) => `${k}: ${String(v.value)}`)
          .join(", ")
      : undefined;
    const rightScores = right.contribution.scores
      ? Object.entries(right.contribution.scores)
          .map(([k, v]) => `${k}: ${String(v.value)}`)
          .join(", ")
      : undefined;

    return (
      <SplitDiff
        leftLabel={`${left.contribution.agent.agentName ?? left.contribution.agent.agentId}`}
        rightLabel={`${right.contribution.agent.agentName ?? right.contribution.agent.agentId}`}
        leftContent={left.contribution.description ?? left.contribution.summary}
        rightContent={right.contribution.description ?? right.contribution.summary}
        leftMetric={leftScores}
        rightMetric={rightScores}
      />
    );
  },
);
