/**
 * Agent graph view — visualizes agent topology as a directed graph.
 *
 * When a topology is defined in the GROVE.md contract, renders roles as
 * nodes and edges as Unicode line-drawing characters. Correlates live
 * agent data from claims + tmux sessions with topology roles.
 *
 * Falls back to the flat AgentListView when no topology is configured.
 */

import React, { useCallback, useMemo } from "react";
import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import { checkSpawn } from "../agents/spawn-validator.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { renderGraph } from "../layout/edge-render.js";
import type { LiveAgentStatus } from "../layout/graph-layout.js";
import { layoutGraph } from "../layout/graph-layout.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the AgentGraphView. */
export interface AgentGraphProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly topology: AgentTopology;
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

    const rendered = useMemo(() => {
      const layout = layoutGraph(topology.roles, topology.structure, liveAgents);
      return renderGraph(layout);
    }, [topology, liveAgents]);

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

    if (rendered.lines.length === 0) {
      return (
        <box>
          <text opacity={0.5}>Empty topology — add roles to GROVE.md</text>
        </box>
      );
    }

    const headerSuffix =
      capacityWarnings.length > 0 ? ` \u26A0 ${capacityWarnings.join(", ")}` : "";

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text color="#888888">
            Topology: {topology.structure} ({topology.roles.length} roles){headerSuffix}
          </text>
        </box>
        <box flexDirection="column">
          {rendered.lines.map((line, i) => (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: graph lines have no stable identity
              key={i}
              color={i === cursor ? "#00cccc" : undefined}
            >
              {line}
            </text>
          ))}
        </box>
      </box>
    );
  },
);
