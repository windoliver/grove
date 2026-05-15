/**
 * Frontier view — orchestrator.
 *
 * Owns Frontier fetch (race-guarded), Contribution-event refresh
 * coalescing, tab state, per-slice cursor map, and the active-slice
 * cid list reported to the parent for cursor → cid resolution.
 *
 * Layout: tab bar (Overview + one tab per non-empty slice) on top, then
 * either FrontierOverview (Overview tab) or FrontierSliceTable (slice tab).
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { Frontier } from "../../core/frontier.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { useEntityWatchEnabled, useInformerOptional } from "../hooks/informer-context.js";
import { useDerived } from "../hooks/use-derived.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";
import { FrontierOverview } from "./frontier-overview.js";
import { FrontierSliceTable } from "./frontier-slice-table.js";
import type { FrontierSlice } from "./frontier-slices.js";
import { slicesEqual, toSlices } from "./frontier-slices.js";
import { FrontierTabBar } from "./frontier-tab-bar.js";

const OVERVIEW_KEY = "overview";
const OVERVIEW_LABEL = "overview";

export interface FrontierViewProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  readonly compareMode?: boolean | undefined;
  readonly onCompareSelect?: ((cid: string) => void) | undefined;
  readonly compareCids?: readonly string[] | undefined;
  readonly onFrontierCidsChanged?: ((cids: readonly string[]) => void) | undefined;
  /** Active slice key (controlled by parent so keyboard handler can change it). */
  readonly activeSliceKey?: string | undefined;
  /** Reports the ordered list of slice keys back to the parent for tab navigation. */
  readonly onFrontierTabsChanged?: ((keys: readonly string[]) => void) | undefined;
  /** Reports {cid, summary} for the active slice so app.tsx can wire adopt without
   *  a separate contributionList lookup (Frontier may surface cids not in that list). */
  readonly onFrontierEntriesChanged?:
    | ((entries: ReadonlyArray<{ cid: string; summary: string }>) => void)
    | undefined;
}

export const FrontierView: React.NamedExoticComponent<FrontierViewProps> = React.memo(
  function FrontierView({
    provider,
    cursor,
    onRowCountChanged,
    compareMode,
    onCompareSelect,
    compareCids,
    onFrontierCidsChanged,
    activeSliceKey,
    onFrontierTabsChanged,
    onFrontierEntriesChanged,
  }: FrontierViewProps): React.ReactNode {
    void onCompareSelect;

    const latestFetchRef = useRef<Promise<Frontier> | null>(null);
    const fetcher = useCallback(async (): Promise<Frontier> => {
      const p = provider.getFrontier();
      latestFetchRef.current = p;
      try {
        const result = await p;
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) return await newest;
        return result;
      } catch (err) {
        const newest = latestFetchRef.current;
        if (newest !== p && newest !== null) return await newest;
        throw err;
      }
    }, [provider]);
    const { data, loading, isStale, error, refresh } = useEventDrivenData<Frontier>(
      fetcher,
      undefined,
      undefined,
      true,
    );

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
      const unsub = contribInformer.addEventHandler(handler);
      return () => {
        unsub();
        if (refreshTimerRef.current !== null) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      };
    }, [useInformerPath, contribInformer, provider, refresh]);

    const dataRef = useRef<Frontier | null>(data);
    dataRef.current = data;
    const derived = useDerived<readonly FrontierSlice[]>(
      () => (dataRef.current ? toSlices(dataRef.current) : []),
      ["Contribution"],
      slicesEqual,
    );
    const slices = useMemo<readonly FrontierSlice[]>(() => {
      if (!data) return derived.data ?? [];
      const fresh = toSlices(data);
      const cached = derived.data;
      return cached && slicesEqual(cached, fresh) ? cached : fresh;
    }, [data, derived.data]);

    const allTabs = useMemo(
      () => [
        { key: OVERVIEW_KEY, label: OVERVIEW_LABEL },
        ...slices.map((s) => ({ key: s.key, label: s.label })),
      ],
      [slices],
    );
    const tabKeys = useMemo(() => allTabs.map((t) => t.key), [allTabs]);

    const prevTabKeysRef = useRef<readonly string[] | null>(null);
    useEffect(() => {
      if (!onFrontierTabsChanged) return;
      const prev = prevTabKeysRef.current;
      if (prev !== null && prev.length === tabKeys.length && prev.every((k, i) => k === tabKeys[i]))
        return;
      prevTabKeysRef.current = tabKeys;
      onFrontierTabsChanged(tabKeys);
    }, [tabKeys, onFrontierTabsChanged]);

    const resolvedActiveKey = useMemo(() => {
      const requested = activeSliceKey ?? OVERVIEW_KEY;
      return tabKeys.includes(requested) ? requested : OVERVIEW_KEY;
    }, [activeSliceKey, tabKeys]);

    const activeSlice = useMemo<FrontierSlice | undefined>(
      () =>
        resolvedActiveKey === OVERVIEW_KEY
          ? undefined
          : slices.find((s) => s.key === resolvedActiveKey),
      [resolvedActiveKey, slices],
    );

    const activeEntries = useMemo<ReadonlyArray<{ cid: string; summary: string }>>(
      () =>
        activeSlice ? activeSlice.entries.map((e) => ({ cid: e.cid, summary: e.summary })) : [],
      [activeSlice],
    );
    const activeCids = useMemo<readonly string[]>(
      () => activeEntries.map((e) => e.cid),
      [activeEntries],
    );
    const prevActiveCidsRef = useRef<readonly string[] | null>(null);
    useEffect(() => {
      if (!onFrontierCidsChanged) return;
      const prev = prevActiveCidsRef.current;
      if (
        prev !== null &&
        prev.length === activeCids.length &&
        prev.every((c, i) => c === activeCids[i])
      )
        return;
      prevActiveCidsRef.current = activeCids;
      onFrontierCidsChanged(activeCids);
    }, [activeCids, onFrontierCidsChanged]);

    const prevActiveEntriesRef = useRef<ReadonlyArray<{ cid: string; summary: string }> | null>(
      null,
    );
    useEffect(() => {
      if (!onFrontierEntriesChanged) return;
      const prev = prevActiveEntriesRef.current;
      if (
        prev !== null &&
        prev.length === activeEntries.length &&
        prev.every(
          (e, i) => e.cid === activeEntries[i]?.cid && e.summary === activeEntries[i]?.summary,
        )
      ) {
        return;
      }
      prevActiveEntriesRef.current = activeEntries;
      onFrontierEntriesChanged(activeEntries);
    }, [activeEntries, onFrontierEntriesChanged]);

    // Frontier is a core panel that stays mounted in grid layout even when
    // another panel is focused. The app-level rowCount is shared across
    // panels, so emitting our count when we're NOT focused would clobber
    // the focused panel's nav bounds. cursor === -1 is the panel-manager's
    // signal that we're unfocused (see panel-manager.tsx FrontierView wiring).
    useEffect(() => {
      if (!onRowCountChanged) return;
      if (cursor < 0) return;
      onRowCountChanged(activeCids.length);
    }, [activeCids.length, onRowCountChanged, cursor]);

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading frontier...</text>
        </box>
      );
    }

    const totalEntries = slices.reduce((acc, s) => acc + s.entries.length, 0);

    if (totalEntries === 0) {
      return (
        <box flexDirection="column">
          <box marginBottom={1} flexDirection="row">
            <text>Frontier Rankings</text>
            {compareMode ? <text color={theme.compare}> [COMPARE]</text> : null}
            <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          </box>
          <EmptyState
            title="Frontier ranks the best contributions across multiple signals."
            hint={
              "Signals: adoption, recency, review, reproduction, plus per-metric scores.\n" +
              "Spawn agents with Ctrl+P to begin."
            }
          />
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Frontier Rankings</text>
          {compareMode ? <text color={theme.compare}> [COMPARE]</text> : null}
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {String(totalEntries)} entries across {String(slices.length)} signals
          </text>
        </box>
        <box marginBottom={1}>
          <FrontierTabBar tabs={allTabs} activeKey={resolvedActiveKey} disabled={false} />
        </box>
        {resolvedActiveKey === OVERVIEW_KEY ? (
          <FrontierOverview slices={slices} />
        ) : activeSlice ? (
          <FrontierSliceTable
            slice={activeSlice}
            cursor={cursor >= 0 && cursor < activeSlice.entries.length ? cursor : undefined}
            compareMode={compareMode}
            compareCids={compareCids}
          />
        ) : null}
      </box>
    );
  },
);
