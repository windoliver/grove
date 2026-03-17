/**
 * Side-by-side diff comparison component.
 *
 * Renders two content panes side-by-side with labels and optional
 * metric badges, suitable for comparing artifact versions.
 */

import React from "react";
import { theme } from "../theme.js";

/** Maximum lines displayed before truncation. */
const MAX_VISIBLE_LINES = 20;

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
  const leftLines = leftContent.split("\n");
  const rightLines = rightContent.split("\n");
  const maxLines = Math.max(leftLines.length, rightLines.length, 1);

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
      {/* Content */}
      {Array.from({ length: Math.min(maxLines, MAX_VISIBLE_LINES) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
        <box key={i} flexDirection="row">
          <box flexGrow={1}>
            <text>{leftLines[i] ?? ""}</text>
          </box>
          <text opacity={0.3}>|</text>
          <box flexGrow={1}>
            <text>{rightLines[i] ?? ""}</text>
          </box>
        </box>
      ))}
      {maxLines > MAX_VISIBLE_LINES && (
        <text opacity={0.5}>{`... ${maxLines - MAX_VISIBLE_LINES} more lines`}</text>
      )}
    </box>
  );
});
