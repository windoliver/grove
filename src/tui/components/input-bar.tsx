/**
 * Input bar component for terminal input mode status.
 *
 * Displayed when the user enters terminal input mode (press 'i'
 * while the Terminal panel is focused). Shows which session
 * keystrokes are being sent to.
 */

import React from "react";

/** Props for the InputBar component. */
export interface InputBarProps {
  readonly visible: boolean;
  readonly sessionName?: string | undefined;
}

/** Terminal input mode status bar. */
export const InputBar: React.NamedExoticComponent<InputBarProps> = React.memo(function InputBar({
  visible,
  sessionName,
}: InputBarProps): React.ReactNode {
  if (!visible) {
    return null;
  }

  const target = sessionName ?? "(none)";

  return (
    <box paddingLeft={1} paddingRight={1}>
      <text color="#ffcc00">[INPUT MODE]</text>
      <text color="#888888"> Sending to: </text>
      <text color="#ffffff">{target}</text>
      <text color="#888888"> — Esc to exit</text>
    </box>
  );
});
