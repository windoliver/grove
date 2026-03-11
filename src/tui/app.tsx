/**
 * Root TUI application component.
 *
 * Manages navigation state, routes to views, and wires up keybindings.
 * Uses a tab bar + push/pop detail architecture (k9s-style).
 */

import { Box, useApp } from "ink";
import React, { useCallback, useEffect, useRef } from "react";
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

  // Clear stale contribution list when switching to Claims (no drill-down there)
  const prevTabRef = useRef(nav.state.activeTab);
  useEffect(() => {
    if (nav.state.activeTab !== prevTabRef.current) {
      prevTabRef.current = nav.state.activeTab;
      if (nav.state.activeTab === Tab.Claims) {
        setContributionList([]);
      }
    }
  }, [nav.state.activeTab]);

  // Claims tab has no contribution drill-down
  const isClaimsTab = nav.state.activeTab === Tab.Claims;

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

  // Estimate list length for keybinding bounds
  const listLength = contributionList.length;

  // For pagination: if the current page is full, assume more items exist.
  // This avoids needing a count() API — nextPage will simply fetch an empty page
  // if there are no more results, which is a graceful no-op.
  const hasFullPage = listLength >= PAGE_SIZE;
  const totalItems = hasFullPage ? nav.state.pageOffset + listLength + 1 : nav.state.pageOffset + listLength;

  useKeybindings({
    nav,
    listLength,
    onSelect: nav.isDetailView || isClaimsTab ? undefined : handleSelect,
    onQuit: handleQuit,
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
          tab={nav.state.activeTab}
          provider={provider}
          intervalMs={intervalMs}
          cursor={nav.state.cursor}
          pageOffset={nav.state.pageOffset}
          pageSize={PAGE_SIZE}
          onContributionsLoaded={setContributionList}
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
      return <ClaimsView provider={provider} intervalMs={intervalMs} active cursor={cursor} />;
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
