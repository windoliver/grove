import React from "react";
import { theme } from "../../theme.js";
import type { FleetSummary } from "./types.js";

export type SortMode = "severity" | "role" | "cost" | "age";
export type StateFilter = "all" | "problems" | "running";

export interface FleetBannerProps {
  readonly summary: FleetSummary;
  readonly filterText: string;
  readonly filterMode: "idle" | "filter";
  readonly sort: SortMode;
  readonly stateFilter: StateFilter;
  readonly goal?: string;
  /** Optional progress slot — caller supplies the widget. */
  readonly progress?: React.ReactNode;
}

export const FleetBanner: React.NamedExoticComponent<FleetBannerProps> = React.memo(
  function FleetBanner(props: FleetBannerProps) {
    const { summary, filterText, filterMode, sort, stateFilter, goal, progress } = props;
    const counts = summary.byState;
    return (
      <box flexDirection="column" borderStyle="single" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" gap={1}>
          <text>FLEET</text>
          <text color={theme.success}>{`${counts.running} run`}</text>
          <text color={theme.error}>{`${counts.blocked} blk`}</text>
          <text color={theme.error}>{`${counts.thrashing} thrash`}</text>
          <text color={theme.warning}>{`${counts.stuck} stuck`}</text>
          <text color={theme.stale}>{`${counts.silent} silent`}</text>
          {summary.approvalsPending > 0 && (
            <text color={theme.info}>{`${summary.approvalsPending} ⏸ approve`}</text>
          )}
          <text color={theme.secondary}>{`· cost $${summary.costUsd.toFixed(2)}`}</text>
        </box>
        <box flexDirection="row" gap={1}>
          {goal !== undefined && <text>{`goal: ${truncate(goal, 50)}`}</text>}
          {progress}
        </box>
        <box flexDirection="row" gap={2}>
          <text color={theme.secondary}>{`sort:${sort}  filter:${stateFilter}`}</text>
          {filterMode === "filter" ? (
            <text color={theme.info}>{`/${filterText}_`}</text>
          ) : filterText ? (
            <text>{`/${filterText}`}</text>
          ) : null}
        </box>
      </box>
    );
  },
);

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
