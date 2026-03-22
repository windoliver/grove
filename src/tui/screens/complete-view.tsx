/**
 * Screen 5: Complete view — session summary.
 *
 * Shows: "Session complete" + reason, contribution count, duration.
 * Enter: new session (same preset), q: quit.
 */

import { useKeyboard } from "@opentui/react";
import React, { useCallback } from "react";
import { theme } from "../theme.js";

/** Props for the CompleteView screen. */
export interface CompleteViewProps {
  readonly reason: string;
  readonly contributionCount: number;
  readonly duration?: string | undefined;
  readonly presetName?: string | undefined;
  readonly onNewSession: () => void;
  readonly onQuit: () => void;
}

/** Screen 5: session complete summary. */
export const CompleteView: React.NamedExoticComponent<CompleteViewProps> = React.memo(
  function CompleteView({
    reason,
    contributionCount,
    duration,
    presetName,
    onNewSession,
    onQuit,
  }: CompleteViewProps): React.ReactNode {
    useKeyboard(
      useCallback(
        (key) => {
          if (key.name === "return") {
            onNewSession();
            return;
          }
          if (key.name === "q") {
            onQuit();
            return;
          }
        },
        [onNewSession, onQuit],
      ),
    );

    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        borderStyle="round"
        borderColor={theme.success}
      >
        <box flexDirection="column" paddingX={2} paddingTop={1}>
          <text color={theme.success} bold>
            Session Complete
          </text>
          <text color={theme.muted}>{""}</text>
        </box>

        {/* Reason */}
        <box
          flexDirection="column"
          marginX={2}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Reason
          </text>
          <text color={theme.muted}>{reason}</text>
        </box>

        {/* Stats */}
        <box
          flexDirection="column"
          marginX={2}
          marginTop={1}
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
        >
          <text color={theme.text} bold>
            Session Stats
          </text>
          <box flexDirection="row">
            <text color={theme.info}>{"  Contributions: "}</text>
            <text color={theme.text}>{String(contributionCount)}</text>
          </box>
          {duration ? (
            <box flexDirection="row">
              <text color={theme.info}>{"  Duration:      "}</text>
              <text color={theme.text}>{duration}</text>
            </box>
          ) : null}
          {presetName ? (
            <box flexDirection="row">
              <text color={theme.info}>{"  Preset:        "}</text>
              <text color={theme.text}>{presetName}</text>
            </box>
          ) : null}
        </box>

        {/* Keyboard hints */}
        <box paddingX={2} marginTop={1}>
          <text color={theme.dimmed}>Enter:new session (same preset) q:quit</text>
        </box>
      </box>
    );
  },
);
