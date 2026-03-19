/**
 * Panel manager — data-driven multi-panel layout for the agent command center.
 *
 * Supports two layout modes:
 * - **grid**: multi-panel rows, driven by the panel registry.
 * - **tab**: single focused panel, full-screen.
 *
 * Layout (grid mode):
 * +-  DAG  ------------------+- Detail ----------------+
 * |                          |                         |
 * +- Frontier ---------------+                         |
 * |                          |                         |
 * +- Claims -----------------+-------------------------+
 * |                                                    |
 * +----------------------------------------------------+
 *
 * With operator panels visible, they appear below:
 * +- Agents ----------------+- Terminal ---------------+
 */

import React, { useCallback } from "react";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { AgentSplitPane } from "../components/agent-split-pane.js";
import type { NavigationActions } from "../hooks/use-navigation.js";
import type { PanelFocusState } from "../hooks/use-panel-focus.js";
import { isPanelVisible, PANEL_LABELS, Panel } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ContributionDetail, TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";
import { ActivityPanelView } from "../views/activity-panel.js";
import { AgentGraphView } from "../views/agent-graph.js";
import { AgentListView } from "../views/agent-list.js";
import { ArtifactPreviewView } from "../views/artifact-preview.js";
import { BountiesPanelView } from "../views/bounties-panel.js";
import { ClaimsView } from "../views/claims.js";
import { CompareView } from "../views/compare-view.js";
import { DagView } from "../views/dag.js";
import { DashboardView } from "../views/dashboard.js";
import { DecisionsPanelView } from "../views/decisions-panel.js";
import { DetailView } from "../views/detail.js";
import { FrontierView } from "../views/frontier-view.js";
import { GitHubPanelView } from "../views/github-panel.js";
import { GossipPanelView } from "../views/gossip-panel.js";
import { InboxPanelView } from "../views/inbox-panel.js";
import { OutcomesPanelView } from "../views/outcomes-panel.js";
import { PipelineView } from "../views/pipeline-view.js";
import { PlanPanelView } from "../views/plan-panel.js";
import { SearchPanelView } from "../views/search-panel.js";
import { TerminalView } from "../views/terminal.js";
import { ThreadsPanelView } from "../views/threads-panel.js";
import { VfsBrowserView } from "../views/vfs-browser.js";

import {
  getPresetPanels,
  getRowFlex,
  getRowGroups,
  isRowVisible,
  type LayoutMode,
  panelRowGroup,
  type ZoomLevel,
} from "./panel-registry.js";

// Re-export for backwards compatibility
export type { ZoomLevel, LayoutMode };

/** Props for the PanelManager component. */
export interface PanelManagerProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly panelState: PanelFocusState;
  readonly nav: NavigationActions;
  readonly onContributionsLoaded: (contributions: readonly Contribution[]) => void;
  readonly onRowCountChanged: (count: number) => void;
  readonly pageSize: number;
  readonly tmux?: TmuxManager | undefined;
  readonly selectedSession?: string | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
  /** Incremented when Enter pressed in VFS panel; triggers directory navigation. */
  readonly vfsNavigateTrigger?: number | undefined;
  /** Index into the artifact names list for the Artifact panel. */
  readonly artifactIndex?: number | undefined;
  /** Whether to show diff view in the Artifact panel. */
  readonly showArtifactDiff?: boolean | undefined;
  /** Pre-fetched active claims from the parent poller (avoids double polling). */
  readonly activeClaims?: readonly import("../../core/models.js").Claim[] | undefined;
  /** Current search query for the Search panel. */
  readonly searchQuery?: string | undefined;
  /** Whether the Search panel is in input mode. */
  readonly isSearchInputMode?: boolean | undefined;
  /** Whether compare mode is active in the Frontier panel. */
  readonly compareMode?: boolean | undefined;
  /** CIDs selected for comparison. */
  readonly compareCids?: readonly string[] | undefined;
  /** Callback when a CID is selected/deselected in compare mode. */
  readonly onCompareSelect?: ((cid: string) => void) | undefined;
  /** Reports the ordered CID list from the frontier view. */
  readonly onFrontierCidsChanged?: ((cids: readonly string[]) => void) | undefined;
  /** Current zoom level. */
  readonly zoomLevel?: ZoomLevel | undefined;
  /** Active tmux sessions for split pane view. */
  readonly activeSessions?: readonly string[] | undefined;
  /** Terminal scroll offset for pinned scrollback (item 9). */
  readonly terminalScrollOffset?: number | undefined;
  /** Terminal output buffers for cross-agent transcript search (item 17). */
  readonly terminalBuffers?: ReadonlyMap<string, string> | undefined;
  /** Layout mode: grid (default multi-panel) or tab (single focused panel). */
  readonly layoutMode?: LayoutMode | undefined;
  /** Preset name — used for per-preset panel visibility filtering. */
  readonly presetName?: string | undefined;
}

/** Wraps a panel view with a titled border and focus indication. */
function PanelChrome({
  panel,
  focused,
  children,
}: {
  readonly panel: Panel;
  readonly focused: boolean;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const borderColor = focused ? theme.focus : theme.inactive;
  const titleColor = focused ? theme.focus : theme.muted;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      border
      borderStyle="round"
      borderColor={borderColor}
    >
      <box>
        <text color={titleColor} bold={focused}>
          {` ${PANEL_LABELS[panel]} `}
        </text>
      </box>
      {children}
    </box>
  );
}

/** Multi-panel layout (grid or tab mode). */
export const PanelManager: React.NamedExoticComponent<PanelManagerProps> = React.memo(
  function PanelManager({
    provider,
    intervalMs,
    panelState,
    nav,
    onContributionsLoaded,
    onRowCountChanged,
    pageSize,
    tmux,
    selectedSession,
    topology,
    onSelectSession,
    vfsNavigateTrigger,
    artifactIndex,
    showArtifactDiff,
    activeClaims,
    searchQuery,
    isSearchInputMode,
    compareMode,
    compareCids,
    onCompareSelect,
    onFrontierCidsChanged,
    zoomLevel,
    activeSessions,
    terminalScrollOffset,
    terminalBuffers,
    layoutMode,
    presetName,
  }: PanelManagerProps): React.ReactNode {
    const isFocused = (p: Panel) => panelState.focused === p;
    const zoom = zoomLevel ?? "normal";
    const mode = layoutMode ?? "grid";

    // Suppress unused variable warnings for props used by other panel configurations
    void pageSize;

    const focusedRowGroup = panelRowGroup(panelState.focused);
    const allowedPanels = getPresetPanels(presetName);

    // If detail view is active, show it in the Detail panel
    const showDetail = nav.isDetailView && nav.detailCid;

    // Fetch contribution detail to resolve the first artifact name
    const detailCid = nav.detailCid;
    const detailFetcher = useCallback(
      () => (detailCid ? provider.getContribution(detailCid) : Promise.resolve(undefined)),
      [provider, detailCid],
    );
    const { data: detailData } = usePolledData<ContributionDetail | undefined>(
      detailFetcher,
      intervalMs,
      isPanelVisible(panelState, Panel.Artifact) && detailCid !== undefined,
    );

    // Pipeline view mode — render PipelineView instead of grid (item 11)
    if (panelState.viewMode === "pipeline") {
      return (
        <box flexDirection="column" flexGrow={1}>
          <PipelineView provider={provider} tmux={tmux} intervalMs={intervalMs} active />
        </box>
      );
    }

    // Compute artifact names list and select by index
    const artifactNames = detailData?.contribution.artifacts
      ? Object.keys(detailData.contribution.artifacts)
      : [];
    const selectedArtifactName =
      artifactNames.length > 0
        ? artifactNames[(artifactIndex ?? 0) % artifactNames.length]
        : undefined;

    // Resolve parent CID from derives_from relation for diff support
    const parentCid = detailData?.contribution.relations.find(
      (r) => r.relationType === "derives_from",
    )?.targetCid;

    // ------------------------------------------------------------------
    // Panel renderer — maps a Panel enum to the appropriate component
    // ------------------------------------------------------------------
    const renderPanel = (panel: Panel): React.ReactNode => {
      switch (panel) {
        case Panel.Dag:
          return (
            <DagView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Dag) ? nav.state.cursor : -1}
              onContributionsLoaded={onContributionsLoaded}
            />
          );
        case Panel.Detail:
          return showDetail ? (
            <DetailView provider={provider} cid={nav.detailCid ?? ""} intervalMs={intervalMs} />
          ) : (
            <DashboardView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Detail) ? nav.state.cursor : -1}
              onContributionsLoaded={onContributionsLoaded}
            />
          );
        case Panel.Frontier:
          return (
            <FrontierView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Frontier) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
              compareMode={compareMode}
              onCompareSelect={onCompareSelect}
              compareCids={compareCids}
              onFrontierCidsChanged={onFrontierCidsChanged}
            />
          );
        case Panel.Claims:
          return (
            <ClaimsView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Claims) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
              activeClaims={activeClaims}
            />
          );
        case Panel.AgentList:
          return topology ? (
            <AgentGraphView
              provider={provider}
              tmux={tmux}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.AgentList) ? nav.state.cursor : -1}
              topology={topology}
              onSelectSession={onSelectSession}
            />
          ) : (
            <AgentListView
              provider={provider}
              tmux={tmux}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.AgentList) ? nav.state.cursor : -1}
              onSelectSession={onSelectSession}
            />
          );
        case Panel.Terminal:
          return tmux && activeSessions && activeSessions.length > 1 ? (
            <AgentSplitPane sessions={activeSessions} tmux={tmux} intervalMs={intervalMs} active />
          ) : (
            <TerminalView
              sessionName={selectedSession}
              tmux={tmux}
              intervalMs={intervalMs}
              active
              mode={panelState.mode}
              scrollOffset={terminalScrollOffset}
            />
          );
        case Panel.Artifact:
          return compareMode && compareCids && compareCids.length === 2 ? (
            <CompareView
              provider={provider}
              leftCid={compareCids[0] ?? ""}
              rightCid={compareCids[1] ?? ""}
              intervalMs={intervalMs}
            />
          ) : (
            <ArtifactPreviewView
              provider={provider}
              cid={detailCid}
              artifactName={selectedArtifactName}
              allArtifactNames={artifactNames}
              artifactIndex={
                artifactNames.length > 0 ? (artifactIndex ?? 0) % artifactNames.length : 0
              }
              parentCid={parentCid}
              showDiff={showArtifactDiff}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Artifact)}
            />
          );
        case Panel.Vfs:
          return (
            <VfsBrowserView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Vfs)}
              cursor={isFocused(Panel.Vfs) ? nav.state.cursor : -1}
              navigateTrigger={vfsNavigateTrigger}
            />
          );
        case Panel.Activity:
          return (
            <ActivityPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Activity)}
              cursor={isFocused(Panel.Activity) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Search:
          return (
            <SearchPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Search)}
              cursor={isFocused(Panel.Search) ? nav.state.cursor : -1}
              searchQuery={searchQuery ?? ""}
              isInputMode={isSearchInputMode ?? false}
              onRowCountChanged={onRowCountChanged}
              terminalBuffers={terminalBuffers}
            />
          );
        case Panel.Threads:
          return (
            <ThreadsPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Threads)}
              cursor={isFocused(Panel.Threads) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Outcomes:
          return (
            <OutcomesPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Outcomes)}
              cursor={isFocused(Panel.Outcomes) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Bounties:
          return (
            <BountiesPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Bounties)}
              cursor={isFocused(Panel.Bounties) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Gossip:
          return (
            <GossipPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Gossip)}
              cursor={isFocused(Panel.Gossip) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Inbox:
          return (
            <InboxPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Inbox)}
              cursor={isFocused(Panel.Inbox) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Decisions:
          return (
            <DecisionsPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Decisions)}
              cursor={isFocused(Panel.Decisions) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.GitHub:
          return (
            <GitHubPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.GitHub)}
              cursor={isFocused(Panel.GitHub) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          );
        case Panel.Plan:
          return (
            <PlanPanelView
              provider={provider}
              intervalMs={intervalMs}
              active={isPanelVisible(panelState, Panel.Plan)}
              cursor={isFocused(Panel.Plan) ? nav.state.cursor : -1}
            />
          );
        default:
          return null;
      }
    };

    // ------------------------------------------------------------------
    // Tab mode — single focused panel, full screen
    // ------------------------------------------------------------------
    if (mode === "tab") {
      return (
        <box flexDirection="column" flexGrow={1}>
          <PanelChrome panel={panelState.focused} focused>
            {renderPanel(panelState.focused)}
          </PanelChrome>
        </box>
      );
    }

    // ------------------------------------------------------------------
    // Grid mode — data-driven row groups
    // ------------------------------------------------------------------
    return (
      <box flexDirection="column" flexGrow={1}>
        {[...getRowGroups().entries()].map(([rowGroup, panels]) => {
          if (!isRowVisible(rowGroup, focusedRowGroup, zoom)) return null;
          const visibleInRow = panels.filter(
            (def) =>
              (def.kind === "core" || isPanelVisible(panelState, def.panel)) &&
              (allowedPanels === undefined || allowedPanels.has(def.panel)),
          );
          if (visibleInRow.length === 0) return null;
          return (
            <box
              key={rowGroup}
              flexDirection="row"
              flexGrow={getRowFlex(rowGroup, focusedRowGroup, zoom, rowGroup === 0 ? 2 : 1)}
            >
              {visibleInRow.map((def) => (
                <PanelChrome key={def.panel} panel={def.panel} focused={isFocused(def.panel)}>
                  {renderPanel(def.panel)}
                </PanelChrome>
              ))}
            </box>
          );
        })}
      </box>
    );
  },
);
