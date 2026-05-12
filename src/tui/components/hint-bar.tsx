/**
 * <HintBar> — context-aware key-action chain rendered at the bottom of
 * the TUI (#309). Presentational only: takes `hints` + `width`, applies
 * width-aware truncation, returns null when nothing fits.
 *
 * Layout: "[Enter]Focus  [Space]Expand  [R]Review  [M]Merge  [L]Logs"
 *
 * Width tiers:
 *   >= 40 cols: greedy include + ellipsis if needed
 *   <  40 cols: render nothing (don't fight the breadcrumb for space)
 */

import React from "react";
import type { KeyAction } from "../data/hint-map.js";
import { theme } from "../theme.js";

const PADDING_X = 2; // 1 char each side of the box
const ELLIPSIS_BUDGET = 2; // " …" suffix when truncated
const SEPARATOR = "  "; // two spaces between actions

export interface HintBarProps {
  readonly hints: readonly KeyAction[];
  readonly width: number;
}

export function truncateForWidth(
  hints: readonly KeyAction[],
  width: number,
): { actions: readonly KeyAction[]; truncated: boolean } {
  if (hints.length === 0) return { actions: [], truncated: false };

  // First pass: see if every action fits within the no-ellipsis budget
  // (width - paddingX). Only when this fails do we re-fit with ellipsis
  // budget reserved — otherwise an exact-fit chain falsely drops its last
  // action to make room for an unneeded "…".
  const fullBudget = width - PADDING_X;
  if (fullBudget > 0) {
    let used = 0;
    let fits = true;
    for (let i = 0; i < hints.length; i++) {
      const a = hints[i];
      if (!a) continue;
      used += `[${a.key}]${a.label}`.length + (i === 0 ? 0 : SEPARATOR.length);
      if (used > fullBudget) {
        fits = false;
        break;
      }
    }
    if (fits) return { actions: hints, truncated: false };
  }

  // Second pass: reserve ellipsis budget and greedily include actions.
  const budget = width - PADDING_X - ELLIPSIS_BUDGET;
  if (budget <= 0) return { actions: [], truncated: true };

  const actions: KeyAction[] = [];
  let used = 0;
  for (let i = 0; i < hints.length; i++) {
    const a = hints[i];
    if (!a) continue;
    const cost = `[${a.key}]${a.label}`.length + (i === 0 ? 0 : SEPARATOR.length);
    if (used + cost > budget) {
      return { actions, truncated: true };
    }
    used += cost;
    actions.push(a);
  }
  return { actions, truncated: false };
}

export const HintBar: React.NamedExoticComponent<HintBarProps> = React.memo(function HintBar({
  hints,
  width,
}: HintBarProps): React.ReactNode {
  if (width < 40 || hints.length === 0) return null;
  const { actions, truncated } = truncateForWidth(hints, width);
  if (actions.length === 0) return null;

  const nodes: React.ReactNode[] = [];
  actions.forEach((a, i) => {
    if (i > 0) {
      nodes.push(
        <text key={`s-${a.key}`} color={theme.secondary}>
          {SEPARATOR}
        </text>,
      );
    }
    nodes.push(
      <text key={`k-${a.key}`} color={theme.focus}>
        {`[${a.key}]`}
      </text>,
      <text key={`l-${a.key}`} color={theme.text}>
        {a.label}
      </text>,
    );
  });
  if (truncated) {
    nodes.push(
      <text key="ellipsis" color={theme.secondary}>
        {" …"}
      </text>,
    );
  }

  return (
    <box flexDirection="row" paddingX={1}>
      {nodes}
    </box>
  );
});
