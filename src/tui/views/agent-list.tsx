/**
 * Agent list view — shows running agent sessions derived from claims + tmux.
 *
 * Correlates active claims with tmux sessions to build the agent fleet view.
 * In local mode, shows session status and allows spawn/kill via command palette.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Claim } from "../../core/models.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, theme } from "../theme.js";

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
  { header: "ROLE", key: "role", width: 12 },
  { header: "PLATFORM", key: "platform", width: 12 },
  { header: "STATUS", key: "status", width: 12 },
  { header: "COST", key: "cost", width: 14 },
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

/** Map a status string to its theme symbol (with animated spinner for running). */
function statusSymbol(status: string, spinnerFrame?: number): string {
  switch (status) {
    case "running":
      return spinnerFrame !== undefined
        ? (BRAILLE_SPINNER[spinnerFrame % BRAILLE_SPINNER.length] ?? theme.agentRunning)
        : theme.agentRunning;
    case "claimed":
    case "stalled":
      return theme.agentWaiting;
    case "expired":
      return theme.agentIdle;
    case "error":
      return theme.agentError;
    default:
      return theme.agentIdle;
  }
}

/** Format token count to compact string (e.g. "12K", "1.2M"). */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Build agent rows by correlating claims with tmux sessions, grouped by role. */
function buildAgentRows(
  claims: readonly Claim[],
  tmuxSessions: readonly string[],
  costs?: ReadonlyMap<string, { costUsd: number; tokens: number; contextPercent?: number }>,
  spinnerFrame?: number,
): readonly Record<string, string>[] {
  const agentSessions = new Map<string, string>();

  for (const name of tmuxSessions) {
    const id = agentIdFromSession(name);
    if (id) {
      agentSessions.set(id, name);
    }
  }

  const rows = claims.map((claim) => {
    const agentId = claim.agent.agentName ?? claim.agent.agentId;
    const session = agentSessions.get(claim.agent.agentId);
    const status = deriveAgentStatus(claim, session, tmuxSessions);
    const agentCost = costs?.get(claim.agent.agentId);
    const role = claim.agent.role ?? "worker";

    return {
      agentId,
      role,
      platform: claim.agent.platform ?? "-",
      target: claim.targetRef.length > 18 ? `${claim.targetRef.slice(0, 16)}..` : claim.targetRef,
      status: `${statusSymbol(status, spinnerFrame)} ${status}`,
      cost: agentCost
        ? `$${agentCost.costUsd.toFixed(2)} | ${formatTokens(agentCost.tokens)}`
        : "-",
      session: session ?? "-",
      _role: role, // for sorting
    };
  });

  // Group by role: coordinators first, then alphabetical
  rows.sort((a, b) => {
    if (a._role !== b._role) {
      if (a._role === "coordinator") return -1;
      if (b._role === "coordinator") return 1;
      return a._role.localeCompare(b._role);
    }
    return a.agentId.localeCompare(b.agentId);
  });

  return rows;
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
    // Animated spinner for running agents (item 8)
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => {
        setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
      }, 100);
      return () => clearInterval(timer);
    }, [active]);

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

    const agentRows = buildAgentRows(
      claims ?? [],
      sessions ?? [],
      agentCosts ?? undefined,
      spinnerFrame,
    );

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
          <EmptyState
            title="No agents registered."
            hint="Press r to register, or Ctrl+P to spawn."
          />
          {!tmux && <text opacity={0.5}>tmux not available — agents require tmux</text>}
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>{`Agents (${agentRows.length})`}</text>
          {!tmux && <text opacity={0.5}> [no tmux]</text>}
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
