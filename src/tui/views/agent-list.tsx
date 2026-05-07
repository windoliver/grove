/**
 * Agent list view — running agents derived from active claims joined
 * with tmux session list and cost rollups. EntityView renders the
 * list; the wrapper computes the join context and passes it to the
 * column factories.
 */

import React, { useCallback, useMemo, useState } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import { useInterval } from "../../local/use-interval.js";
import { agentIdFromSession, type TmuxManager } from "../agents/tmux-manager.js";
import {
  type AgentJoinCtx,
  agentIdColumn,
  byRoleAndName,
  costColumn,
  platformColumn,
  roleColumn,
  sessionColumn,
  statusColumn,
  targetColumn,
} from "../components/columns/agent-columns.js";
import { isActive } from "../components/columns/claim-columns.js";
import { EntityView } from "../components/entity-view.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, timing } from "../theme.js";

export interface AgentListProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
}

export const AgentListView: React.NamedExoticComponent<AgentListProps> = React.memo(
  function AgentListView(props: AgentListProps): React.ReactNode {
    const { provider, tmux, active, cursor, onSelectSession } = props;
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useInterval(
      () => setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length),
      timing.spinner,
      active,
    );

    const tmuxFetcher = useCallback(async (): Promise<readonly string[]> => {
      if (!tmux) return [];
      return (await tmux.isAvailable()) ? tmux.listSessions() : [];
    }, [tmux]);
    const { data: tmuxSessions } = useEventDrivenData<readonly string[]>(
      tmuxFetcher,
      undefined,
      undefined,
      active && !!tmux,
    );

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
      const out = await cp.getSessionCosts();
      const m = new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>();
      for (const a of out.byAgent) {
        const entry: { costUsd: number; tokens: number; contextPercent?: number } = {
          costUsd: a.costUsd,
          tokens: a.tokens,
        };
        if (a.contextPercent !== undefined) entry.contextPercent = a.contextPercent;
        m.set(a.agentId, entry);
      }
      return m;
    }, [provider]);
    const { data: costs } = useEventDrivenData(costFetcher, undefined, undefined, active);

    const agentSessions = useMemo<ReadonlyMap<string, string>>(() => {
      const m = new Map<string, string>();
      for (const name of tmuxSessions ?? []) {
        const id = agentIdFromSession(name);
        if (id) m.set(id, name);
      }
      return m;
    }, [tmuxSessions]);

    const ctx = useMemo<AgentJoinCtx>(
      () => ({
        tmuxSessions: tmuxSessions ?? [],
        agentSessions,
        costs:
          costs ?? new Map<string, { costUsd: number; tokens: number; contextPercent?: number }>(),
        spinnerFrame,
      }),
      [tmuxSessions, agentSessions, costs, spinnerFrame],
    );

    const columns = useMemo(
      () => [
        agentIdColumn(16),
        roleColumn(12),
        platformColumn(12),
        statusColumn(ctx, 12),
        costColumn(ctx, 14),
        targetColumn(18),
        sessionColumn(ctx, 16),
      ],
      [ctx],
    );

    const onSelect = useCallback(
      (entity: ClaimEntity | undefined) => {
        if (!onSelectSession) return;
        if (!entity) return onSelectSession(undefined);
        const session = agentSessions.get(entity.spec.agent.agentId);
        onSelectSession(session ?? undefined);
      },
      [onSelectSession, agentSessions],
    );

    return (
      <EntityView
        kind="Claim"
        columns={columns}
        provider={provider}
        active={active}
        cursor={cursor}
        predicate={isActive}
        sort={byRoleAndName}
        title="Agents"
        emptyTitle="No agents registered."
        emptyHint="Press r to register, or Ctrl+P to spawn."
        onSelect={onSelect}
      />
    );
  },
);
