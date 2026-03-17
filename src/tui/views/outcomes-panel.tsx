/**
 * Outcomes panel — outcome annotations with status filtering.
 *
 * Shows outcome records (approved/rejected/pending) for contributions,
 * using the TuiOutcomeProvider extension if available.
 */

import React, { useCallback, useEffect } from "react";
import type { OutcomeRecord } from "../../core/outcome.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider, TuiOutcomeProvider } from "../provider.js";

/** Props for the OutcomesPanel view. */
export interface OutcomesPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

interface OutcomeRow {
  readonly cid: string;
  readonly status: string;
  readonly agent: string;
  readonly reason: string;
  readonly time: string;
}

const COLUMNS = [
  { header: "CID", key: "cid", width: 16 },
  { header: "STATUS", key: "status", width: 12 },
  { header: "AGENT", key: "agent", width: 14 },
  { header: "REASON", key: "reason", width: 28 },
  { header: "TIME", key: "time", width: 10 },
] as const;

/** Check if a provider supports outcomes. */
function hasOutcomes(provider: TuiDataProvider): provider is TuiDataProvider & TuiOutcomeProvider {
  return (
    "listOutcomes" in provider &&
    typeof (provider as unknown as TuiOutcomeProvider).listOutcomes === "function"
  );
}

/** Outcomes panel showing outcome annotations. */
export const OutcomesPanelView: React.NamedExoticComponent<OutcomesPanelProps> = React.memo(
  function OutcomesPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: OutcomesPanelProps): React.ReactNode {
    const supportsOutcomes = hasOutcomes(provider);

    const fetcher = useCallback(async (): Promise<readonly OutcomeRow[]> => {
      if (!supportsOutcomes) return [];

      const all: readonly OutcomeRecord[] = await (
        provider as unknown as TuiOutcomeProvider
      ).listOutcomes();
      const outcomes = all.slice(0, 30);
      return outcomes.map((o) => ({
        cid: truncateCid(o.cid),
        status: o.status,
        agent: o.evaluatedBy ?? "-",
        reason:
          (o.reason ?? "").length > 28 ? `${(o.reason ?? "").slice(0, 26)}..` : (o.reason ?? "-"),
        time: formatTimestamp(o.evaluatedAt),
      }));
    }, [provider, supportsOutcomes]);

    const { data, loading, isStale, error } = usePolledData<readonly OutcomeRow[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (!supportsOutcomes) {
      return (
        <box>
          <text opacity={0.5}>Outcomes not available for this backend</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading outcomes...</text>
        </box>
      );
    }

    const outcomes = data ?? [];

    return (
      <box flexDirection="column">
        <box marginBottom={1} flexDirection="row">
          <text>Outcomes</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {`${outcomes.length} annotations`}
          </text>
        </box>
        {outcomes.length === 0 ? (
          <EmptyState
            title="No outcome annotations yet."
            hint="Outcomes are recorded when contributions are evaluated."
          />
        ) : (
          <Table
            columns={[...COLUMNS]}
            rows={outcomes as unknown as readonly Record<string, string>[]}
            cursor={cursor}
          />
        )}
      </box>
    );
  },
);
