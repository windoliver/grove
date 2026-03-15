/**
 * Agent list view — shows running agent sessions derived from claims + tmux.
 *
 * Correlates active claims with tmux sessions to build the agent fleet view.
 * In local mode, shows session status and allows spawn/kill via command palette.
 */

import React, { useCallback, useEffect, useRef } from "react";
import type { Claim } from "../../core/models.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { DataStatus } from "../components/data-status.js";
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
  { header: "AGENT", key: "agentId", width: 16 },
  { header: "PLATFORM", key: "platform", width: 12 },
  { header: "STATUS", key: "status", width: 8 },
  { header: "COST", key: "cost", width: 10 },
  { header: "TARGET", key: "target", width: 18 },
  { header: "SESSION", key: "session", width: 16 },
] as const;

/** Derive detailed agent status from claim, session, and tmux state. */
function deriveAgentStatus(
  claim: Claim,
  session: string | undefined,
  tmuxSessions: readonly string[],
): string {
  const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();

  if (remaining <= 0) return "expired";
  if (!session) return "claimed";

  // Check if session is still alive in tmux
  const sessionAlive = tmuxSessions.includes(session);
  if (!sessionAlive) return "error";

  // Check for stalled agents (heartbeat older than 60s)
  const heartbeatAge = Date.now() - new Date(claim.heartbeatAt).getTime();
  if (heartbeatAge > 60_000) {
    return "stalled";
  }

  // Active session exists
  return "running";
}

/** Build agent rows by correlating claims with tmux sessions. */
function buildAgentRows(
  claims: readonly Claim[],
  tmuxSessions: readonly string[],
  costs?: ReadonlyMap<string, { costUsd: number; tokens: number; contextPercent?: number }>,
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
    const status = deriveAgentStatus(claim, session, tmuxSessions);
    const agentCost = costs?.get(claim.agent.agentId);

    return {
      agentId,
      platform: claim.agent.platform ?? "-",
      target: claim.targetRef.length > 18 ? `${claim.targetRef.slice(0, 16)}..` : claim.targetRef,
      status,
      cost: agentCost ? `$${agentCost.costUsd.toFixed(2)}` : "-",
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

    const {
      data: claims,
      loading: claimsLoading,
      isStale,
      error,
    } = usePolledData<readonly Claim[]>(claimFetcher, intervalMs, active);
    const {
      data: sessions,
      isStale: tmuxStale,
      error: tmuxError,
    } = usePolledData<readonly string[]>(tmuxFetcher, intervalMs * 2, active && !!tmux);

    const costFetcher = useCallback(async () => {
      const cp = provider as unknown as {
        getSessionCosts?: () => Promise<{
          byAgent: readonly {
            agentId: string;
            costUsd: number;
            tokens: number;
            contextPercent?: number;
          }[];
        }>;
      };
      if (!cp.getSessionCosts)
        return new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
      const costs = await cp.getSessionCosts();
      const map = new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
      for (const a of costs.byAgent) {
        const entry: { costUsd: number; tokens: number; contextPercent?: number } = {
          costUsd: a.costUsd,
          tokens: a.tokens,
        };
        if (a.contextPercent !== undefined) entry.contextPercent = a.contextPercent;
        map.set(a.agentId, entry);
      }
      return map;
    }, [provider]);
    const { data: agentCosts } = usePolledData(costFetcher, intervalMs * 2, active);

    // Combine staleness from both data sources
    const combinedStale = isStale || tmuxStale;
    const combinedError = error ?? tmuxError;

    const agentRows = buildAgentRows(claims ?? [], sessions ?? [], agentCosts ?? undefined);

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
          <DataStatus
            loading={claimsLoading && !claims}
            isStale={combinedStale}
            error={combinedError?.message}
          />
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
          <DataStatus
            loading={claimsLoading && !claims}
            isStale={combinedStale}
            error={combinedError?.message}
          />
        </box>
        <Table columns={[...COLUMNS]} rows={agentRows} cursor={cursor} />
      </box>
    );
  },
);
