/**
 * Dedicated slash command-line input for the TUI (#275 Task 11).
 *
 * Opened with `:` (vim-style). Shows a `:` prompt followed by the live buffer
 * and a cursor caret. On submit, the parent prepends `/` and resolves the input
 * against the slash index. An optional error line is shown below the prompt.
 */

import type React from "react";
import { theme } from "../theme.js";

export interface SlashInputProps {
  readonly visible: boolean;
  readonly buffer: string;
  readonly error?: string | undefined;
}

export function SlashInput({ visible, buffer, error }: SlashInputProps): React.ReactNode {
  if (!visible) return null;
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text color={theme.focus}>:</text>
        <text color={theme.text}>{buffer}</text>
        <text color={theme.secondary}>▏</text>
      </box>
      {error ? <text color={theme.disabled}>{error}</text> : null}
    </box>
  );
}
