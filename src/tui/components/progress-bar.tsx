/**
 * Metric progress bar for RunningView.
 *
 * Shows target metric name, visual bar, percentage, and threshold.
 * Example: val_bpb ████░░░░░░ 37% (≤0.95)
 */

import React from "react";
import { theme } from "../theme.js";

export interface ProgressBarProps {
  /** Metric name (e.g. "val_bpb"). */
  readonly label: string;
  /** Current value. */
  readonly value: number;
  /** Target threshold. */
  readonly target: number;
  /** Direction: minimize means value should go below target. */
  readonly direction: "minimize" | "maximize";
  /** Bar width in characters (default 20). */
  readonly width?: number | undefined;
}

export const ProgressBar: React.NamedExoticComponent<ProgressBarProps> = React.memo(
  function ProgressBar({
    label,
    value,
    target,
    direction,
    width = 20,
  }: ProgressBarProps): React.ReactNode {
    // Calculate progress (0-1 clamped)
    let progress: number;
    if (direction === "minimize") {
      // For minimize: progress increases as value approaches target from above
      // Assume starting value is roughly 2x the target
      const startEstimate = target * 2;
      progress = Math.max(0, Math.min(1, (startEstimate - value) / (startEstimate - target)));
    } else {
      // For maximize: progress is value / target
      progress = Math.max(0, Math.min(1, value / target));
    }

    const percent = Math.round(progress * 100);
    const filled = Math.round(progress * width);
    const empty = width - filled;
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

    const op = direction === "minimize" ? "\u2264" : "\u2265";
    const color = percent >= 100 ? theme.success : percent >= 60 ? theme.warning : theme.info;

    return (
      <box flexDirection="row" paddingX={1}>
        <text color={theme.muted}>{label} </text>
        <text color={color}>{bar}</text>
        <text color={theme.text}> {percent}%</text>
        <text color={theme.dimmed}>
          {" "}
          ({op}
          {target})
        </text>
      </box>
    );
  },
);
