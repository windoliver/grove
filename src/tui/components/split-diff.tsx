/**
 * Side-by-side diff comparison component.
 *
 * Delegates to OpenTUI's <diff> intrinsic for built-in syntax-aware
 * split rendering. Labels and optional metric badges are rendered above.
 */

import React from "react";
import { theme } from "../theme.js";

/** Props for the SplitDiff component. */
export interface SplitDiffProps {
  /** Label for the left pane (e.g. "parent" or version identifier). */
  readonly leftLabel: string;
  /** Label for the right pane. */
  readonly rightLabel: string;
  /** Text content for the left pane. */
  readonly leftContent: string;
  /** Text content for the right pane. */
  readonly rightContent: string;
  /** Optional metric string displayed next to the left label. */
  readonly leftMetric?: string | undefined;
  /** Optional metric string displayed next to the right label. */
  readonly rightMetric?: string | undefined;
}

/** Side-by-side content comparison panel. */
export const SplitDiff: React.NamedExoticComponent<SplitDiffProps> = React.memo(function SplitDiff({
  leftLabel,
  rightLabel,
  leftContent,
  rightContent,
  leftMetric,
  rightMetric,
}: SplitDiffProps): React.ReactNode {
  // Cap content to prevent render freezes on large contributions
  const MAX_DIFF_CHARS = 32 * 1024;
  const left =
    leftContent.length > MAX_DIFF_CHARS
      ? `${leftContent.slice(0, MAX_DIFF_CHARS)}\n\n--- truncated (${leftContent.length} chars) ---`
      : leftContent;
  const right =
    rightContent.length > MAX_DIFF_CHARS
      ? `${rightContent.slice(0, MAX_DIFF_CHARS)}\n\n--- truncated (${rightContent.length} chars) ---`
      : rightContent;

  return (
    <box flexDirection="column">
      {/* Headers */}
      <box flexDirection="row">
        <box flexGrow={1} flexDirection="row">
          <text color={theme.focus}>{leftLabel}</text>
          {leftMetric && <text opacity={0.5}> {leftMetric}</text>}
        </box>
        <text opacity={0.3}>|</text>
        <box flexGrow={1} flexDirection="row">
          <text color={theme.compare}>{rightLabel}</text>
          {rightMetric && <text opacity={0.5}> {rightMetric}</text>}
        </box>
      </box>
      {/* Diff content */}
      <diff oldContent={left} newContent={right} mode="split" />
    </box>
  );
});
