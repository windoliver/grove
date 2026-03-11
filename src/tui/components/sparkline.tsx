/**
 * Unicode sparkline component for compact data visualization.
 *
 * Renders a sequence of values as Unicode block characters (▁▂▃▄▅▆▇█).
 */

import React from "react";

/** Props for the Sparkline component. */
export interface SparklineProps {
  /** Numeric values to visualize. */
  readonly values: readonly number[];
  /** Color for the sparkline characters. */
  readonly color?: string | undefined;
  /** Max width in characters. Values are downsampled if needed. */
  readonly maxWidth?: number | undefined;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Render a numeric series as a Unicode sparkline. */
export const Sparkline: React.NamedExoticComponent<SparklineProps> = React.memo(function Sparkline({
  values,
  color,
  maxWidth,
}: SparklineProps): React.ReactNode {
  if (values.length === 0) {
    return <text opacity={0.5}>-</text>;
  }

  // Downsample if needed
  const limit = maxWidth ?? values.length;
  const sampled = values.length > limit ? downsample(values, limit) : values;

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min;

  const chars = sampled.map((v) => {
    if (range === 0) return BLOCKS[3]; // flat line → middle block
    const normalized = (v - min) / range;
    const idx = Math.min(Math.floor(normalized * BLOCKS.length), BLOCKS.length - 1);
    return BLOCKS[idx];
  });

  return <text color={color}>{chars.join("")}</text>;
});

/** Simple averaging downsample. */
function downsample(values: readonly number[], targetLen: number): readonly number[] {
  const result: number[] = [];
  const step = values.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += values[j] ?? 0;
    }
    result.push(sum / (end - start));
  }
  return result;
}
