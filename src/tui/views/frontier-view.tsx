/**
 * Frontier view — displays the multi-signal frontier ranking table.
 *
 * Shows frontier entries from all dimensions (byMetric, byAdoption,
 * byRecency, byReviewScore, byReproduction) as a flat ranked table.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { Frontier, FrontierEntry } from "../../core/frontier.js";
import { truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

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

const COLUMNS = [
  { header: "RANK", key: "rank", width: 6, align: "right" as const },
  { header: "CID", key: "cid", width: 22 },
  { header: "METRIC", key: "metric", width: 16 },
  { header: "VALUE", key: "value", width: 12, align: "right" as const },
  { header: "SUMMARY", key: "summary", width: 36 },
] as const;

/** Flatten a Frontier into ranked rows for table display. */
function flattenFrontier(frontier: Frontier): readonly FrontierRow[] {
  const rows: FrontierRow[] = [];

  // byMetric entries (one section per metric name)
  for (const [metricName, entries] of Object.entries(frontier.byMetric)) {
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

  // byAdoption
  for (let i = 0; i < frontier.byAdoption.length; i++) {
    const entry = frontier.byAdoption[i] as FrontierEntry;
    rows.push({
      rank: i + 1,
      cid: entry.cid,
      metric: "adoption",
      value: entry.value,
      summary: entry.summary,
    });
  }

  // byRecency
  for (let i = 0; i < frontier.byRecency.length; i++) {
    const entry = frontier.byRecency[i] as FrontierEntry;
    rows.push({
      rank: i + 1,
      cid: entry.cid,
      metric: "recency",
      value: entry.value,
      summary: entry.summary,
    });
  }

  // byReviewScore
  for (let i = 0; i < frontier.byReviewScore.length; i++) {
    const entry = frontier.byReviewScore[i] as FrontierEntry;
    rows.push({
      rank: i + 1,
      cid: entry.cid,
      metric: "review",
      value: entry.value,
      summary: entry.summary,
    });
  }

  // byReproduction
  for (let i = 0; i < frontier.byReproduction.length; i++) {
    const entry = frontier.byReproduction[i] as FrontierEntry;
    rows.push({
      rank: i + 1,
      cid: entry.cid,
      metric: "reproduction",
      value: entry.value,
      summary: entry.summary,
    });
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

    // Report frontier CIDs to parent for cursor-to-CID resolution
    const frontierCids = useMemo(() => flatRows.map((r) => r.cid), [flatRows]);
    useEffect(() => {
      if (onFrontierCidsChanged) {
        onFrontierCidsChanged(frontierCids);
      }
    }, [frontierCids, onFrontierCidsChanged]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading frontier...</text>
        </box>
      );
    }

    const tableRows = flatRows.map((r) => {
      const isSelected = compareMode && selectedSet.has(r.cid);
      const prefix = compareMode ? (isSelected ? "[*] " : "[ ] ") : "";
      return {
        rank: String(r.rank),
        cid: `${prefix}${truncateCid(r.cid)}`,
        metric: r.metric,
        value: formatValue(r.value),
        summary: r.summary.length > 36 ? `${r.summary.slice(0, 34)}..` : r.summary,
      };
    });

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Frontier Rankings</text>
          {compareMode && <text color="#ff6600"> [COMPARE]</text>}
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          {flatRows.length > 0 ? (
            <text opacity={0.5}>
              {"  "}
              {String(flatRows.length)} entries
            </text>
          ) : null}
        </box>
        <Table columns={[...COLUMNS]} rows={tableRows} cursor={cursor} />
      </box>
    );
  },
);
