/**
 * <Prompt> — k9s-style command/filter input overlay.
 *
 * Presentational: renders the bottom-line input and (in goto mode)
 * a dropdown of suggestions. All keystrokes routed by parent.
 */

import React from "react";
import { theme } from "../theme.js";

export type PromptMode = "none" | "goto" | "filter";

export interface PromptProps {
  readonly mode: PromptMode;
  readonly query: string;
  readonly suggestions?: readonly string[] | undefined;
  readonly suggestionIndex?: number | undefined;
  readonly error?: string | undefined;
}

export const Prompt: React.NamedExoticComponent<PromptProps> = React.memo(function Prompt({
  mode,
  query,
  suggestions,
  suggestionIndex,
  error,
}: PromptProps): React.ReactNode {
  if (mode === "none") return null;

  const sigil = mode === "goto" ? ":" : "/";
  const showDropdown = mode === "goto" && (suggestions?.length ?? 0) > 1;
  const idx = suggestionIndex ?? 0;

  return (
    <box flexDirection="column" paddingX={2}>
      {showDropdown && suggestions ? (
        <box flexDirection="column">
          {suggestions.map((s, i) => {
            const selected = i === idx;
            return (
              <box key={s} flexDirection="row">
                <text color={selected ? theme.focus : theme.secondary}>
                  {selected ? "> " : "  "}
                  {s}
                </text>
              </box>
            );
          })}
        </box>
      ) : null}
      <box flexDirection="row">
        <text color={theme.focus}>{sigil}</text>
        <text>{query}</text>
        <text color={theme.secondary}>{"▌"}</text>
      </box>
      {error ? (
        <box flexDirection="row">
          <text color={theme.error}>{error}</text>
        </box>
      ) : null}
    </box>
  );
});
