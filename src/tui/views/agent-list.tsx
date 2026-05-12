/**
 * Agent list view — running agents derived from active claims joined
 * with tmux session list and cost rollups. EntityView renders the
 * list; the wrapper computes the join context and passes it to the
 * column factories.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { type ClaimEntity, claimToEntity } from "../../core/entity.js";
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
import { EmptyState } from "../components/empty-state.js";
import { EntityView } from "../components/entity-view.js";
import { useProviderScoped } from "../hooks/informer-context.js";
import { useEventDrivenData } from "../hooks/use-event-driven-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, timing } from "../theme.js";

const NAMESPACE = "default";

export interface AgentListProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onSelectSession?: ((sessionName: string | undefined) => void) | undefined;
  /** C2 (#302): substring filter on rendered row text. Empty / undefined = no filter. */
  readonly filterText?: string | undefined;
}

/**
 * Build a C2 (#302) filter predicate over a ClaimEntity. Case-insensitive
 * substring match across role, agentId, agentName, platform, and targetRef.
 * Empty/whitespace filter → undefined (no narrowing).
 *
 * Exported for unit testing — the filter logic is the actual surface that
 * narrows what the user sees when typing `/foo` in the running view.
 */
export function buildAgentFilter(
  filterText: string | undefined,
): ((e: ClaimEntity) => boolean) | undefined {
  const q = filterText?.trim().toLowerCase();
  if (!q) return undefined;
  return (e: ClaimEntity) => {
    const a = e.spec.agent;
    const haystack = [
      a.agentName ?? "",
      a.agentId,
      a.role ?? "",
      a.platform ?? "",
      e.spec.targetRef,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  };
}

export const AgentListView: React.NamedExoticComponent<AgentListProps> = React.memo(
  function AgentListView(props: AgentListProps): React.ReactNode {
    const { provider, tmux, active, cursor, onSelectSession, filterText } = props;
    const isScoped = useProviderScoped(provider);
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

    // C2 (#302): compose isActive (view-internal) with filter (user input).
    const filterPred = useMemo(() => buildAgentFilter(filterText), [filterText]);
    const predicate = useMemo<(e: ClaimEntity) => boolean>(() => {
      if (!filterPred) return isActive;
      return (e) => isActive(e) && filterPred(e);
    }, [filterPred]);

    const onSelect = useCallback(
      (entity: ClaimEntity | undefined) => {
        if (!onSelectSession) return;
        if (!entity) return onSelectSession(undefined);
        const session = agentSessions.get(entity.spec.agent.agentId);
        onSelectSession(session ?? undefined);
      },
      [onSelectSession, agentSessions],
    );

    const fallbackFetcher = useCallback(async (): Promise<readonly ClaimEntity[]> => {
      const claims = await provider.getClaims({ status: "active" });
      return claims.map((c) => claimToEntity(c, () => Date.now(), NAMESPACE));
    }, [provider]);

    // Scoped sessions: `useEntityWatchEnabled` returns false in scoped mode,
    // and `provider.getClaims` is namespace-global (no session filter), so
    // the fallback would render claims from OTHER sessions. Render an empty
    // state instead until session-scoped claim filtering lands. Mirrors the
    // ClaimsView short-circuit.
    //
    // Clear any latched selection so the terminal/input panel doesn't keep
    // targeting an agent from the previous (un-scoped) view. Without this,
    // selectedSession survives the transition into scoped mode and the
    // operator's keystrokes would still hit the prior session.
    useEffect(() => {
      if (isScoped && onSelectSession) onSelectSession(undefined);
    }, [isScoped, onSelectSession]);

    if (isScoped) {
      return (
        <box flexDirection="column">
          <box marginBottom={1}>
            <text>Agents (0)</text>
          </box>
          <EmptyState
            title="No agents registered."
            hint="Press r to register, or Ctrl+P to spawn."
          />
        </box>
      );
    }

    return (
      <EntityView
        kind="Claim"
        columns={columns}
        provider={provider}
        active={active}
        cursor={cursor}
        predicate={predicate}
        sort={byRoleAndName}
        fallbackFetcher={fallbackFetcher}
        title="Agents"
        emptyTitle="No agents registered."
        emptyHint="Press r to register, or Ctrl+P to spawn."
        onSelect={onSelect}
      />
    );
  },
);
