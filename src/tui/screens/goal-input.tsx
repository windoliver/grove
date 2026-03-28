/**
 * Screen 3: Goal input — text input for session goal.
 *
 * Shows what will happen on Enter (spawn preview) and requires
 * explicit confirmation before spawning agents.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useState } from "react";
import type { AgentTopology } from "../../core/topology.js";
import { BreadcrumbBar } from "../components/breadcrumb-bar.js";
import { PLATFORM_COLORS, theme } from "../theme.js";

/** Props for the GoalInput screen. */
export interface GoalInputProps {
  readonly presetName: string;
  /** Topology for spawn preview. */
  readonly topology?: AgentTopology | undefined;
  /** Role-to-CLI mapping from agent detect. */
  readonly roleMapping?: ReadonlyMap<string, string> | undefined;
  readonly onSubmit: (goal: string) => void;
  readonly onBack: () => void;
}

/** Screen 3: goal text input with spawn preview and confirmation. */
export const GoalInput: React.NamedExoticComponent<GoalInputProps> = React.memo(function GoalInput({
  presetName,
  topology,
  roleMapping,
  onSubmit,
  onBack,
}: GoalInputProps): React.ReactNode {
  const [buffer, setBuffer] = useState("");
  const [confirming, setConfirming] = useState(false);

  useKeyboard(
    useCallback(
      (key) => {
        const input = key.name;
        const isCtrl = key.ctrl;

        if (input === "escape") {
          if (confirming) {
            setConfirming(false);
            return;
          }
          onBack();
          return;
        }
        if (input === "return") {
          const goal = buffer.trim();
          if (goal.length === 0) return;

          if (!confirming) {
            // First Enter: show confirmation
            setConfirming(true);
            return;
          }
          // Second Enter: confirm and submit
          onSubmit(goal);
          return;
        }

        // Don't allow editing during confirmation
        if (confirming) return;

        if (input === "backspace") {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        if (isCtrl && input === "u") {
          setBuffer("");
          return;
        }
        // Space key comes through as key.name === "space"
        if (input === "space") {
          setBuffer((b) => `${b} `);
          return;
        }
        if (input && input.length === 1 && !isCtrl) {
          setBuffer((b) => b + input);
          return;
        }
      },
      [buffer, confirming, onSubmit, onBack],
    ),
  );

  const roles = topology?.roles ?? [];
  const agentCount = roles.length;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      borderStyle="round"
      borderColor={theme.focus}
    >
      <BreadcrumbBar screen="goal-input" presetName={presetName} width={100} />

      <box flexDirection="column" paddingX={2} paddingTop={1}>
        <text color={theme.text}>What should agents do?</text>
      </box>

      {/* Input field */}
      <box
        flexDirection="column"
        marginX={2}
        marginTop={1}
        borderStyle="single"
        borderColor={confirming ? theme.warning : theme.focus}
        paddingX={1}
      >
        <box flexDirection="row">
          <text color={theme.focus} bold>
            {"> "}
          </text>
          <text color={theme.text}>{buffer}</text>
          {!confirming ? <text color={theme.focus}>_</text> : null}
        </box>
      </box>

      {/* Spawn preview — what will happen on Enter */}
      {agentCount > 0 ? (
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <text color={theme.muted}>
            {agentCount} agent{agentCount !== 1 ? "s" : ""} will spawn:
          </text>
          {roles.map((role) => {
            const cli = roleMapping?.get(role.name) ?? role.command ?? "claude";
            const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
            return (
              <box key={role.name} flexDirection="row">
                <text color={theme.dimmed}> </text>
                <text color={theme.text}>{role.name}</text>
                <text color={theme.dimmed}> (</text>
                <text color={platformColor}>{cli}</text>
                <text color={theme.dimmed}>)</text>
              </box>
            );
          })}
        </box>
      ) : null}

      {/* Confirmation bar */}
      {confirming ? (
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.warning}
          paddingX={1}
        >
          <text color={theme.warning} bold>
            Confirm spawn?
          </text>
          <text color={theme.muted}>
            Press Enter to start {agentCount} agent{agentCount !== 1 ? "s" : ""}, Esc to cancel
          </text>
        </box>
      ) : null}

      {/* Hints */}
      <box paddingX={2} marginTop={1}>
        <text color={theme.dimmed}>
          {confirming
            ? "Enter:confirm spawn  Esc:cancel"
            : "Enter:preview spawn  Esc:back  Ctrl+U:clear"}
        </text>
      </box>
    </box>
  );
});
