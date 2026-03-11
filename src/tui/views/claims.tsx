/**
 * Claims view — shows all active claims with lease countdown.
 */

import React, { useCallback, useEffect } from "react";
import type { Claim } from "../../core/models.js";
import { formatDuration } from "../../shared/duration.js";
import { formatTimestamp } from "../../shared/format.js";
import { Table } from "../components/table.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the Claims view. */
export interface ClaimsProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
}

const COLUMNS = [
  { header: "CLAIM_ID", key: "claimId", width: 20 },
  { header: "TARGET", key: "target", width: 24 },
  { header: "AGENT", key: "agent", width: 16 },
  { header: "STATUS", key: "status", width: 10 },
  { header: "LEASE", key: "lease", width: 14 },
  { header: "HEARTBEAT", key: "heartbeat", width: 12 },
  { header: "INTENT", key: "intent", width: 28 },
] as const;

/** Claims view component. */
export const ClaimsView: React.NamedExoticComponent<ClaimsProps> = React.memo(function ClaimsView({
  provider,
  intervalMs,
  active,
  cursor,
  onRowCountChanged,
}: ClaimsProps): React.ReactNode {
  const fetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
  const { data, loading } = usePolledData<readonly Claim[]>(fetcher, intervalMs, active);

  useEffect(() => {
    if (data && onRowCountChanged) {
      onRowCountChanged(data.length);
    }
  }, [data, onRowCountChanged]);

  if (loading && !data) {
    return (
      <box>
        <text opacity={0.5}>Loading claims...</text>
      </box>
    );
  }

  const claims = data ?? [];

  const targetCounts = new Map<string, number>();
  for (const c of claims) {
    targetCounts.set(c.targetRef, (targetCounts.get(c.targetRef) ?? 0) + 1);
  }

  const rows = claims.map((c) => {
    const remaining = new Date(c.leaseExpiresAt).getTime() - Date.now();
    const isDuplicate = (targetCounts.get(c.targetRef) ?? 0) > 1;
    const statusStr =
      c.status === "active" && remaining <= 0
        ? "EXPIRED"
        : isDuplicate
          ? `${c.status} DUP`
          : c.status;

    return {
      claimId: c.claimId.length > 20 ? `${c.claimId.slice(0, 18)}..` : c.claimId,
      target: c.targetRef.length > 24 ? `${c.targetRef.slice(0, 22)}..` : c.targetRef,
      agent: c.agent.agentName ?? c.agent.agentId,
      status: statusStr,
      lease: remaining > 0 ? formatDuration(remaining) : "expired",
      heartbeat: formatTimestamp(c.heartbeatAt),
      intent: c.intentSummary.length > 28 ? `${c.intentSummary.slice(0, 26)}..` : c.intentSummary,
    };
  });

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text>Active Claims ({claims.length})</text>
      </box>
      <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
    </box>
  );
});
