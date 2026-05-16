import React from "react";
import { theme } from "../../theme.js";
import type { DrillTab } from "./types.js";

export interface DrillTabsProps {
  readonly active: DrillTab;
}

const ORDER: readonly DrillTab[] = ["feed", "dag", "term"];
const LABEL: Readonly<Record<DrillTab, string>> = {
  feed: "Feed",
  dag: "DAG",
  term: "Term",
};

export const DrillTabs: React.NamedExoticComponent<DrillTabsProps> = React.memo(
  function DrillTabs({ active }: DrillTabsProps) {
    return (
      <box flexDirection="row" gap={2}>
        {ORDER.map((t) => (
          <text key={t} color={t === active ? theme.info : theme.secondary}>
            {t === active ? `[${LABEL[t]}]` : ` ${LABEL[t]} `}
          </text>
        ))}
        <text color={theme.secondary}>  [Tab cycles · 1/2/3 jumps]</text>
      </box>
    );
  },
);

export function nextDrillTab(current: DrillTab): DrillTab {
  const i = ORDER.indexOf(current);
  return ORDER[(i + 1) % ORDER.length] as DrillTab;
}
