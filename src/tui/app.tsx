/**
 * Root TUI application component.
 *
 * Manages navigation state, routes to views, and wires up keybindings.
 * Uses a tab bar + push/pop detail architecture (k9s-style).
 */

import { Box, useApp } from "ink";
import React, { useCallback } from "react";
import type { Contribution } from "../core/models.js";
import { StatusBar } from "./components/status-bar.js";
import { TabBar } from "./components/tab-bar.js";
import { useKeybindings } from "./hooks/use-keybindings.js";
import { Tab, useNavigation } from "./hooks/use-navigation.js";
import type { TuiDataProvider } from "./provider.js";
import { ActivityView } from "./views/activity.js";
import { ClaimsView } from "./views/claims.js";
import { DagView } from "./views/dag.js";
import { DashboardView } from "./views/dashboard.js";
import { DetailView } from "./views/detail.js";

type ContributionsCallback = (contributions: readonly Contribution[]) => void;

/** Props for the root App component. */
export interface AppProps {
  readonly provider: TuiDataProvider;
  /** Polling interval in milliseconds. */
  readonly intervalMs: number;
}

const PAGE_SIZE = 20;

/** Root TUI application. */
export function App({ provider, intervalMs }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const nav = useNavigation();

  // Track contributions for drill-down (resolve cursor → CID)
  const [contributionList, setContributionList] = React.useState<readonly Contribution[]>([]);

  // Track row count separately — views that don't support drill-down (Claims)
  // still report their row count so j/k cursor navigation works.
  const [rowCount, setRowCount] = React.useState(0);

  // Refresh counter — incrementing forces a remount of ActiveView
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Claims tab has no contribution drill-down
  const isClaimsTab = nav.state.activeTab === Tab.Claims;

  const handleContributionsLoaded = useCallback((contributions: readonly Contribution[]) => {
    setContributionList(contributions);
    setRowCount(contributions.length);
  }, []);

  const handleRowCountChanged = useCallback((count: number) => {
    setRowCount(count);
  }, []);

  const handleSelect = useCallback(
    (index: number) => {
      const contribution = contributionList[index];
      if (contribution) {
        nav.pushDetail(contribution.cid);
      }
    },
    [contributionList, nav],
  );

  const handleQuit = useCallback(() => {
    provider.close();
    exit();
  }, [provider, exit]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // For pagination: always allow advancing if the current page is full.
  // An empty next page is handled gracefully by ActivityView.
  const hasFullPage = rowCount >= PAGE_SIZE;
  const totalItems = hasFullPage
    ? nav.state.pageOffset + rowCount + 1
    : nav.state.pageOffset + rowCount;

  useKeybindings({
    nav,
    listLength: rowCount,
    onSelect: nav.isDetailView || isClaimsTab ? undefined : handleSelect,
    onQuit: handleQuit,
    onRefresh: handleRefresh,
    pageSize: PAGE_SIZE,
    totalItems,
  });

  // If we're in a detail view, show the detail
  if (nav.isDetailView && nav.detailCid) {
    return (
      <Box flexDirection="column" width="100%">
        <TabBar activeTab={nav.state.activeTab} />
        <Box flexDirection="column" flexGrow={1} marginTop={1}>
          <DetailView provider={provider} cid={nav.detailCid} intervalMs={intervalMs} />
        </Box>
        <StatusBar isDetailView />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <TabBar activeTab={nav.state.activeTab} />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <ActiveView
          key={refreshKey}
          tab={nav.state.activeTab}
          provider={provider}
          intervalMs={intervalMs}
          cursor={nav.state.cursor}
          pageOffset={nav.state.pageOffset}
          pageSize={PAGE_SIZE}
          onContributionsLoaded={handleContributionsLoaded}
          onRowCountChanged={handleRowCountChanged}
        />
      </Box>
      <StatusBar isDetailView={false} />
    </Box>
  );
}

/** Props for the view router. */
interface ActiveViewProps {
  readonly tab: Tab;
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly cursor: number;
  readonly pageOffset: number;
  readonly pageSize: number;
  readonly onContributionsLoaded: ContributionsCallback;
  readonly onRowCountChanged: (count: number) => void;
}

/**
 * Routes to the active tab's view component.
 * Only the active view polls; others are unmounted to save resources.
 */
const ActiveView = React.memo(function ActiveView({
  tab,
  provider,
  intervalMs,
  cursor,
  pageOffset,
  pageSize,
  onContributionsLoaded,
  onRowCountChanged,
}: ActiveViewProps): React.ReactElement {
  switch (tab) {
    case Tab.Dashboard:
      return (
        <DashboardView
          provider={provider}
          intervalMs={intervalMs}
          active
          cursor={cursor}
          onContributionsLoaded={onContributionsLoaded}
        />
      );
    case Tab.Dag:
      return (
        <DagView
          provider={provider}
          intervalMs={intervalMs}
          active
          cursor={cursor}
          onContributionsLoaded={onContributionsLoaded}
        />
      );
    case Tab.Claims:
      return (
        <ClaimsView
          provider={provider}
          intervalMs={intervalMs}
          active
          cursor={cursor}
          onRowCountChanged={onRowCountChanged}
        />
      );
    case Tab.Activity:
      return (
        <ActivityView
          provider={provider}
          intervalMs={intervalMs}
          active
          cursor={cursor}
          pageOffset={pageOffset}
          pageSize={pageSize}
          onContributionsLoaded={onContributionsLoaded}
        />
      );
  }
});
