/**
 * Search panel — full-text search of contributions.
 *
 * Operator panel (toggled via key 0) with an integrated search
 * input bar and results table. Press "/" when focused to enter
 * search input mode; type query and press Enter to search.
 */

import React, { useCallback, useEffect } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the SearchPanel view. */
export interface SearchPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly searchQuery: string;
  readonly isInputMode: boolean;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 16 },
  { header: "KIND", key: "kind", width: 12 },
  { header: "SUMMARY", key: "summary", width: 36 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "TIME", key: "time", width: 10 },
] as const;

/** Search panel showing full-text search results. */
export const SearchPanelView: React.NamedExoticComponent<SearchPanelProps> = React.memo(
  function SearchPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    searchQuery,
    isInputMode,
    onRowCountChanged,
  }: SearchPanelProps): React.ReactNode {
    // Use search if available on the provider, fall back to getContributions
    const fetcher = useCallback(async (): Promise<readonly Contribution[]> => {
      if (!searchQuery) return provider.getContributions({ limit: 20 });

      // Check if provider has search capability (TuiArtifactProvider)
      const searchable = provider as { search?: (q: string) => Promise<readonly Contribution[]> };
      if (searchable.search) {
        return searchable.search(searchQuery);
      }

      // Fallback: use getContributions (no server-side search)
      return provider.getContributions({ limit: 20 });
    }, [provider, searchQuery]);

    const { data, loading } = usePolledData<readonly Contribution[]>(fetcher, intervalMs, active);

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Searching...</text>
        </box>
      );
    }

    const contributions = data ?? [];

    const rows = contributions.map((c) => ({
      cid: truncateCid(c.cid),
      kind: c.kind,
      summary: c.summary.length > 36 ? `${c.summary.slice(0, 34)}..` : c.summary,
      agent: c.agent.role ?? c.agent.agentName ?? c.agent.agentId,
      time: formatTimestamp(c.createdAt),
    }));

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Search</text>
          {isInputMode ? (
            <text color="#00cccc">
              {"  /"}
              {searchQuery}
              {"_"}
            </text>
          ) : searchQuery ? (
            <text opacity={0.5}>
              {"  "}query: &quot;{searchQuery}&quot; ({contributions.length} results) [/ to search]
            </text>
          ) : (
            <text opacity={0.5}>
              {"  "}
              {contributions.length} contributions [/ to search]
            </text>
          )}
        </box>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
