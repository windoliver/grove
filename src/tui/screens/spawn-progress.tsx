/**
 * Screen 3.5: Spawn progress — per-agent spawn status.
 *
 * Shows progressive status for each agent being spawned:
 *   ○ waiting → ⣷ spawning... → ● started (or ✗ failed)
 *
 * Auto-transitions to RunningView when all agents are resolved.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { BreadcrumbBar } from "../components/breadcrumb-bar.js";
import { BRAILLE_SPINNER, PLATFORM_COLORS, theme } from "../theme.js";

/** Spawn status for a single agent role. */
export type SpawnStatus = "waiting" | "spawning" | "started" | "failed";

/** Per-agent spawn state. */
export interface AgentSpawnState {
  readonly role: string;
  readonly command: string;
  readonly status: SpawnStatus;
  readonly error?: string | undefined;
}

export interface SpawnProgressProps {
  readonly agents: readonly AgentSpawnState[];
  readonly goal: string;
  readonly presetName?: string | undefined;
  readonly onAllResolved: () => void;
}

const STATUS_ICON: Record<SpawnStatus, string> = {
  waiting: "\u25cb", // ○
  spawning: "", // filled by spinner
  started: "\u25cf", // ●
  failed: "\u2717", // ✗
};

const STATUS_COLOR: Record<SpawnStatus, string> = {
  waiting: theme.dimmed,
  spawning: theme.warning,
  started: theme.success,
  failed: theme.error,
};

export const SpawnProgress: React.NamedExoticComponent<SpawnProgressProps> = React.memo(
  function SpawnProgress({
    agents,
    goal,
    presetName,
    onAllResolved,
  }: SpawnProgressProps): React.ReactNode {
    // Braille spinner animation
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    useEffect(() => {
      timerRef.current = setInterval(() => {
        setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length);
      }, 80);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }, []);

    // Auto-transition when all agents are resolved
    const onAllResolvedRef = useRef(onAllResolved);
    onAllResolvedRef.current = onAllResolved;
    useEffect(() => {
      const allResolved = agents.every((a) => a.status === "started" || a.status === "failed");
      if (allResolved && agents.length > 0) {
        // Small delay so user can see final state
        const timeout = setTimeout(() => onAllResolvedRef.current(), 800);
        return () => clearTimeout(timeout);
      }
    }, [agents]);

    const getIcon = useCallback(
      (status: SpawnStatus) => {
        if (status === "spawning") return BRAILLE_SPINNER[spinnerFrame] ?? "\u283f";
        return STATUS_ICON[status];
      },
      [spinnerFrame],
    );

    return (
      <box flexDirection="column" width="100%" height="100%">
        <BreadcrumbBar screen="spawning" presetName={presetName} width={100} />

        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.text} bold>
            Starting session...
          </text>
        </box>

        {/* Per-agent spawn status */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          {agents.map((agent) => {
            const platformColor =
              PLATFORM_COLORS[agent.command] ?? PLATFORM_COLORS.custom ?? theme.text;
            return (
              <box key={agent.role} flexDirection="row">
                <text color={STATUS_COLOR[agent.status]}>{getIcon(agent.status)} </text>
                <text color={theme.text}>{agent.role}</text>
                <text color={theme.dimmed}> ({agent.command})</text>
                <text color={platformColor}>
                  {"  "}
                  {agent.status === "waiting"
                    ? "waiting..."
                    : agent.status === "spawning"
                      ? "spawning..."
                      : agent.status === "started"
                        ? "started"
                        : `failed: ${agent.error ?? "unknown"}`}
                </text>
              </box>
            );
          })}
        </box>

        {/* Goal and preset info */}
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <box flexDirection="row">
            <text color={theme.muted}>Goal: </text>
            <text color={theme.text}>{goal.slice(0, 60)}</text>
          </box>
          {presetName ? (
            <box flexDirection="row">
              <text color={theme.muted}>Preset: </text>
              <text color={theme.text}>{presetName}</text>
            </box>
          ) : null}
        </box>
      </box>
    );
  },
);
