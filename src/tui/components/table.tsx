/**
 * Reusable TUI table component with cursor highlighting.
 *
 * Renders a simple text-based table inside an Ink Box.
 * The selected row is highlighted with a ">" indicator.
 */

import { Box, Text } from "ink";
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
}: TableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <Box>
        <Text dimColor>(no data)</Text>
      </Box>
    );
  }

  const displayRows = maxRows !== undefined ? rows.slice(0, maxRows) : rows;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold dimColor>
          {"  "}
          {columns
            .map((col) => padCell(col.header, col.width ?? col.header.length + 4, col.align))
            .join("  ")}
        </Text>
      </Box>
      {/* Rows */}
      {displayRows.map((row, i) => {
        const isSelected = cursor !== undefined && cursor === i;
        return (
          <Box key={row.cid ?? row.id ?? String(i)}>
            {isSelected ? (
              <Text color="cyan" bold>
                {">"}{" "}
                {columns
                  .map((col) =>
                    padCell(row[col.key] ?? "", col.width ?? col.header.length + 4, col.align),
                  )
                  .join("  ")}
              </Text>
            ) : (
              <Text>
                {"  "}
                {columns
                  .map((col) =>
                    padCell(row[col.key] ?? "", col.width ?? col.header.length + 4, col.align),
                  )
                  .join("  ")}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
});

function padCell(value: string, width: number, align?: "left" | "right" | undefined): string {
  const truncated = value.length > width ? `${value.slice(0, width - 2)}..` : value;
  return align === "right" ? truncated.padStart(width) : truncated.padEnd(width);
}
