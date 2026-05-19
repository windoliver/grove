/**
 * Gauge — render-only proportional bar with label + value.
 *
 * Stateless. Renders a one-line strip:
 *   <icon> <label, fixed width>  <value>  <bar>
 * Bar uses `█` for filled segments and `░` for empty, sized by barWidth.
 */

import React from "react";

export interface GaugeProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly icon?: string | undefined;
  readonly color?: string | undefined;
  readonly barWidth?: number | undefined;
  readonly labelWidth?: number | undefined;
}

const DEFAULT_BAR_WIDTH = 40;
const DEFAULT_LABEL_WIDTH = 20;

export const Gauge: React.NamedExoticComponent<GaugeProps> = React.memo(function Gauge({
  label,
  value,
  max,
  icon,
  color,
  barWidth,
  labelWidth,
}: GaugeProps): React.ReactNode {
  const width = barWidth ?? DEFAULT_BAR_WIDTH;
  const labelW = labelWidth ?? DEFAULT_LABEL_WIDTH;
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const labelText = label.padEnd(labelW, " ").slice(0, labelW);
  const valueText = String(value).padStart(4, " ");

  return (
    <box flexDirection="row">
      {icon !== undefined && <text color={color}>{`${icon} `}</text>}
      <text>{labelText}</text>
      <text>{`  ${valueText}  `}</text>
      <text color={color}>{bar}</text>
    </box>
  );
});
