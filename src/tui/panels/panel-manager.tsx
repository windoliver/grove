/**
 * Panel manager — multi-panel grid layout for the agent command center.
 *
 * Panels 1-4 (protocol core) are always visible.
 * Panels 5-8 (operator tooling) are toggled on demand.
 *
 * Layout:
 * ┌─ DAG ──────────────┬─ Detail ─────────┐
 * │                     │                  │
 * ├─ Frontier ──────────┤                  │
 * │                     │                  │
 * ├─ Claims ────────────┴──────────────────┤
 * │                                        │
 * └────────────────────────────────────────┘
 *
 * With operator panels visible, they appear below:
 * ├─ Agents ────────────┬─ Terminal ───────┤
 */

import React, { useCallback } from "react";
import type { Contribution } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import type { NavigationActions } from "../hooks/use-navigation.js";
import type { PanelFocusState } from "../hooks/use-panel-focus.js";
import { isPanelVisible, PANEL_LABELS, Panel } from "../hooks/use-panel-focus.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { ContributionDetail, TuiDataProvider } from "../provider.js";
import { AgentGraphView } from "../views/agent-graph.js";
import { AgentListView } from "../views/agent-list.js";
import { ArtifactPreviewView } from "../views/artifact-preview.js";
import { ClaimsView } from "../views/claims.js";
import { DagView } from "../views/dag.js";
import { DashboardView } from "../views/dashboard.js";
import { DetailView } from "../views/detail.js";
import { FrontierView } from "../views/frontier-view.js";
import { TerminalView } from "../views/terminal.js";
import { VfsBrowserView } from "../views/vfs-browser.js";

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
}

/** Wraps a panel view with a titled border. */
function PanelChrome({
  panel,
  focused,
  children,
}: {
  readonly panel: Panel;
  readonly focused: boolean;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={1} paddingRight={1}>
      <box>
        <text color={focused ? "#00cccc" : "#888888"}>
          {focused ? `[${PANEL_LABELS[panel]}]` : ` ${PANEL_LABELS[panel]} `}
        </text>
      </box>
      {children}
    </box>
  );
}

/** Multi-panel grid layout. */
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
  }: PanelManagerProps): React.ReactNode {
    const isFocused = (p: Panel) => panelState.focused === p;

    // Suppress unused variable warnings for props used by other panel configurations
    void pageSize;

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

    return (
      <box flexDirection="column" flexGrow={1}>
        {/* Top row: DAG + Detail */}
        <box flexDirection="row" flexGrow={2}>
          <PanelChrome panel={Panel.Dag} focused={isFocused(Panel.Dag)}>
            <DagView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Dag) ? nav.state.cursor : -1}
              onContributionsLoaded={onContributionsLoaded}
            />
          </PanelChrome>

          <PanelChrome panel={Panel.Detail} focused={isFocused(Panel.Detail)}>
            {showDetail ? (
              <DetailView provider={provider} cid={nav.detailCid ?? ""} intervalMs={intervalMs} />
            ) : (
              <DashboardView
                provider={provider}
                intervalMs={intervalMs}
                active
                cursor={isFocused(Panel.Detail) ? nav.state.cursor : -1}
                onContributionsLoaded={onContributionsLoaded}
              />
            )}
          </PanelChrome>
        </box>

        {/* Middle row: Frontier */}
        <box flexDirection="row" flexGrow={1}>
          <PanelChrome panel={Panel.Frontier} focused={isFocused(Panel.Frontier)}>
            <FrontierView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Frontier) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          </PanelChrome>
        </box>

        {/* Bottom row: Claims */}
        <box flexDirection="row" flexGrow={1}>
          <PanelChrome panel={Panel.Claims} focused={isFocused(Panel.Claims)}>
            <ClaimsView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Claims) ? nav.state.cursor : -1}
              onRowCountChanged={onRowCountChanged}
            />
          </PanelChrome>
        </box>

        {/* Operator panels row (only if any are visible) */}
        {(isPanelVisible(panelState, Panel.AgentList) ||
          isPanelVisible(panelState, Panel.Terminal)) && (
          <box flexDirection="row" flexGrow={1}>
            {isPanelVisible(panelState, Panel.AgentList) && (
              <PanelChrome panel={Panel.AgentList} focused={isFocused(Panel.AgentList)}>
                {topology ? (
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
                )}
              </PanelChrome>
            )}
            {isPanelVisible(panelState, Panel.Terminal) && (
              <PanelChrome panel={Panel.Terminal} focused={isFocused(Panel.Terminal)}>
                <TerminalView
                  sessionName={selectedSession}
                  tmux={tmux}
                  intervalMs={intervalMs}
                  active
                  mode={panelState.mode}
                />
              </PanelChrome>
            )}
          </box>
        )}

        {/* Artifact / VFS panels */}
        {(isPanelVisible(panelState, Panel.Artifact) || isPanelVisible(panelState, Panel.Vfs)) && (
          <box flexDirection="row" flexGrow={1}>
            {isPanelVisible(panelState, Panel.Artifact) && (
              <PanelChrome panel={Panel.Artifact} focused={isFocused(Panel.Artifact)}>
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
              </PanelChrome>
            )}
            {isPanelVisible(panelState, Panel.Vfs) && (
              <PanelChrome panel={Panel.Vfs} focused={isFocused(Panel.Vfs)}>
                <VfsBrowserView
                  provider={provider}
                  intervalMs={intervalMs}
                  active={isPanelVisible(panelState, Panel.Vfs)}
                  cursor={isFocused(Panel.Vfs) ? nav.state.cursor : -1}
                  navigateTrigger={vfsNavigateTrigger}
                />
              </PanelChrome>
            )}
          </box>
        )}
      </box>
    );
  },
);
