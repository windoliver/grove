/**
 * Compare view — fetches two contributions and renders them
 * side-by-side using the SplitDiff component.
 *
 * Displayed in the Artifact panel area when compare mode is active
 * and two frontier entries have been selected.
 */

import React, { useCallback } from "react";
import { formatScore } from "../../shared/format.js";
import { SplitDiff } from "../components/split-diff.js";
import { mapPollResult } from "../hooks/panel-state.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { ContributionDetail, TuiDataProvider } from "../provider.js";

/** Props for the CompareView component. */
export interface CompareViewProps {
  readonly provider: TuiDataProvider;
  readonly leftCid: string;
  readonly rightCid: string;
  readonly intervalMs: number;
}

/** Derive display label for a side, falling back through identity fields. */
function agentLabel(detail: ContributionDetail): string {
  return detail.contribution.agent.agentName ?? detail.contribution.agent.agentId;
}

/** Build score summary string for a contribution, or undefined if no scores. */
function scoreLabel(detail: ContributionDetail): string | undefined {
  const scores = detail.contribution.scores;
  if (!scores || Object.keys(scores).length === 0) return undefined;
  return Object.entries(scores)
    .map(([k, v]) => `${k}: ${formatScore(v)}`)
    .join(", ");
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

    const leftState = mapPollResult(
      useEventDrivenData<ContributionDetail | undefined>(leftFetcher, undefined, undefined, true),
    );
    const rightState = mapPollResult(
      useEventDrivenData<ContributionDetail | undefined>(rightFetcher, undefined, undefined, true),
    );

    // Show loading until at least one side has data or an error.
    if (leftState.status === "loading" && rightState.status === "loading") {
      return (
        <box>
          <text opacity={0.5}>Loading comparison...</text>
        </box>
      );
    }

    // Resolve content for each side — error or missing data shows an inline message.
    const leftContent =
      leftState.status === "error"
        ? `[Error: ${leftState.error.message}]`
        : leftState.status === "loading"
          ? "Loading..."
          : (leftState.data?.contribution.description ??
            leftState.data?.contribution.summary ??
            "[Not found]");

    const rightContent =
      rightState.status === "error"
        ? `[Error: ${rightState.error.message}]`
        : rightState.status === "loading"
          ? "Loading..."
          : (rightState.data?.contribution.description ??
            rightState.data?.contribution.summary ??
            "[Not found]");

    const leftLabel =
      leftState.status === "ready" && leftState.data
        ? agentLabel(leftState.data)
        : leftCid.slice(0, 12);

    const rightLabel =
      rightState.status === "ready" && rightState.data
        ? agentLabel(rightState.data)
        : rightCid.slice(0, 12);

    const leftMetric =
      leftState.status === "ready" && leftState.data ? scoreLabel(leftState.data) : undefined;
    const rightMetric =
      rightState.status === "ready" && rightState.data ? scoreLabel(rightState.data) : undefined;

    return (
      <SplitDiff
        leftLabel={leftLabel}
        rightLabel={rightLabel}
        leftContent={leftContent ?? ""}
        rightContent={rightContent ?? ""}
        leftMetric={leftMetric}
        rightMetric={rightMetric}
      />
    );
  },
);
