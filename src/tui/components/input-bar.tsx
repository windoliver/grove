/**
 * Input bar component for terminal input mode status.
 *
 * Displayed when the user enters terminal input mode (press 'i'
 * while the Terminal panel is focused). Shows which session
 * keystrokes are being sent to.
 */

import React from "react";
import { theme } from "../theme.js";

/** Props for the InputBar component. */
export interface InputBarProps {
  readonly visible: boolean;
  readonly sessionName?: string | undefined;
  readonly messageLabel?: string | undefined;
}

/** Terminal input mode status bar. */
export const InputBar: React.NamedExoticComponent<InputBarProps> = React.memo(function InputBar({
  visible,
  sessionName,
  messageLabel,
}: InputBarProps): React.ReactNode {
  if (!visible) {
    return null;
  }

  if (messageLabel) {
    return (
      <box paddingLeft={1} paddingRight={1} flexDirection="row">
        <text color={theme.warning}>[MESSAGE]</text>
        <text color={theme.muted}> </text>
        <text color={theme.text}>{messageLabel}</text>
        <text color={theme.muted}> — Enter to send, Esc to cancel</text>
      </box>
    );
  }

  const target = sessionName ?? "(none)";

  return (
    <box paddingLeft={1} paddingRight={1} flexDirection="row">
      <text color={theme.warning}>[INPUT MODE]</text>
      <text color={theme.muted}> Sending to: </text>
      <text color={theme.text}>{target}</text>
      <text color={theme.muted}> — Esc to exit</text>
    </box>
  );
});
