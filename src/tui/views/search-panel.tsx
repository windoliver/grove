/**
 * Search panel — full-text search of contributions.
 *
 * Operator panel (toggled via key 0) with an integrated search
 * input bar and results table. Press "/" when focused to enter
 * search input mode; type query and press Enter to search.
 *
 * Search availability is determined by feature-detecting the search() method
 * (isSearchProvider). When unavailable, a persistent banner informs the user
 * rather than silently falling back to recent items.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { Contribution } from "../../core/models.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { isSearchProvider, type TuiArtifactProvider, type TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the SearchPanel view. */
export interface SearchPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly searchQuery: string;
  readonly isInputMode: boolean;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
  /** Terminal output buffers keyed by session name — for transcript search (item 17). */
  readonly terminalBuffers?: ReadonlyMap<string, string> | undefined;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 16 },
  { header: "KIND", key: "kind", width: 12 },
  { header: "SUMMARY", key: "summary", width: 36 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "TIME", key: "time", width: 10 },
] as const;

const TRANSCRIPT_COLUMNS = [
  { header: "SESSION", key: "session", width: 18 },
  { header: "LINE", key: "lineNo", width: 6 },
  { header: "CONTENT", key: "content", width: 50 },
] as const;

/** Search terminal transcripts for a query string. */
export function searchTranscripts(
  buffers: ReadonlyMap<string, string>,
  query: string,
): readonly Record<string, string>[] {
  const results: Record<string, string>[] = [];
  const lowerQuery = query.toLowerCase();
  for (const [session, output] of buffers) {
    const lines = output.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").toLowerCase().includes(lowerQuery)) {
        results.push({
          session,
          lineNo: String(i + 1),
          content:
            (lines[i] ?? "").length > 50 ? `${(lines[i] ?? "").slice(0, 48)}..` : (lines[i] ?? ""),
        });
      }
    }
  }
  return results.slice(0, 100); // Cap at 100 results
}

/**
 * Select the fetcher function to use based on provider capability and query.
 * Exported as a pure function for unit testing.
 *
 * @param hasSearch  Whether the provider supports full-text search.
 * @param getContributions  Fallback fetcher for recent contributions.
 * @param search  Full-text search fetcher (only called when hasSearch=true).
 * @param query   The current search query string.
 */
export function selectFetcher(
  hasSearch: boolean,
  query: string,
  getContributions: () => Promise<readonly Contribution[]>,
  search: (q: string) => Promise<readonly Contribution[]>,
): () => Promise<readonly Contribution[]> {
  if (!query) return getContributions;
  if (hasSearch) return () => search(query);
  return getContributions;
}

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
    terminalBuffers,
  }: SearchPanelProps): React.ReactNode {
    // Detect transcript search mode: "t:query"
    const isTranscriptMode = searchQuery.startsWith("t:");
    const transcriptQuery = isTranscriptMode ? searchQuery.slice(2).trim() : "";
    const transcriptResults = useMemo(() => {
      if (!isTranscriptMode || !transcriptQuery || !terminalBuffers) return [];
      return searchTranscripts(terminalBuffers, transcriptQuery);
    }, [isTranscriptMode, transcriptQuery, terminalBuffers]);

    // Determine search availability via the proper capability check.
    const hasSearch = isSearchProvider(provider);

    const fetcher = useCallback((): Promise<readonly Contribution[]> => {
      if (!searchQuery || !hasSearch) return provider.getContributions({ limit: 20 });
      return (provider as TuiDataProvider & TuiArtifactProvider).search(searchQuery);
    }, [provider, searchQuery, hasSearch]);

    const { data, loading, isStale, error } = usePolledData<readonly Contribution[]>(
      fetcher,
      intervalMs,
      active,
    );

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

    // Transcript search mode: show transcript results instead of contributions
    if (isTranscriptMode && !isInputMode) {
      return (
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text>Search</text>
            <text opacity={0.5}>
              {`  transcript: "${transcriptQuery}" (${transcriptResults.length} matches) [/ to search]`}
            </text>
          </box>
          <Table columns={[...TRANSCRIPT_COLUMNS]} rows={transcriptResults} cursor={cursor} />
        </box>
      );
    }

    // Show persistent banner when user has a query but search is unavailable.
    const showSearchUnavailable = !hasSearch && !!searchQuery && !isInputMode;

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Search</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          {isInputMode ? (
            <text color={theme.focus}>
              {"  /"}
              {searchQuery}
              {"_"}
            </text>
          ) : searchQuery ? (
            <text opacity={0.5}>
              {`  query: "${searchQuery}" (${contributions.length} results) [/ to search]`}
            </text>
          ) : (
            <text opacity={0.5}>
              {"  "}
              {`${contributions.length} contributions [/ to search, t:query for transcripts]`}
            </text>
          )}
        </box>

        {showSearchUnavailable && (
          <box marginBottom={1}>
            <text color={theme.stale}>
              Full-text search unavailable — showing recent contributions.
            </text>
          </box>
        )}

        {contributions.length === 0 && !isInputMode && searchQuery && !showSearchUnavailable ? (
          <EmptyState
            title={`No results for "${searchQuery}".`}
            hint="Try a different query or press / to search again."
          />
        ) : (
          <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
        )}
      </box>
    );
  },
);
