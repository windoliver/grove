/**
 * Renders one frontier slice: signal description header + ranked table
 * with rank, cid (with optional compare prefix), value, signal badge, and
 * truncated summary.
 */

import React, { useMemo } from "react";
import { truncateCid } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { theme } from "../theme.js";
import type { FrontierSlice } from "./frontier-slices.js";

const COLUMNS = [
  { header: "RANK", key: "rank", width: 6, align: "right" as const },
  { header: "CID", key: "cid", width: 22 },
  { header: "VALUE", key: "value", width: 10, align: "right" as const },
  { header: "SIGNAL", key: "signal", width: 18 },
  { header: "SUMMARY", key: "summary", width: 32 },
] as const;

export interface FrontierSliceTableProps {
  readonly slice: FrontierSlice;
  readonly cursor?: number | undefined;
  readonly compareMode?: boolean | undefined;
  readonly compareCids?: readonly string[] | undefined;
}

function formatValueColumn(value: number): string {
  // Epoch-ms timestamps (recency slice) are surfaced via the SIGNAL badge as
  // a relative time. Showing a 13-digit raw epoch in VALUE adds noise; leave
  // VALUE blank for those rows.
  if (Number.isInteger(value) && value > 1_000_000_000_000) return "";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

export const FrontierSliceTable: React.NamedExoticComponent<FrontierSliceTableProps> = React.memo(
  function FrontierSliceTable({
    slice,
    cursor,
    compareMode,
    compareCids,
  }: FrontierSliceTableProps): React.ReactNode {
    const selected = useMemo(() => new Set(compareCids ?? []), [compareCids]);
    const rows = useMemo(
      () =>
        slice.entries.map((entry, i) => {
          const prefix = compareMode ? (selected.has(entry.cid) ? "[*] " : "[ ] ") : "";
          return {
            rank: String(i + 1),
            cid: `${prefix}${truncateCid(entry.cid)}`,
            value: formatValueColumn(entry.value),
            signal: slice.formatBadge(entry),
            summary: entry.summary.length > 32 ? `${entry.summary.slice(0, 30)}..` : entry.summary,
          };
        }),
      [slice, compareMode, selected],
    );

    if (rows.length === 0) {
      return (
        <box flexDirection="column">
          <text color={theme.secondary}>{slice.signalDescription}</text>
          <text opacity={0.5}>{`${slice.label} — no entries yet`}</text>
        </box>
      );
    }

    return (
      <box flexDirection="column">
        <text color={theme.secondary}>{slice.signalDescription}</text>
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      </box>
    );
  },
);
