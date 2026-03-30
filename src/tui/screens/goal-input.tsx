/**
 * Screen 2: Goal input — text input for session goal.
 *
 * Single Enter transitions to Launch Preview (auto-detect + confirm).
 * Goal-first flow: user says WHAT before configuring HOW.
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

/** Screen 2: goal text input. Single Enter → launch preview. */
export const GoalInput: React.NamedExoticComponent<GoalInputProps> = React.memo(function GoalInput({
  presetName,
  topology,
  roleMapping,
  onSubmit,
  onBack,
}: GoalInputProps): React.ReactNode {
  const [buffer, setBuffer] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);

  useKeyboard(
    useCallback(
      (key) => {
        const input = key.name;
        const isCtrl = key.ctrl;

        if (input === "escape") {
          onBack();
          return;
        }
        if (input === "return") {
          const goal = buffer.trim();
          if (goal.length === 0) {
            setShowEmpty(true);
            return;
          }
          onSubmit(goal);
          return;
        }

        setShowEmpty(false);

        if (input === "backspace") {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        if (isCtrl && input === "u") {
          setBuffer("");
          return;
        }
        if (input === "space") {
          setBuffer((b) => `${b} `);
          return;
        }
        if (input && input.length === 1 && !isCtrl) {
          setBuffer((b) => b + input);
          return;
        }
      },
      [buffer, onSubmit, onBack],
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
        <text color={theme.text}>What should agents work on?</text>
      </box>

      {/* Input field */}
      <box
        flexDirection="column"
        marginX={2}
        marginTop={1}
        borderStyle="single"
        borderColor={showEmpty ? theme.error : theme.focus}
        paddingX={1}
      >
        <box flexDirection="row">
          <text color={theme.focus} bold>
            {"> "}
          </text>
          <text color={theme.text}>{buffer}</text>
          <text color={theme.focus}>_</text>
        </box>
      </box>

      {/* Empty validation message */}
      {showEmpty ? (
        <box paddingX={2} marginTop={1}>
          <text color={theme.error}>Goal cannot be empty</text>
        </box>
      ) : null}

      {/* Agent preview — what will be configured next */}
      {agentCount > 0 ? (
        <box flexDirection="column" marginX={2} marginTop={1} paddingX={1}>
          <text color={theme.secondary}>
            {agentCount} agent{agentCount !== 1 ? "s" : ""} will be configured:
          </text>
          {roles.map((role) => {
            const cli = roleMapping?.get(role.name) ?? role.command ?? "claude";
            const platformColor = PLATFORM_COLORS[role.platform ?? "claude-code"] ?? theme.text;
            return (
              <box key={role.name} flexDirection="row">
                <text color={theme.secondary}> </text>
                <text color={theme.text}>{role.name}</text>
                <text color={theme.secondary}> (</text>
                <text color={platformColor}>{cli}</text>
                <text color={theme.secondary}>)</text>
              </box>
            );
          })}
        </box>
      ) : null}

      {/* Hints */}
      <box paddingX={2} marginTop={1}>
        <text color={theme.secondary}>Enter:continue Esc:back Ctrl+U:clear</text>
      </box>
    </box>
  );
});
