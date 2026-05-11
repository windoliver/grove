/**
 * Screen 3.5: Spawn progress — per-agent spawn status.
 *
 * Shows progressive status for each agent being spawned:
 *   ○ waiting → ⣷ spawning... → ● started (or ✗ failed)
 *
 * Auto-transitions to RunningView when all agents are resolved.
 */

import { useTimeline } from "@opentui/react";
import { toast } from "@opentui-ui/toast/react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceMode } from "../../core/workspace-provisioner.js";
import { useInterval } from "../../local/use-interval.js";
import { BRAILLE_SPINNER, PLATFORM_COLORS, theme } from "../theme.js";

/** Spawn status for a single agent role. */
export type SpawnStatus = "waiting" | "spawning" | "started" | "failed";

/** Per-agent spawn state. */
export interface AgentSpawnState {
  readonly role: string;
  readonly command: string;
  readonly status: SpawnStatus;
  readonly error?: string | undefined;
  /** Workspace mode — set when status is "started". */
  readonly workspaceMode?: WorkspaceMode | undefined;
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
  waiting: theme.secondary,
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
    // Braille spinner animation — discrete frame cycling at 80ms.
    const [spinnerFrame, setSpinnerFrame] = useState(0);
    useInterval(() => setSpinnerFrame((f) => (f + 1) % BRAILLE_SPINNER.length), 80);

    // Smooth opacity pulse for spawning agents via useTimeline tween
    const [spawnOpacity, setSpawnOpacity] = useState(1);
    const pulseTarget = useRef({ opacity: 1 });
    const timeline = useTimeline({ loop: true, duration: 900 });

    useEffect(() => {
      timeline
        .add(
          pulseTarget.current,
          {
            opacity: 0.4,
            duration: 450,
            ease: "easeInOutSine",
            onUpdate: (anim: { targets: object[] }) => {
              const t = anim.targets[0] as { opacity: number };
              setSpawnOpacity(t.opacity);
            },
          },
          0,
        )
        .add(
          pulseTarget.current,
          {
            opacity: 1,
            duration: 450,
            ease: "easeInOutSine",
            onUpdate: (anim: { targets: object[] }) => {
              const t = anim.targets[0] as { opacity: number };
              setSpawnOpacity(t.opacity);
            },
          },
          450,
        )
        .play();
    }, [timeline]);

    // Toast on status changes
    const prevStatusRef = useRef<Map<string, SpawnStatus>>(new Map());
    useEffect(() => {
      for (const agent of agents) {
        const prev = prevStatusRef.current.get(agent.role);
        if (prev !== agent.status) {
          if (agent.status === "started") {
            toast.success(`${agent.role} started`);
          } else if (agent.status === "failed") {
            toast.error(`${agent.role} failed: ${agent.error ?? "unknown"}`);
          }
          prevStatusRef.current.set(agent.role, agent.status);
        }
      }
    }, [agents]);

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
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          {agents.map((agent) => {
            const platformColor =
              PLATFORM_COLORS[agent.command] ?? PLATFORM_COLORS.custom ?? theme.text;
            // Apply pulsing opacity to agents actively spawning
            const rowOpacity = agent.status === "spawning" ? spawnOpacity : 1;

            // Workspace mode badge — shown only when degraded
            const wsMode = agent.workspaceMode;
            const degradedBadge =
              wsMode?.status === "fallback_workspace"
                ? " [shared workspace]"
                : wsMode?.status === "bootstrap_failed"
                  ? " [no config]"
                  : "";

            return (
              <box key={agent.role} flexDirection="column" opacity={rowOpacity}>
                <box flexDirection="row">
                  <text color={STATUS_COLOR[agent.status]}>{getIcon(agent.status)} </text>
                  <text color={theme.text}>{agent.role}</text>
                  <text color={theme.secondary}> ({agent.command})</text>
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
                  {degradedBadge ? <text color={theme.warning}>{degradedBadge}</text> : null}
                </box>
                {/* Show reason for degraded modes inline, truncated to fit */}
                {wsMode?.status === "fallback_workspace" ||
                wsMode?.status === "bootstrap_failed" ? (
                  <box flexDirection="row" marginLeft={4}>
                    <text color={theme.warning}>{`⚠  ${(wsMode.reason ?? "").slice(0, 80)}`}</text>
                  </box>
                ) : null}
              </box>
            );
          })}
        </box>

        {/* Goal and preset info */}
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <box flexDirection="row">
            <text color={theme.secondary}>Goal: </text>
            <text color={theme.text}>{goal.slice(0, 60)}</text>
          </box>
          {presetName ? (
            <box flexDirection="row">
              <text color={theme.secondary}>Preset: </text>
              <text color={theme.text}>{presetName}</text>
            </box>
          ) : null}
        </box>
      </box>
    );
  },
);
