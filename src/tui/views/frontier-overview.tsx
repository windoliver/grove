/**
 * Frontier overview tab — shows top-3 entries per non-empty slice as
 * read-only mini-leaderboards. Operators jump into a slice via tab
 * navigation or digit hotkeys handled by the orchestrator.
 */

import React from "react";
import { truncateCid } from "../../shared/format.js";
import { theme } from "../theme.js";
import type { FrontierSlice } from "./frontier-slices.js";

export interface FrontierOverviewProps {
  readonly slices: readonly FrontierSlice[];
}

const TOP_N = 3;

export const FrontierOverview: React.NamedExoticComponent<FrontierOverviewProps> = React.memo(
  function FrontierOverview({ slices }: FrontierOverviewProps): React.ReactNode {
    const nonEmpty = slices.filter((s) => s.entries.length > 0);
    if (nonEmpty.length === 0) return null;
    return (
      <box flexDirection="column">
        {nonEmpty.map((slice) => (
          <box key={slice.key} flexDirection="column" marginBottom={1}>
            <text color={theme.secondary}>{`── ${slice.label} (top ${String(
              Math.min(TOP_N, slice.entries.length),
            )}) ──`}</text>
            {slice.entries.slice(0, TOP_N).map((entry, i) => (
              <text key={entry.cid}>
                {`  ${String(i + 1)}  ${truncateCid(entry.cid)}  ${slice.formatBadge(entry)}  ${entry.summary.slice(0, 36)}`}
              </text>
            ))}
          </box>
        ))}
      </box>
    );
  },
);
