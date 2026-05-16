import React, { useMemo } from "react";
import { AgentCard, CARD_WIDTH } from "./agent-card.js";
import type { SupervisedAgent } from "./types.js";

const COLS = 3;

export interface AgentGridProps {
  readonly agents: readonly SupervisedAgent[];
  readonly cursor: number;            // flat index into agents
  readonly viewportHeight: number;    // rows visible (card-rows)
}

export const AgentGrid: React.NamedExoticComponent<AgentGridProps> = React.memo(
  function AgentGrid({ agents, cursor, viewportHeight }: AgentGridProps) {
    const rows = useMemo(() => chunk(agents, COLS), [agents]);
    const cursorRow = Math.floor(cursor / COLS);
    const startRow = Math.max(0, cursorRow - Math.floor(viewportHeight / 2));
    const visibleRows = rows.slice(startRow, startRow + viewportHeight);

    return (
      <box flexDirection="column" gap={0}>
        {visibleRows.map((row, ri) => {
          const absoluteRow = startRow + ri;
          return (
            <box key={absoluteRow} flexDirection="row" gap={1}>
              {row.map((agent, ci) => {
                const idx = absoluteRow * COLS + ci;
                return (
                  <AgentCard
                    key={agent.agentId}
                    agent={agent}
                    focused={idx === cursor}
                  />
                );
              })}
            </box>
          );
        })}
      </box>
    );
  },
);

function chunk<T>(arr: readonly T[], n: number): readonly T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Pure cursor movement — exported for unit testing. */
export function moveCursor(
  cursor: number,
  total: number,
  action: "left" | "right" | "up" | "down" | "top" | "bottom",
): number {
  if (total === 0) return 0;
  switch (action) {
    case "left":   return Math.max(0, cursor - 1);
    case "right":  return Math.min(total - 1, cursor + 1);
    case "up":     return Math.max(0, cursor - COLS);
    case "down":   return Math.min(total - 1, cursor + COLS);
    case "top":    return 0;
    case "bottom": return total - 1;
  }
}

export { CARD_WIDTH, COLS as GRID_COLS };
