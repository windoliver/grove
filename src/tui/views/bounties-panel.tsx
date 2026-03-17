/**
 * Bounties panel — bounty records with status and amount display.
 *
 * Shows bounty records from the provider if a BountyStore-compatible
 * interface is available. Falls back to a "not available" message
 * following the same pattern as outcomes-panel.tsx.
 */

import React, { useCallback, useEffect } from "react";
import type { Bounty } from "../../core/bounty.js";
import type { BountyQuery } from "../../core/bounty-store.js";
import { formatTimestamp, truncateCid } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { isBountyProvider, type TuiDataProvider } from "../provider.js";

/** Props for the BountiesPanel view. */
export interface BountiesPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

interface BountyRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly amount: string;
  readonly creator: string;
  readonly deadline: string;
}

const COLUMNS = [
  { header: "ID", key: "id", width: 16 },
  { header: "TITLE", key: "title", width: 24 },
  { header: "STATUS", key: "status", width: 12 },
  { header: "AMOUNT", key: "amount", width: 10 },
  { header: "CREATOR", key: "creator", width: 14 },
  { header: "DEADLINE", key: "deadline", width: 10 },
] as const;

/** Bounties panel showing bounty records. */
export const BountiesPanelView: React.NamedExoticComponent<BountiesPanelProps> = React.memo(
  function BountiesPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: BountiesPanelProps): React.ReactNode {
    const supportsBounties = isBountyProvider(provider);

    const fetcher = useCallback(async (): Promise<readonly BountyRow[]> => {
      if (!isBountyProvider(provider)) return [];

      const query: BountyQuery = { limit: 30 };
      const all: readonly Bounty[] = await provider.listBounties(query);
      return all.map((b) => ({
        id: truncateCid(b.bountyId),
        title: b.title.length > 24 ? `${b.title.slice(0, 22)}..` : b.title,
        status: b.status,
        amount: String(b.amount),
        creator: b.creator.role ?? b.creator.agentName ?? b.creator.agentId,
        deadline: formatTimestamp(b.deadline),
      }));
    }, [provider]);

    const { data, loading, isStale, error } = usePolledData<readonly BountyRow[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (!supportsBounties) {
      return (
        <box>
          <text opacity={0.5}>Bounties not available for this backend</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading bounties...</text>
        </box>
      );
    }

    const bounties = data ?? [];

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Bounties</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {bounties.length} records
          </text>
        </box>
        {bounties.length === 0 ? (
          <EmptyState
            title="No bounties yet."
            hint="Create bounties to incentivize contributions from agents."
          />
        ) : (
          <Table
            columns={[...COLUMNS]}
            rows={bounties as unknown as readonly Record<string, string>[]}
            cursor={cursor}
          />
        )}
      </box>
    );
  },
);
