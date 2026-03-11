/**
 * Agent list view — shows running agent sessions derived from claims + tmux.
 *
 * Correlates active claims with tmux sessions to build the agent fleet view.
 * In local mode, shows session status and allows spawn/kill via command palette.
 */

import React, { useCallback, useEffect, useRef } from "react";
import type { Claim } from "../../core/models.js";
import { formatDuration } from "../../shared/duration.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the AgentList view. */
export interface AgentListProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
}

const COLUMNS = [
  { header: "AGENT", key: "agentId", width: 18 },
  { header: "TARGET", key: "target", width: 24 },
  { header: "STATUS", key: "status", width: 10 },
  { header: "LEASE", key: "lease", width: 12 },
  { header: "SESSION", key: "session", width: 20 },
] as const;

/** Build agent rows by correlating claims with tmux sessions. */
function buildAgentRows(
  claims: readonly Claim[],
  tmuxSessions: readonly string[],
): readonly Record<string, string>[] {
  const agentSessions = new Map<string, string>();

  for (const name of tmuxSessions) {
    const id = agentIdFromSession(name);
    if (id) {
      agentSessions.set(id, name);
    }
  }

  return claims.map((claim) => {
    const agentId = claim.agent.agentName ?? claim.agent.agentId;
    const session = agentSessions.get(claim.agent.agentId);
    const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();

    return {
      agentId,
      target: claim.targetRef.length > 24 ? `${claim.targetRef.slice(0, 22)}..` : claim.targetRef,
      status: session ? "running" : remaining > 0 ? "claimed" : "expired",
      lease: remaining > 0 ? formatDuration(remaining) : "expired",
      session: session ?? "-",
    };
  });
}

/** Agent list view component. */
export const AgentListView: React.NamedExoticComponent<AgentListProps> = React.memo(
  function AgentListView({
    provider,
    tmux,
    intervalMs,
    active,
    cursor,
    onSelectSession,
  }: AgentListProps): React.ReactNode {
    const claimFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
    const tmuxFetcher = useCallback(async () => {
      if (!tmux) return [] as readonly string[];
      const available = await tmux.isAvailable();
      if (!available) return [] as readonly string[];
      return tmux.listSessions();
    }, [tmux]);

    const { data: claims, loading: claimsLoading } = usePolledData<readonly Claim[]>(
      claimFetcher,
      intervalMs,
      active,
    );
    const { data: sessions } = usePolledData<readonly string[]>(
      tmuxFetcher,
      intervalMs * 2, // Poll tmux less frequently
      active && !!tmux,
    );

    const agentRows = buildAgentRows(claims ?? [], sessions ?? []);

    // Track rows for session selection and notify parent when cursor moves
    const rowsRef = useRef(agentRows);
    rowsRef.current = agentRows;

    useEffect(() => {
      if (!onSelectSession || cursor < 0) return;
      const row = rowsRef.current[cursor];
      const session = row?.session;
      onSelectSession(session && session !== "-" ? session : undefined);
    }, [cursor, onSelectSession]);

    if (claimsLoading && !claims) {
      return (
        <box>
          <text opacity={0.5}>Loading agents...</text>
        </box>
      );
    }

    if (agentRows.length === 0) {
      return (
        <box flexDirection="column">
          <text opacity={0.5}>No active agents</text>
          {!tmux && <text opacity={0.5}>tmux not available — agents require tmux</text>}
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>
            Agents ({agentRows.length}){!tmux && <text opacity={0.5}> [no tmux]</text>}
          </text>
        </box>
        <Table columns={[...COLUMNS]} rows={agentRows} cursor={cursor} />
      </box>
    );
  },
);
