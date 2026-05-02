/**
 * Frontier view — displays the multi-signal frontier ranking table.
 *
 * Shows frontier entries from all dimensions (byMetric, byAdoption,
 * byRecency, byReviewScore, byReproduction) as a flat ranked table.
 *
 * PR3 (#389): Frontier itself is server-computed (scoring + ranking) and
 * does not flow through the watch protocol, so the data source remains
 * `usePolledData(getFrontier)`. We layer `useDerived` over the projection
 * step so the flattened ranking memoizes against the Contribution informer
 * — recomputes happen only on Contribution events and equality is
 * structural. We also kick a polled refresh on Contribution events so the
 * underlying Frontier doesn't lag the cache by an interval.
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { Frontier, FrontierEntry } from "../../core/frontier.js";
import { truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
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
  /** Display label for the section header. */
  readonly metric: string;
  /** Stable grouping key — avoids collisions between user score names and built-in scalars. */
  readonly dimensionKey: string;
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
        dimensionKey: `score:${metricName}`,
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
      const entry = entries?.[i] as FrontierEntry;
      rows.push({
        rank: i + 1,
        cid: entry.cid,
        metric,
        dimensionKey: `scalar:${metric}`,
        value: entry.value,
        summary: entry.summary,
      });
    }
  }

  return rows;
}

/** Structural equality across the flattened-frontier projection. Used as the
 *  `equals` for `useDerived` so a recompute that produces the same ranks +
 *  values + summaries doesn't trigger a re-render. */
export function flatRowsEqual(a: readonly FrontierRow[], b: readonly FrontierRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i] as FrontierRow;
    const rb = b[i] as FrontierRow;
    if (
      ra.rank !== rb.rank ||
      ra.cid !== rb.cid ||
      ra.metric !== rb.metric ||
      ra.dimensionKey !== rb.dimensionKey ||
      ra.value !== rb.value ||
      ra.summary !== rb.summary
    ) {
      return false;
    }
  }
  return true;
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

    // Race guard for getFrontier(): on a relist or burst, multiple refresh()
    // calls fan out concurrent fetches. Without sequencing, a slower-older
    // response can land after a newer one and overwrite fresh data with
    // stale. Track the latest in-flight promise; older fetches (success OR
    // rejection) defer to the newer's eventual outcome so dispatch order
    // doesn't matter.
    const latestFetchRef = useRef<Promise<Frontier> | null>(null);
    const fetcher = useCallback(async (): Promise<Frontier> => {
      const p = provider.getFrontier();
      latestFetchRef.current = p;
      try {
        const result = await p;
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) {
          // A newer fetch superseded ours — return its eventual value so we
          // never dispatch stale data over fresh state.
          return await newest;
        }
        return result;
      } catch (err) {
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) {
          // Stale rejection; the newer request is authoritative. Returning
          // the newer's value (or rethrowing its rejection) keeps the dispatch
          // path consistent with the latest known result.
          return await newest;
        }
        throw err;
      }
    }, [provider]);
    const { data, loading, isStale, error, refresh } = usePolledData<Frontier>(
      fetcher,
      intervalMs,
      active,
    );

    // Coalesce Contribution-driven refreshes. During an initial relist the
    // informer dispatches one ADDED per entity, which without debounce would
    // produce N+1 frontier fetches and hammer the server-computed endpoint.
    // We subscribe only to event (not sync): events already fire for every
    // entity, and the polled cadence covers the rare empty-relist case.
    const useInformerPath = useEntityWatchEnabled(provider, "Contribution");
    const contribInformer = useInformerOptional("Contribution");
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
      if (!useInformerPath) return;
      const handler = (): void => {
        if (refreshTimerRef.current !== null) return;
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          const p = provider as { invalidateCaches?: () => void };
          p.invalidateCaches?.();
          refresh();
        }, 100);
      };
      const unsubEvent = contribInformer.addEventHandler(handler);
      return () => {
        unsubEvent();
        if (refreshTimerRef.current !== null) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      };
    }, [useInformerPath, contribInformer, provider, refresh]);

    // Project the Frontier to flat rows via useDerived so the flattening
    // memoizes against the Contribution kind. compute() reads `data` via
    // closure; the kind subscription drives recompute on contribution
    // events; flatRowsEqual() collapses no-op recomputes.
    const dataRef = useRef<Frontier | null>(data);
    dataRef.current = data;
    const derivedRows = useDerived<readonly FrontierRow[]>(
      () => (dataRef.current ? flattenFrontier(dataRef.current).slice(0, 200) : []),
      ["Contribution"],
      flatRowsEqual,
    );
    // The polled snapshot can change without a contribution event firing
    // (interval tick), so we re-derive against `data` directly too — the
    // memoized result is stable as long as the rows match.
    const flatRows = useMemo<readonly FrontierRow[]>(() => {
      if (!data) return derivedRows.data ?? [];
      const fresh = flattenFrontier(data).slice(0, 200);
      const cached = derivedRows.data;
      return cached && flatRowsEqual(cached, fresh) ? cached : fresh;
    }, [data, derivedRows.data]);

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

    // Build display rows and group them by dimension in one pass.
    // Must be before any early returns to satisfy Rules of Hooks.
    const { tableRows, dimensionGroups } = useMemo(() => {
      const rows: Array<{
        rank: string;
        cid: string;
        metric: string;
        value: string;
        summary: string;
      }> = [];
      const groups = new Map<string, { startIndex: number; count: number; label: string }>();

      for (let i = 0; i < flatRows.length; i++) {
        const r = flatRows[i];
        if (!r) continue;
        const isSelected = compareMode && selectedSet.has(r.cid);
        const prefix = compareMode ? (isSelected ? "[*] " : "[ ] ") : "";
        rows.push({
          rank: String(r.rank),
          cid: `${prefix}${truncateCid(r.cid)}`,
          metric: r.metric,
          value: formatValue(r.value),
          summary: r.summary.length > 40 ? `${r.summary.slice(0, 38)}..` : r.summary,
        });
        if (!groups.has(r.dimensionKey)) {
          groups.set(r.dimensionKey, { startIndex: i, count: 0, label: r.metric });
        }
        const group = groups.get(r.dimensionKey);
        if (group) group.count++;
      }

      return { tableRows: rows, dimensionGroups: groups };
    }, [flatRows, compareMode, selectedSet]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading frontier...</text>
        </box>
      );
    }

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
            {[...dimensionGroups.entries()].map(([dimKey, { startIndex, count, label }]) => {
              const groupRows = tableRows.slice(startIndex, startIndex + count);
              // Map global cursor to per-group cursor (-1 = not in this group)
              const groupCursor = cursor - startIndex;
              const validGroupCursor =
                groupCursor >= 0 && groupCursor < count ? groupCursor : undefined;

              return (
                <box key={dimKey} flexDirection="column" marginBottom={1}>
                  <text color={theme.secondary}>{`── ${label} (${count}) ──`}</text>
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
