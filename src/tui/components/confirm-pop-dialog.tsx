/**
 * ConfirmPopDialog: modal overlay for "Discard unsaved changes?" confirmation.
 *
 * Presentational component — does not handle keyboard input. The router (Task 6)
 * will route keystrokes to onConfirm/onCancel props.
 */

import React from "react";
import { theme } from "../theme.js";

export interface ConfirmPopDialogProps {
  readonly visible: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export const ConfirmPopDialog: React.NamedExoticComponent<ConfirmPopDialogProps> = React.memo(
  function ConfirmPopDialog({ visible }: ConfirmPopDialogProps) {
    if (!visible) return null;
    return (
      <box
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        borderColor={theme.focus}
      >
        <text bold color={theme.focus}>
          Discard unsaved changes?
        </text>
        <text color={theme.secondary}>[y] discard and go back [n] stay</text>
      </box>
    );
  },
);
