/**
 * Review-loop prompt — modal input bar that captures a goal and POSTs
 * two AgentTask records (coder + reviewer) via startReviewLoop().
 *
 * Displayed inline in RunningView when the user presses `r` (and there
 * is no pending ask_user contribution). The component is a controlled
 * input bar: the parent owns `text` + `onChar` + `onBackspace` so the
 * same reducer/ref pattern used for promptMode in running-view works here.
 *
 * Error messages are displayed inline and clear when the user starts
 * typing again.
 */

import React from "react";
import { theme } from "../theme.js";

export interface ReviewLoopPromptProps {
  /** Current goal text typed by the user. */
  readonly text: string;
  /** Error message to display (from a failed startReviewLoop call). */
  readonly error?: string | undefined;
  /** Whether the prompt is in a "submitting" (loading) state. */
  readonly submitting?: boolean | undefined;
}

/**
 * Inline input bar for the review-loop goal prompt.
 *
 * Rendered at the bottom of RunningView (similar to the Prompt component)
 * when reviewLoopMode is active. The parent wires key events via the
 * keyboard handler.
 */
export const ReviewLoopPrompt: React.NamedExoticComponent<ReviewLoopPromptProps> = React.memo(
  function ReviewLoopPrompt({ text, error, submitting }: ReviewLoopPromptProps): React.ReactNode {
    if (submitting) {
      return (
        <box paddingLeft={1} paddingRight={1} flexDirection="row">
          <text color={theme.warning}>[REVIEW LOOP]</text>
          <text color={theme.secondary}> Creating tasks...</text>
        </box>
      );
    }

    return (
      <box flexDirection="column">
        {error !== undefined && error.length > 0 && (
          <box paddingLeft={1} paddingRight={1}>
            <text color={theme.error}>{error}</text>
          </box>
        )}
        <box paddingLeft={1} paddingRight={1} flexDirection="row">
          <text color={theme.warning}>[REVIEW LOOP]</text>
          <text color={theme.secondary}> Goal: </text>
          <text color={theme.text}>{text}</text>
          <text color={theme.secondary}>█</text>
          <text color={theme.secondary}> — Enter to start, Esc to cancel</text>
        </box>
      </box>
    );
  },
);
