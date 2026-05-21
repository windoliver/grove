/**
 * Frontier tab strip. Renders one tab per slice + Overview, with an overflow
 * window so the active tab is always visible and a `+N` indicator marks
 * hidden tabs.
 *
 * Theme token substitutions (theme has no `primary` or `muted`):
 *   active tab color  → theme.focus    (closest semantic match for "primary")
 *   disabled color    → theme.disabled (exact match; used instead of `muted`)
 *   inactive color    → theme.secondary
 */

import React from "react";
import { theme } from "../theme.js";

/** Compute the visible tab window so the active tab is always rendered. */
export function computeVisibleTabs(
  tabs: readonly string[],
  active: string,
  capacity: number,
): { visible: readonly string[]; hiddenAfter: number } {
  if (tabs.length === 0) return { visible: [], hiddenAfter: 0 };
  if (capacity >= tabs.length) return { visible: tabs, hiddenAfter: 0 };
  const activeIdx = tabs.indexOf(active);
  const start = activeIdx < 0 ? 0 : Math.min(activeIdx, Math.max(0, tabs.length - capacity));
  const visible = tabs.slice(start, start + capacity);
  return { visible, hiddenAfter: tabs.length - visible.length };
}

export interface FrontierTabBarProps {
  readonly tabs: readonly { key: string; label: string }[];
  readonly activeKey: string;
  readonly capacity?: number;
  readonly disabled?: boolean;
}

const DEFAULT_CAPACITY = 8;

export const FrontierTabBar: React.NamedExoticComponent<FrontierTabBarProps> = React.memo(
  function FrontierTabBar({
    tabs,
    activeKey,
    capacity = DEFAULT_CAPACITY,
    disabled = false,
  }: FrontierTabBarProps): React.ReactNode {
    const keys = tabs.map((t) => t.key);
    const { visible, hiddenAfter } = computeVisibleTabs(keys, activeKey, capacity);
    const labelByKey = new Map(tabs.map((t) => [t.key, t.label]));
    return (
      <box flexDirection="row">
        {visible.map((key) => {
          const isActive = key === activeKey;
          const color = disabled ? theme.disabled : isActive ? theme.focus : theme.secondary;
          const decoration = isActive
            ? `[${labelByKey.get(key) ?? key}]`
            : (labelByKey.get(key) ?? key);
          return (
            <text key={key} color={color}>
              {`${decoration}  `}
            </text>
          );
        })}
        {hiddenAfter > 0 ? <text opacity={0.5}>{`+${String(hiddenAfter)}`}</text> : null}
      </box>
    );
  },
);
