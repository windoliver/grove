/**
 * Gossip panel — peer status and gossip network overview.
 *
 * Shows gossip peer liveness data if the provider exposes a
 * GossipService-compatible interface. Falls back to a "not available"
 * message following the same pattern as outcomes-panel.tsx.
 */

import React, { useCallback, useEffect } from "react";
import type { PeerInfo } from "../../core/gossip/types.js";
import { formatTimestamp } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import { isGossipProvider, type TuiDataProvider } from "../provider.js";

/** Props for the GossipPanel view. */
export interface GossipPanelProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: ((count: number) => void) | undefined;
}

interface PeerRow {
  readonly peerId: string;
  readonly address: string;
  readonly capacity: string;
  readonly age: string;
  readonly lastSeen: string;
}

const COLUMNS = [
  { header: "PEER", key: "peerId", width: 18 },
  { header: "ADDRESS", key: "address", width: 24 },
  { header: "CAPACITY", key: "capacity", width: 10 },
  { header: "AGE", key: "age", width: 6 },
  { header: "LAST SEEN", key: "lastSeen", width: 12 },
] as const;

/** Gossip panel showing peer network status. */
export const GossipPanelView: React.NamedExoticComponent<GossipPanelProps> = React.memo(
  function GossipPanelView({
    provider,
    intervalMs,
    active,
    cursor,
    onRowCountChanged,
  }: GossipPanelProps): React.ReactNode {
    const supportsGossip = isGossipProvider(provider);

    const fetcher = useCallback(async (): Promise<readonly PeerRow[]> => {
      if (!isGossipProvider(provider)) return [];

      const peers: readonly PeerInfo[] = await provider.getGossipPeers();
      return peers.map((p) => ({
        peerId: p.peerId.length > 18 ? `${p.peerId.slice(0, 16)}..` : p.peerId,
        address: p.address.length > 24 ? `${p.address.slice(0, 22)}..` : p.address,
        capacity:
          (p as unknown as { freeSlots?: number; totalSlots?: number }).totalSlots !== undefined
            ? `${String((p as unknown as { freeSlots: number }).freeSlots)}/${String((p as unknown as { totalSlots: number }).totalSlots)}`
            : "-",
        age: String(p.age),
        lastSeen: formatTimestamp(p.lastSeen),
      }));
    }, [provider]);

    const { data, loading, isStale, error } = usePolledData<readonly PeerRow[]>(
      fetcher,
      intervalMs,
      active,
    );

    useEffect(() => {
      if (data && onRowCountChanged) {
        onRowCountChanged(data.length);
      }
    }, [data, onRowCountChanged]);

    if (!supportsGossip) {
      return (
        <box>
          <text opacity={0.5}>Gossip not available for this backend</text>
        </box>
      );
    }

    if (loading && !data) {
      return (
        <box>
          <text opacity={0.5}>Loading gossip peers...</text>
        </box>
      );
    }

    const peers = data ?? [];

    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Gossip</text>
          <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
          <text opacity={0.5}>
            {"  "}
            {peers.length} peers
          </text>
        </box>
        {peers.length === 0 ? (
          <EmptyState
            title="No gossip peers discovered."
            hint="Peers appear when other grove instances connect via gossip."
          />
        ) : (
          <Table
            columns={[...COLUMNS]}
            rows={peers as unknown as readonly Record<string, string>[]}
            cursor={cursor}
          />
        )}
      </box>
    );
  },
);
