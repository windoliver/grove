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
import { ActivityView } from "../views/activity.js";
import { AgentGraphView } from "../views/agent-graph.js";
import { AgentListView } from "../views/agent-list.js";
import { ArtifactPreviewView } from "../views/artifact-preview.js";
import { ClaimsView } from "../views/claims.js";
import { DagView } from "../views/dag.js";
import { DashboardView } from "../views/dashboard.js";
import { DetailView } from "../views/detail.js";
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
  }: PanelManagerProps): React.ReactNode {
    const isFocused = (p: Panel) => panelState.focused === p;

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

    const firstArtifactName = detailData?.contribution.artifacts
      ? Object.keys(detailData.contribution.artifacts)[0]
      : undefined;

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
            <ActivityView
              provider={provider}
              intervalMs={intervalMs}
              active
              cursor={isFocused(Panel.Frontier) ? nav.state.cursor : -1}
              pageOffset={nav.state.pageOffset}
              pageSize={pageSize}
              onContributionsLoaded={onContributionsLoaded}
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
                  />
                ) : (
                  <AgentListView
                    provider={provider}
                    tmux={tmux}
                    intervalMs={intervalMs}
                    active
                    cursor={isFocused(Panel.AgentList) ? nav.state.cursor : -1}
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
                  artifactName={firstArtifactName}
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
                />
              </PanelChrome>
            )}
          </box>
        )}
      </box>
    );
  },
);
