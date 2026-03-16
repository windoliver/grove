/**
 * Pipeline view — horizontal strip of agent cards showing delegation flow.
 *
 * Renders active agents as: [coordinator] → [worker-1] → [worker-2]
 * Each card shows agent name, status spinner, last few lines of output,
 * and token count. Toggled via V key cycle (item 11).
 */

import React, { useCallback, useEffect, useState } from "react";
import type { Claim } from "../../core/models.js";
import type { TmuxManager } from "../agents/tmux-manager.js";
import { agentIdFromSession } from "../agents/tmux-manager.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";
import { BRAILLE_SPINNER, PLATFORM_COLORS, theme } from "../theme.js";

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
function buildPipeline(
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

/** Pipeline view component. */
export const PipelineView: React.NamedExoticComponent<PipelineViewProps> = React.memo(
  function PipelineView({
    provider,
    tmux,
    intervalMs,
    active,
  }: PipelineViewProps): React.ReactNode {
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => {
        setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
      }, 100);
      return () => clearInterval(timer);
    }, [active]);

    const claimsFetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
    const { data: claims } = usePolledData<readonly Claim[]>(claimsFetcher, intervalMs, active);

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

    // Capture last few lines of output per session
    const outputsFetcher = useCallback(async () => {
      if (!tmux || !sessions) return new Map<string, string>();
      const map = new Map<string, string>();
      for (const s of sessions) {
        try {
          const out = await tmux.capturePanes(s);
          map.set(s, out);
        } catch {
          // skip failed captures
        }
      }
      return map;
    }, [tmux, sessions]);
    const { data: outputs } = usePolledData<Map<string, string>>(
      outputsFetcher,
      intervalMs * 2,
      active && !!tmux && (sessions?.length ?? 0) > 0,
    );

    const pipeline = buildPipeline(claims ?? [], sessions ?? [], outputs ?? new Map());

    if (pipeline.length === 0) {
      return (
        <box>
          <text opacity={0.5}>No agents in pipeline. Spawn agents with Ctrl+P.</text>
        </box>
      );
    }

    return (
      <box flexDirection="row" flexWrap="wrap">
        {pipeline.map((card, i) => {
          const spinner =
            card.status === "running"
              ? (BRAILLE_SPINNER[spinnerFrame % BRAILLE_SPINNER.length] ?? "\u25cf")
              : card.status === "error"
                ? "\u2717"
                : "\u25cb";
          const color = PLATFORM_COLORS[card.platform] ?? theme.muted;
          const arrow = i > 0 ? " \u2192 " : "";

          return (
            <box key={card.agentId} flexDirection="column">
              {i > 0 && (
                <box>
                  <text color={theme.dimmed}>{arrow}</text>
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
                <text color={theme.muted}>
                  {card.role} | {card.platform}
                </text>
                {card.lastLines.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    {card.lastLines.map((line, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no stable identity
                      <text key={j} color={theme.dimmed}>
                        {line.length > 24 ? `${line.slice(0, 22)}..` : line}
                      </text>
                    ))}
                  </box>
                )}
              </box>
            </box>
          );
        })}
      </box>
    );
  },
);
