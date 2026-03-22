/**
 * Screen 3: Goal input — text input for session goal.
 *
 * "What should agents do?" On Enter -> auto-spawn agents and
 * transition to Screen 4. Esc goes back.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useState } from "react";
import { theme } from "../theme.js";

/** Props for the GoalInput screen. */
export interface GoalInputProps {
  readonly presetName: string;
  readonly onSubmit: (goal: string) => void;
  readonly onBack: () => void;
}

/** Screen 3: goal text input with Enter to submit. */
export const GoalInput: React.NamedExoticComponent<GoalInputProps> = React.memo(function GoalInput({
  presetName,
  onSubmit,
  onBack,
}: GoalInputProps): React.ReactNode {
  const [buffer, setBuffer] = useState("");

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
          if (goal.length > 0) {
            onSubmit(goal);
          }
          return;
        }
        if (input === "backspace") {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        // Ctrl+U clears the buffer
        if (isCtrl && input === "u") {
          setBuffer("");
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

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      borderStyle="round"
      borderColor={theme.focus}
    >
      <box flexDirection="column" paddingX={2} paddingTop={1}>
        <text color={theme.focus} bold>
          Session Goal
        </text>
        <text color={theme.muted}>Preset: {presetName}</text>
        <text color={theme.muted}>{""}</text>
        <text color={theme.text}>What should agents do?</text>
        <text color={theme.muted}>{""}</text>
      </box>

      {/* Input field */}
      <box
        flexDirection="column"
        marginX={2}
        borderStyle="single"
        borderColor={theme.focus}
        paddingX={1}
        paddingY={1}
      >
        <box flexDirection="row">
          <text color={theme.focus} bold>
            {"> "}
          </text>
          <text color={theme.text}>{buffer}</text>
          <text color={theme.focus}>_</text>
        </box>
      </box>

      {/* Hints */}
      <box flexDirection="column" paddingX={2} marginTop={1}>
        <text color={theme.muted}>Agents will be auto-spawned when you press Enter.</text>
        <text color={theme.muted}>{""}</text>
        <text color={theme.dimmed}>Enter:start agents Esc:back Ctrl+U:clear</text>
      </box>
    </box>
  );
});
