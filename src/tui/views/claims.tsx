/**
 * Claims view — shows all active claims with lease countdown.
 *
 * PR2 (#388) migrated from `usePolledData(provider.getClaims)` to the
 * informer-backed `useEntities("Claim", …)` hook. Reads draw from the
 * shared informer cache (SSE-driven in remote mode, in-process WatchHub
 * in local mode) instead of polling. The pre-fetched `propClaims` prop
 * stays as an explicit override for the parent's claim poller during
 * the dual-path window — once PR3 / PR4 fold those callers in, the
 * override goes away.
 */

import React, { useCallback, useEffect, useMemo } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import type { Claim } from "../../core/models.js";
import { formatDuration } from "../../shared/duration.js";
import { formatTimestamp } from "../../shared/format.js";
import { DataStatus } from "../components/data-status.js";
import { EmptyState } from "../components/empty-state.js";
import { Table } from "../components/table.js";
import { useEntityWatchEnabled, useProviderScoped } from "../hooks/informer-context.js";
import { useEntities } from "../hooks/use-entities.js";
import { usePolledData } from "../hooks/use-polled-data.js";
import type { TuiDataProvider } from "../provider.js";

/** Props for the Claims view. */
export interface ClaimsProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  /** Pre-fetched active claims from parent poller (avoids double polling). */
  readonly activeClaims?: readonly Claim[] | undefined;
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

/** Reduce a ClaimEntity to the flat row shape this view already emits. */
function entityToRow(entity: ClaimEntity): {
  claimId: string;
  targetRef: string;
  agent: { agentName?: string | undefined; agentId: string };
  status: string;
  intentSummary: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
} {
  return {
    claimId: entity.id,
    targetRef: entity.spec.targetRef,
    agent: entity.spec.agent,
    status: entity.status.phase,
    intentSummary: entity.spec.intentSummary,
    heartbeatAt: entity.status.heartbeatAt,
    leaseExpiresAt: entity.status.leaseExpiresAt,
  };
}

const ACTIVE_PREDICATE = (e: ClaimEntity): boolean => e.status.phase === "active";

/** Claims view component. */
export const ClaimsView: React.NamedExoticComponent<ClaimsProps> = React.memo(function ClaimsView({
  provider,
  intervalMs,
  active,
  cursor,
  onRowCountChanged,
  activeClaims: propClaims,
}: ClaimsProps): React.ReactNode {
  const useInformerPath = useEntityWatchEnabled(provider, "Claim");
  // Suppress claim polling under a scoped session: `provider.getClaims`
  // does not filter by sessionId yet, so polling would surface claims
  // from other sessions in the namespace (Codex round 2, finding 2).
  // Mirrors the dashboard's existing behavior (RemoteDataProvider's
  // getDashboard returns `[]` for activeClaims when scoped).
  const isScoped = useProviderScoped(provider);

  // Informer path: useEntities feeds when the factory is mounted and the
  // kind is supported. We always invoke both hooks so React's hook order
  // stays stable across renders; the unused branch's data is discarded.
  const entityResult = useEntities("Claim", ACTIVE_PREDICATE);

  // Polled fallback: only fetches when the parent didn't pre-fetch AND
  // the informer path isn't available AND we're not in a scoped session
  // whose claim API isn't filterable by sessionId.
  const fetcher = useCallback(() => provider.getClaims({ status: "active" }), [provider]);
  const polledResult = usePolledData<readonly Claim[]>(
    fetcher,
    intervalMs,
    active && propClaims === undefined && !useInformerPath && !isScoped,
  );

  const data: readonly Claim[] | undefined = useMemo<readonly Claim[] | undefined>(() => {
    // Scoped sessions render an empty list rather than risk leaking
    // claims from other sessions while the watch + claim APIs lack
    // sessionId filtering. The scope check runs BEFORE the propClaims
    // shortcut because the parent App still polls `getClaims` (used by
    // the command palette and spawn dedup); accepting that unscoped
    // result here would re-expose the leak (Codex round 4, finding 1).
    if (isScoped) return [];
    if (propClaims !== undefined) return propClaims;
    if (useInformerPath) {
      // Project entity → row → caller-shaped Claim. The fields the view
      // reads below are the ones populated from the entity envelope.
      return entityResult.data.map((e) => {
        const r = entityToRow(e);
        return {
          claimId: r.claimId,
          targetRef: r.targetRef,
          agent: r.agent,
          status: r.status,
          intentSummary: r.intentSummary,
          createdAt: r.heartbeatAt,
          heartbeatAt: r.heartbeatAt,
          leaseExpiresAt: r.leaseExpiresAt,
        } as Claim;
      });
    }
    return polledResult.data ?? undefined;
  }, [propClaims, useInformerPath, isScoped, entityResult.data, polledResult.data]);

  const loading = useInformerPath
    ? !entityResult.hasSynced && data === undefined
    : polledResult.loading;
  const isStale = useInformerPath ? false : polledResult.isStale;
  const error = useInformerPath ? entityResult.error : polledResult.error;

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
      intent:
        (c.intentSummary ?? "").length > 28
          ? `${(c.intentSummary ?? "").slice(0, 26)}..`
          : (c.intentSummary ?? ""),
    };
  });

  return (
    <box flexDirection="column">
      <box marginBottom={1} flexDirection="row">
        <text>{`Active Claims (${claims.length})`}</text>
        <DataStatus loading={loading && !data} isStale={isStale} error={error?.message} />
      </box>
      {rows.length === 0 ? (
        <EmptyState
          title="Active work claims. Claims prevent agents from duplicating each other's work."
          hint="Spawn agents with Ctrl+P. Each agent automatically claims work before starting."
        />
      ) : (
        <Table columns={[...COLUMNS]} rows={rows} cursor={cursor} />
      )}
    </box>
  );
});
