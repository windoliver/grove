/**
 * Reusable TUI table component with cursor highlighting.
 *
 * Renders a simple text-based table using OpenTUI intrinsics.
 * The selected row is highlighted with a ">" indicator.
 */

import React from "react";

/** Column definition for the TUI table. */
export interface TableColumn {
  readonly header: string;
  readonly key: string;
  readonly width?: number | undefined;
  readonly align?: "left" | "right" | undefined;
}

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
  if (rows.length === 0) {
    return (
      <box>
        <text opacity={0.5}>(no data)</text>
      </box>
    );
  }

  const displayRows = maxRows !== undefined ? rows.slice(0, maxRows) : rows;

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
      {/* Rows */}
      {displayRows.map((row, i) => {
        const isSelected = cursor !== undefined && cursor === i;
        return (
          <box key={row.cid ?? row.id ?? String(i)}>
            <text color={isSelected ? "#00cccc" : undefined}>
              {isSelected ? "> " : "  "}
              {columns
                .map((col) =>
                  padCell(row[col.key] ?? "", col.width ?? col.header.length + 4, col.align),
                )
                .join("  ")}
            </text>
          </box>
        );
      })}
    </box>
  );
});

function padCell(value: string, width: number, align?: "left" | "right" | undefined): string {
  const truncated = value.length > width ? `${value.slice(0, width - 2)}..` : value;
  return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}
