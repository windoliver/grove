/**
 * Transient error bar for the running view. Used by the C2 alias
 * resolver to surface cycle/depth/miss/parse errors.
 */

import React from "react";
import { theme } from "../theme.js";

export interface FlashBarProps {
  readonly message: string | null;
}

export const FlashBar: React.NamedExoticComponent<FlashBarProps> = React.memo(function FlashBar({
  message,
}: FlashBarProps): React.ReactNode {
  if (!message) return null;
  return (
    <box paddingX={2}>
      <text color={theme.error}>{message}</text>
    </box>
  );
});
