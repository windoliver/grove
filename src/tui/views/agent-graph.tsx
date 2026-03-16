/**
 * Agent graph view — visualizes agent topology as a directed graph.
 *
 * When a topology is defined in the GROVE.md contract, renders roles as
 * nodes and edges as Unicode line-drawing characters. Correlates live
 * agent data from claims + tmux sessions with topology roles.
 *
 * Falls back to the flat AgentListView when no topology is configured.
 */

import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn } from "../agents/spawn-validator.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession, tmuxSessionName } from "../agents/tmux-manager.js";
import { EmptyState } from "../components/empty-state.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { renderGraph } from "../layout/edge-render.js";
import type { LayoutEdge, LiveAgentStatus } from "../layout/graph-layout.js";
import { layoutGraph } from "../layout/graph-layout.js";
import type { TuiDataProvider } from "../provider.js";
import { theme } from "../theme.js";

/** Props for the AgentGraphView. */
export interface AgentGraphProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly topology: AgentTopology;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
}

/**
 * Build dynamic edges from claim lineage (parentAgentId in context).
 *
 * For each claim that records a parentAgentId, find the parent claim's role
 * and create a runtime "spawns" edge from parent role → child role.
 * Edges are deduplicated by (from, to) so the graph stays clean.
 */
function buildDynamicEdges(
  claims: readonly Claim[],
  staticEdgeKeys: ReadonlySet<string>,
): readonly LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>(staticEdgeKeys);

  for (const claim of claims) {
    const parentId = claim.context?.parentAgentId;
    if (typeof parentId !== "string") continue;

    const parentClaim = claims.find((c) => c.agent.agentId === parentId);
    if (!parentClaim) continue;

    const parentRole = parentClaim.agent.role ?? "unknown";
    const childRole = claim.agent.role ?? "unknown";
    const key = `${parentRole}::${childRole}`;

    if (parentRole !== childRole && !seen.has(key)) {
      edges.push({ from: parentRole, to: childRole, edgeType: "spawns" });
      seen.add(key);
    }
  }

  return edges;
}

/** Map a status string to its theme symbol (matches agent-list mapping). */
function statusSymbol(status: string): string {
  switch (status) {
    case "running":
      return theme.agentRunning;
    case "claimed":
    case "stalled":
      return theme.agentWaiting;
    case "expired":
    case "idle":
      return theme.agentIdle;
    case "error":
      return theme.agentError;
    default:
      return theme.agentIdle;
  }
}

/** Build live agent status map from claims and tmux sessions. */
function buildLiveAgents(
  claims: readonly Claim[],
  tmuxSessions: readonly string[],
): ReadonlyMap<string, readonly LiveAgentStatus[]> {
  const sessionSet = new Set<string>();
  for (const name of tmuxSessions) {
    const id = agentIdFromSession(name);
    if (id) sessionSet.add(id);
  }

  const byRole = new Map<string, LiveAgentStatus[]>();

  for (const claim of claims) {
    const role = claim.agent.role ?? "unknown";
    const isRunning = sessionSet.has(claim.agent.agentId);
    const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();

    const status: LiveAgentStatus = {
      agentId: claim.agent.agentName ?? claim.agent.agentId,
      status: isRunning ? "running" : remaining > 0 ? "idle" : "error",
      target: claim.targetRef,
    };

    const list = byRole.get(role);
    if (list) {
      list.push(status);
    } else {
      byRole.set(role, [status]);
    }
  }

  return byRole;
}

/** Agent topology graph view component. */
export const AgentGraphView: React.NamedExoticComponent<AgentGraphProps> = React.memo(
  function AgentGraphView({
    provider,
    tmux,
    intervalMs,
    active,
    cursor,
    topology,
    onSelectSession,
  }: AgentGraphProps): React.ReactNode {
    const claimFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
    const tmuxFetcher = useCallback(async () => {
      if (!tmux) return [] as readonly string[];
      const available = await tmux.isAvailable();
      if (!available) return [] as readonly string[];
      return tmux.listSessions();
    }, [tmux]);

    const { data: claims } = usePolledData<readonly Claim[]>(claimFetcher, intervalMs, active);
    const { data: sessions } = usePolledData<readonly string[]>(
      tmuxFetcher,
      intervalMs * 2,
      active && !!tmux,
    );

    const liveAgents = useMemo(
      () => buildLiveAgents(claims ?? [], sessions ?? []),
      [claims, sessions],
    );

    // Build flat list of selectable tmux session names from running agents
    const selectableSessions = useMemo(() => {
      const sessionSet = new Set<string>();
      for (const name of sessions ?? []) {
        const id = agentIdFromSession(name);
        if (id) sessionSet.add(id);
      }

      const result: string[] = [];
      for (const [, agents] of liveAgents) {
        for (const agent of agents) {
          if (agent.status === "running") {
            // agent.agentId here is the display name (agentName ?? agentId).
            // We need the real agentId to form the tmux session name.
            // Look it up from claims by matching the display name.
            const claim = (claims ?? []).find(
              (c) =>
                (c.agent.agentName ?? c.agent.agentId) === agent.agentId &&
                sessionSet.has(c.agent.agentId),
            );
            if (claim) {
              result.push(tmuxSessionName(claim.agent.agentId));
            }
          }
        }
      }
      return result;
    }, [liveAgents, claims, sessions]);

    // Notify parent when cursor moves to select the corresponding session
    const selectableRef = useRef(selectableSessions);
    selectableRef.current = selectableSessions;

    useEffect(() => {
      if (!onSelectSession || cursor < 0) return;
      const session = selectableRef.current[cursor];
      onSelectSession(session ?? undefined);
    }, [cursor, onSelectSession]);

    const rendered = useMemo(() => {
      const layout = layoutGraph(topology.roles, topology.structure, liveAgents);

      // Build dynamic edges from claim lineage (parentAgentId in context)
      const staticEdgeKeys = new Set(layout.edges.map((e) => `${e.from}::${e.to}`));
      const dynamicEdges = buildDynamicEdges(claims ?? [], staticEdgeKeys);

      // Merge dynamic edges into layout for rendering
      const mergedLayout =
        dynamicEdges.length > 0 ? { ...layout, edges: [...layout.edges, ...dynamicEdges] } : layout;

      return renderGraph(mergedLayout);
    }, [topology, liveAgents, claims]);

    // Build capacity warnings for roles at or over max_instances
    const capacityWarnings = useMemo(() => {
      const warnings: string[] = [];
      for (const role of topology.roles) {
        const check = checkSpawn(topology, role.name, claims ?? []);
        if (!check.allowed && check.warning && check.role !== undefined) {
          warnings.push(
            `${role.name} at capacity (${check.currentInstances}/${check.maxInstances})`,
          );
        }
      }
      return warnings;
    }, [topology, claims]);

    // Build a status summary from live agents (must be before early return)
    const statusSummary = useMemo(() => {
      const counts: Record<string, number> = {};
      for (const [, agents] of liveAgents) {
        for (const agent of agents) {
          counts[agent.status] = (counts[agent.status] ?? 0) + 1;
        }
      }
      return Object.entries(counts)
        .map(([s, count]) => `${statusSymbol(s)} ${count} ${s}`)
        .join("  ");
    }, [liveAgents]);

    if (rendered.lines.length === 0) {
      return (
        <EmptyState
          title="Empty topology."
          hint="Add roles to GROVE.md to define the agent graph."
        />
      );
    }

    const headerSuffix =
      capacityWarnings.length > 0 ? ` \u26A0 ${capacityWarnings.join(", ")}` : "";

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="column">
          <text color={theme.muted}>
            Topology: {topology.structure} ({topology.roles.length} roles){headerSuffix}
          </text>
          {statusSummary ? <text color={theme.muted}>{statusSummary}</text> : null}
        </box>
        <box flexDirection="column">
          {rendered.lines.map((line, i) => (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: graph lines have no stable identity
              key={i}
              color={i === cursor ? theme.focus : undefined}
            >
              {line}
            </text>
          ))}
        </box>
      </box>
    );
  },
);
