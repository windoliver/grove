/**
 * Pipeline view — horizontal strip of agent cards showing delegation flow.
 *
 * Renders active agents as: [coordinator] → [worker-1] → [worker-2]
 * Each card shows agent name, status spinner, last few lines of output,
 * and token count. Toggled via V key cycle (item 11).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import type { Claim } from "../../core/models.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { useEntityWatchEnabled } from "../hooks/informer-context.js";
import { useEntities } from "../hooks/use-entities.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, PLATFORM_COLORS, theme } from "../theme.js";

const ACTIVE_PREDICATE = (e: ClaimEntity): boolean => e.status.phase === "active";

function entityToClaim(e: ClaimEntity): Claim {
  return {
    claimId: e.id,
    targetRef: e.spec.targetRef,
    agent: e.spec.agent,
    status: e.status.phase,
    intentSummary: e.spec.intentSummary,
    createdAt: e.metadata.creationTimestamp ?? e.status.heartbeatAt,
    heartbeatAt: e.status.heartbeatAt,
    leaseExpiresAt: e.status.leaseExpiresAt,
    context: e.spec.context,
    attemptCount: e.status.attemptCount,
  };
}

/** Props for the PipelineView. */
export interface PipelineViewProps {
  readonly provider: TuiDataProvider;
  readonly tmux?: TmuxManager | undefined;
  readonly intervalMs: number;
  readonly active: boolean;
}

/** A single agent card in the pipeline. */
interface AgentCard {
  readonly agentId: string;
  readonly role: string;
  readonly platform: string;
  readonly status: string;
  readonly parentId?: string | undefined;
  readonly sessionName?: string | undefined;
  readonly lastLines: readonly string[];
}

/** Build the pipeline from claims + tmux sessions. */
export function buildPipeline(
  claims: readonly Claim[],
  tmuxSessions: readonly string[],
  outputs: ReadonlyMap<string, string>,
): readonly AgentCard[] {
  const sessionMap = new Map<string, string>();
  for (const name of tmuxSessions) {
    const id = agentIdFromSession(name);
    if (id) sessionMap.set(id, name);
  }

  // Build cards sorted by depth (coordinators first)
  const cards: AgentCard[] = claims.map((c) => {
    const session = sessionMap.get(c.agent.agentId);
    const raw = session ? (outputs.get(session) ?? "") : "";
    const allLines = raw.split("\n").filter((l) => l.trim());
    const lastLines = allLines.slice(-3);

    const remaining = new Date(c.leaseExpiresAt).getTime() - Date.now();
    const alive = session ? tmuxSessions.includes(session) : false;
    const status = remaining <= 0 ? "expired" : !alive ? "error" : "running";

    return {
      agentId: c.agent.agentName ?? c.agent.agentId,
      role: c.agent.role ?? "worker",
      platform: c.agent.platform ?? "custom",
      status,
      parentId: typeof c.context?.parentAgentId === "string" ? c.context.parentAgentId : undefined,
      sessionName: session,
      lastLines,
    };
  });

  // Sort: coordinators (no parent) first, then by agentId
  cards.sort((a, b) => {
    if (!a.parentId && b.parentId) return -1;
    if (a.parentId && !b.parentId) return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  return cards;
}

// ---------------------------------------------------------------------------
// AgentCardView — owns its own spinner state so the parent doesn't re-render
// ---------------------------------------------------------------------------

interface AgentCardViewProps {
  readonly card: AgentCard;
  readonly showArrow: boolean;
  readonly spinnerFrame: number;
}

/** Single agent card — receives spinner frame from parent's shared timer. */
const AgentCardView: React.NamedExoticComponent<AgentCardViewProps> = React.memo(
  function AgentCardView({ card, showArrow, spinnerFrame }: AgentCardViewProps): React.ReactNode {
    const spinner =
      card.status === "running"
        ? (BRAILLE_SPINNER[spinnerFrame % BRAILLE_SPINNER.length] ?? "\u25cf")
        : card.status === "error"
          ? "\u2717"
          : "\u25cb";
    const color = PLATFORM_COLORS[card.platform] ?? theme.secondary;

    return (
      <box key={card.agentId} flexDirection="column">
        {showArrow && (
          <box>
            <text color={theme.secondary}>{" \u2192 "}</text>
          </box>
        )}
        <box
          flexDirection="column"
          border
          borderStyle="round"
          borderColor={color}
          paddingX={1}
          width={28}
        >
          <text color={color} bold>
            {spinner} {card.agentId}
          </text>
          <text color={theme.secondary}>
            {card.role} | {card.platform}
          </text>
          {card.lastLines.length > 0 && (
            <box flexDirection="column" marginTop={1}>
              {card.lastLines.map((line, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no stable identity
                <text key={j} color={theme.secondary}>
                  {line.length > 24 ? `${line.slice(0, 22)}..` : line}
                </text>
              ))}
            </box>
          )}
        </box>
      </box>
    );
  },
);

// ---------------------------------------------------------------------------
// PipelineView
// ---------------------------------------------------------------------------

/** Pipeline view component. */
export const PipelineView: React.NamedExoticComponent<PipelineViewProps> = React.memo(
  function PipelineView({
    provider,
    tmux,
    intervalMs,
    active,
  }: PipelineViewProps): React.ReactNode {
    // One shared spinner timer for all cards — avoids O(n) intervals for n running agents.
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => {
        setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
      }, 100);
      return () => clearInterval(timer);
    }, [active]);

    const useInformerPath = useEntityWatchEnabled(provider, "Claim");

    const entityResult = useEntities("Claim", ACTIVE_PREDICATE);
    const claimsFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
    const polledClaims = usePolledData<readonly Claim[]>(
      claimsFetcher,
      intervalMs,
      active && !useInformerPath,
    );
    const claims = useInformerPath ? entityResult.data.map(entityToClaim) : polledClaims.data;

    const sessionsFetcher = useCallback(async () => {
      if (!tmux) return [] as readonly string[];
      const available = await tmux.isAvailable();
      if (!available) return [] as readonly string[];
      return tmux.listSessions();
    }, [tmux]);
    const { data: sessions } = usePolledData<readonly string[]>(
      sessionsFetcher,
      intervalMs * 2,
      active && !!tmux,
    );

    // Capture last few lines of output per session — parallelized.
    const outputsFetcher = useCallback(async () => {
      if (!tmux || !sessions) return new Map<string, string>();
      const entries = await Promise.all(
        sessions.map(async (s) => {
          try {
            const out = await tmux.capturePanes(s);
            return [s, out] as const;
          } catch {
            return [s, ""] as const;
          }
        }),
      );
      return new Map(entries);
    }, [tmux, sessions]);
    const { data: outputs } = usePolledData<Map<string, string>>(
      outputsFetcher,
      intervalMs * 2,
      active && !!tmux && (sessions?.length ?? 0) > 0,
    );

    // Memoize buildPipeline so spinner re-renders in AgentCardView don't recompute it.
    const pipeline = useMemo(
      () => buildPipeline(claims ?? [], sessions ?? [], outputs ?? new Map()),
      [claims, sessions, outputs],
    );

    if (pipeline.length === 0) {
      return (
        <box>
          <text opacity={0.5}>No agents in pipeline. Spawn agents with Ctrl+P.</text>
        </box>
      );
    }

    return (
      <box flexDirection="row" flexWrap="wrap">
        {pipeline.map((card, i) => (
          <AgentCardView
            key={card.agentId}
            card={card}
            showArrow={i > 0}
            spinnerFrame={spinnerFrame}
          />
        ))}
      </box>
    );
  },
);
