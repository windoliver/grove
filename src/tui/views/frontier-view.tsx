/**
 * Frontier view — displays the multi-signal frontier ranking table.
 *
 * Shows frontier entries from all dimensions (byMetric, byAdoption,
 * byRecency, byReviewScore, byReproduction) as a flat ranked table.
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { Frontier, FrontierEntry } from "../../core/frontier.js";
import { truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the FrontierView component. */
export interface FrontierViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  /** When true, the view is in compare mode and allows multi-select. */
  readonly compareMode?: boolean | undefined;
  /** Callback when a CID is selected/deselected in compare mode. */
  readonly onCompareSelect?: ((cid: string) => void) | undefined;
  /** Currently selected CIDs for comparison (controlled from parent). */
  readonly compareCids?: readonly string[] | undefined;
  /** Reports the ordered CID list so the parent can resolve cursor to CID. */
  readonly onFrontierCidsChanged?: ((cids: readonly string[]) => void) | undefined;
}

/** A flattened frontier row combining entry data with its ranking dimension. */
interface FrontierRow {
  readonly rank: number;
  readonly cid: string;
  readonly metric: string;
  readonly value: number;
  readonly summary: string;
}

/** Columns for the per-dimension grouped table (METRIC omitted — shown as section header). */
const COLUMNS = [
  { header: "RANK", key: "rank", width: 6, align: "right" as const },
  { header: "CID", key: "cid", width: 22 },
  { header: "VALUE", key: "value", width: 10, align: "right" as const },
  { header: "SUMMARY", key: "summary", width: 40 },
] as const;

/** Flatten a Frontier into ranked rows for table display. */
function flattenFrontier(frontier: Frontier): readonly FrontierRow[] {
  const rows: FrontierRow[] = [];

  // byMetric entries (one section per metric name)
  for (const [metricName, entries] of Object.entries(frontier.byMetric ?? {})) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as FrontierEntry;
      rows.push({
        rank: i + 1,
        cid: entry.cid,
        metric: metricName,
        value: entry.value,
        summary: entry.summary,
      });
    }
  }

  // Scalar dimensions — table-driven to avoid 4 near-identical loops.
  const SCALAR_DIMS: ReadonlyArray<readonly [string, readonly FrontierEntry[] | undefined]> = [
    ["adoption", frontier.byAdoption],
    ["recency", frontier.byRecency],
    ["review", frontier.byReviewScore],
    ["reproduction", frontier.byReproduction],
  ];
  for (const [metric, entries] of SCALAR_DIMS) {
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const entry = entries![i] as FrontierEntry;
      rows.push({ rank: i + 1, cid: entry.cid, metric, value: entry.value, summary: entry.summary });
    }
  }

  return rows;
}

/** Format a numeric value for display (handles large timestamps, decimals, etc.). */
function formatValue(value: number): string {
  if (Number.isInteger(value) && value > 1_000_000_000_000) {
    // Looks like a timestamp — show relative
    const diff = Date.now() - value;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${String(seconds)}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${String(hours)}h ago`;
    const days = Math.floor(hours / 24);
    return `${String(days)}d ago`;
  }
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

/** Frontier ranking view component. */
export const FrontierView: React.NamedExoticComponent<FrontierViewProps> = React.memo(
  function FrontierView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
    compareMode,
    onCompareSelect,
    compareCids,
    onFrontierCidsChanged,
  }: FrontierViewProps): React.ReactNode {
    // onCompareSelect is part of the interface for parent coordination;
    // Enter-key handling that calls it lives in app.tsx.
    void onCompareSelect;

    const fetcher = useCallback(() => provider.getFrontier(), [provider]);
    const { data, loading, isStale, error } = usePolledData<Frontier>(fetcher, intervalMs, active);

    const flatRows = useMemo(() => (data ? flattenFrontier(data) : []), [data]);

    // Track selected CIDs set for efficient lookup
    const selectedSet = useMemo(() => new Set(compareCids ?? []), [compareCids]);

    useEffect(() => {
      if (onRowCountChanged) {
        onRowCountChanged(flatRows.length);
      }
    }, [flatRows.length, onRowCountChanged]);

    // Report frontier CIDs to parent for cursor-to-CID resolution.
    // Guard against spurious calls when poll returns identical CIDs.
    const frontierCids = useMemo(() => flatRows.map((r) => r.cid), [flatRows]);
    const prevFrontierCidsRef = useRef<readonly string[] | null>(null);
    useEffect(() => {
      if (!onFrontierCidsChanged) return;
      const prev = prevFrontierCidsRef.current;
      if (
        prev !== null &&
        prev.length === frontierCids.length &&
        prev.every((cid, i) => cid === frontierCids[i])
      ) {
        return;
      }
      prevFrontierCidsRef.current = frontierCids;
      onFrontierCidsChanged(frontierCids);
    }, [frontierCids, onFrontierCidsChanged]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading frontier...</text>
        </box>
      );
    }

    // Build display rows and group them by dimension in one pass.
    const { tableRows, dimensionGroups } = useMemo(() => {
      const rows: Array<{
        rank: string;
        cid: string;
        metric: string;
        value: string;
        summary: string;
      }> = [];
      const groups = new Map<string, { startIndex: number; count: number }>();

      for (let i = 0; i < flatRows.length; i++) {
        const r = flatRows[i]!;
        const isSelected = compareMode && selectedSet.has(r.cid);
        const prefix = compareMode ? (isSelected ? "[*] " : "[ ] ") : "";
        rows.push({
          rank: String(r.rank),
          cid: `${prefix}${truncateCid(r.cid)}`,
          metric: r.metric,
          value: formatValue(r.value),
          summary: r.summary.length > 40 ? `${r.summary.slice(0, 38)}..` : r.summary,
        });
        if (!groups.has(r.metric)) {
          groups.set(r.metric, { startIndex: i, count: 0 });
        }
        groups.get(r.metric)!.count++;
      }

      return { tableRows: rows, dimensionGroups: groups };
    }, [flatRows, compareMode, selectedSet]);

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Frontier Rankings</text>
          {compareMode && <text color={theme.compare}> [COMPARE]</text>}
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          {flatRows.length > 0 ? (
            <text opacity={0.5}>
              {"  "}
              {String(flatRows.length)} entries across {String(dimensionGroups.size)} dimensions
            </text>
          ) : null}
        </box>

        {tableRows.length === 0 ? (
          <EmptyState
            title="Ranked leaderboard of best contributions."
            hint="Rankings appear as agents publish scored work. Spawn agents with Ctrl+P to begin."
          />
        ) : (
          <box flexDirection="column">
            {[...dimensionGroups.entries()].map(([metric, { startIndex, count }]) => {
              const groupRows = tableRows.slice(startIndex, startIndex + count);
              // Map global cursor to per-group cursor (-1 = not in this group)
              const groupCursor = cursor - startIndex;
              const validGroupCursor =
                groupCursor >= 0 && groupCursor < count ? groupCursor : undefined;

              return (
                <box key={metric} flexDirection="column" marginBottom={1}>
                  <text color={theme.secondary}>{`── ${metric} (${count}) ──`}</text>
                  <Table columns={[...COLUMNS]} rows={groupRows} cursor={validGroupCursor} />
                </box>
              );
            })}
          </box>
        )}
      </box>
    );
  },
);
