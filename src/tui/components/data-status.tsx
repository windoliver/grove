/**
 * DataStatus indicator component for TUI panels.
 *
 * Shows loading spinner on initial load, "stale" badge when data
 * is outdated due to fetch errors, and nothing when data is fresh.
 */

import React from "react";

/** Props for the DataStatus component. */
export interface DataStatusProps {
  /** True during the initial fetch (no data yet). */
  readonly loading: boolean;
  /** Whether the displayed data is stale (fetch failed but old data is shown). */
  readonly isStale: boolean;
  /** Error message, if any. */
  readonly error?: string | undefined;
}

/** Compact data freshness indicator for panel headers. */
export const DataStatus: React.NamedExoticComponent<DataStatusProps> = React.memo(
  function DataStatus({ loading, isStale, error }: DataStatusProps): React.ReactNode {
    if (loading) {
      return (
        <box>
          <text color="#888888"> Loading...</text>
        </box>
      );
    }

    if (isStale) {
      return (
        <box>
          <text color="#ff8800"> [stale]</text>
          {error && <text color="#ff4444"> {error}</text>}
        </box>
      );
    }

    // Initial fetch failure: no cached data, not loading, but has error
    if (error) {
      return (
        <box>
          <text color="#ff4444"> [error] {error}</text>
        </box>
      );
    }

    return null;
  },
);
