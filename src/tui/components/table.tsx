/**
 * Reusable TUI table component with cursor highlighting.
 *
 * Renders a simple text-based table using OpenTUI intrinsics.
 * The selected row is highlighted with a ">" indicator.
 */

import React, { createElement, useMemo } from "react";
import { theme } from "../theme.js";

/** Column definition for the TUI table. */
export interface TableColumn {
  readonly header: string;
  readonly key: string;
  readonly width?: number | undefined;
  readonly align?: "left" | "right" | undefined;
}

/** Maximum items rendered to guard against scroll-box not virtualizing. */
const MAX_RENDER_ITEMS = 200;

/** Props for the Table component. */
export interface TableProps {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Record<string, string>[];
  /** Index of the currently selected row (-1 or undefined for no selection). */
  readonly cursor?: number | undefined;
  /** Maximum rows to display (for viewport clipping). */
  readonly maxRows?: number | undefined;
}

/** A simple table with optional row highlighting. */
export const Table: React.NamedExoticComponent<TableProps> = React.memo(function Table({
  columns,
  rows,
  cursor,
  maxRows,
}: TableProps): React.ReactNode {
  // Virtual scrolling: cursor-centered windowing (item 18)
  // useMemo MUST be called before any early return (Rules of Hooks).
  const maxItems = maxRows ?? MAX_RENDER_ITEMS;
  const { displayRows, startIndex, truncated } = useMemo(() => {
    if (rows.length === 0)
      return { displayRows: [] as Record<string, string>[], startIndex: 0, truncated: false };

    const total = rows.length;
    const windowSize = Math.min(maxItems, total);
    const isTruncated = total > windowSize;

    if (cursor === undefined || cursor < 0 || !isTruncated) {
      return { displayRows: rows.slice(0, windowSize), startIndex: 0, truncated: isTruncated };
    }

    // Center cursor in the window
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, cursor - half);
    if (start + windowSize > total) {
      start = Math.max(0, total - windowSize);
    }
    return {
      displayRows: rows.slice(start, start + windowSize),
      startIndex: start,
      truncated: isTruncated,
    };
  }, [rows, cursor, maxItems]);

  if (rows.length === 0) {
    return (
      <box>
        <text opacity={0.5}>(no data)</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {/* Header */}
      <box>
        <text opacity={0.5}>
          {"  "}
          {columns
            .map((col) => padCell(col.header, col.width ?? col.header.length + 4, col.align))
            .join("  ")}
        </text>
      </box>
      {/* Rows — wrapped in scroll-box for native scrolling */}
      {createElement(
        "scroll-box" as string,
        { flexGrow: 1 },
        ...displayRows.map((row, i) => {
          const isSelected = cursor !== undefined && cursor === startIndex + i;
          return (
            <box key={row.cid ?? row.id ?? String(i)}>
              <text color={isSelected ? theme.focus : undefined}>
                {isSelected ? "> " : "  "}
                {columns
                  .map((col) =>
                    padCell(row[col.key] ?? "", col.width ?? col.header.length + 4, col.align),
                  )
                  .join("  ")}
              </text>
            </box>
          );
        }),
      )}
      {truncated && (
        <box>
          <text color={theme.dimmed}>
            Showing {maxItems} of {rows.length} — use search to narrow
          </text>
        </box>
      )}
    </box>
  );
});

function padCell(value: string, width: number, align?: "left" | "right" | undefined): string {
  const truncated = value.length > width ? `${value.slice(0, width - 2)}..` : value;
  return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}
