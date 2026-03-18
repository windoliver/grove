/**
 * DataStatus indicator component for TUI panels.
 *
 * Shows loading spinner on initial load, "stale" badge when data
 * is outdated due to fetch errors, and nothing when data is fresh.
 */

import React from "react";
import { theme } from "../theme.js";

/** Props for the DataStatus component. */
export interface DataStatusProps {
  /** True during the initial fetch (no data yet). */
  readonly loading: boolean;
  /** Whether the displayed data is stale (fetch failed but old data is shown). */
  readonly isStale: boolean;
  /** Error message, if any. */
  readonly error?: string | undefined;
}

/** Shorten verbose Nexus/network error messages for panel headers. */
function shortenError(msg: string): string {
  if (msg.includes("Failed to connect")) return "Nexus unreachable";
  if (msg.includes("rate limit")) return "Rate limited (retrying)";
  if (msg.includes("Auth failed")) return "Auth failed";
  if (msg.includes("timed out")) return "Request timeout";
  if (msg.length > 50) return `${msg.slice(0, 47)}...`;
  return msg;
}

/** Compact data freshness indicator for panel headers. */
export const DataStatus: React.NamedExoticComponent<DataStatusProps> = React.memo(
  function DataStatus({ loading, isStale, error }: DataStatusProps): React.ReactNode {
    if (loading) {
      return (
        <box>
          <text color={theme.muted}> Loading...</text>
        </box>
      );
    }

    if (isStale) {
      return (
        <box flexDirection="row">
          <text color={theme.stale}> [stale]</text>
          {error && <text color={theme.error}> {shortenError(error)}</text>}
        </box>
      );
    }

    // Initial fetch failure: no cached data, not loading, but has error
    if (error) {
      return (
        <box>
          <text color={theme.error}> [error] {shortenError(error)}</text>
        </box>
      );
    }

    return null;
  },
);
