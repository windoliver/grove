/**
 * Claims view — active claims with lease countdown, EntityView-backed.
 *
 * Scoped sessions (provider.hasSessionScope) render an EmptyState
 * directly without mounting EntityView, preserving the pre-port
 * behavior where `getClaims` lacks sessionId filtering.
 */

import React, { useCallback, useMemo, useState } from "react";
import type { ClaimEntity } from "../../core/entity.js";
import {
  agentColumn,
  claimIdColumn,
  heartbeatColumn,
  intentColumn,
  isActive,
  leaseColumn,
  statusColumnWithCounts,
  targetColumn,
} from "../components/columns/claim-columns.js";
import { EmptyState } from "../components/empty-state.js";
import { EntityView } from "../components/entity-view.js";
import { useProviderScoped } from "../hooks/informer-context.js";
import type { TuiDataProvider } from "../provider.js";

export interface ClaimsProps {
  readonly provider: TuiDataProvider;
  readonly intervalMs: number;
  readonly active: boolean;
  readonly cursor: number;
  readonly onRowCountChanged?: (count: number) => void;
  readonly activeClaims?: readonly unknown[] | undefined;
}

export const ClaimsView: React.NamedExoticComponent<ClaimsProps> = React.memo(function ClaimsView(
  props: ClaimsProps,
): React.ReactNode {
  const { provider, active, cursor, onRowCountChanged } = props;
  const isScoped = useProviderScoped(provider);

  const fallbackFetcher = useCallback(async (): Promise<readonly ClaimEntity[]> => {
    // Provider returns flat Claim shapes for the polled fallback path;
    // synthesize minimal ClaimEntity envelopes so the column renders work.
    // `as unknown as ClaimEntity` is required because the synthesized status
    // omits `persistedPhase` (a ClaimStatusBody field not available from the
    // flat Claim shape). Both phase fields are set to the same value here;
    // the fallback path only needs phase for the isActive predicate and column
    // renders, so the omission is safe.
    const claims = await provider.getClaims({ status: "active" });
    return claims.map(
      (c) =>
        ({
          kind: "Claim",
          namespace: "default",
          id: c.claimId,
          spec: {
            targetRef: c.targetRef,
            agent: c.agent,
            intentSummary: c.intentSummary,
            context: c.context,
          },
          status: {
            phase: c.status as "active" | "expired" | "released" | "completed",
            heartbeatAt: c.heartbeatAt,
            leaseExpiresAt: c.leaseExpiresAt,
            attemptCount: c.attemptCount ?? 0,
          },
          conditions: [],
          observedGeneration: 0,
          resourceVersion: "0",
          metadata: { generation: 0, creationTimestamp: c.createdAt },
        }) as unknown as ClaimEntity,
    );
  }, [provider]);

  // Dup-counts must close over the current data to highlight `<phase> DUP`.
  // Track via onDataChanged.
  const [targetCounts, setTargetCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const onDataChanged = useCallback((data: readonly ClaimEntity[]) => {
    const m = new Map<string, number>();
    for (const e of data) m.set(e.spec.targetRef, (m.get(e.spec.targetRef) ?? 0) + 1);
    setTargetCounts(m);
  }, []);

  const columns = useMemo(
    () => [
      claimIdColumn(20),
      targetColumn(24),
      agentColumn(16),
      statusColumnWithCounts(targetCounts, 10),
      leaseColumn(14),
      heartbeatColumn(12),
      intentColumn(28),
    ],
    [targetCounts],
  );

  if (isScoped) {
    return (
      <box flexDirection="column">
        <box marginBottom={1}>
          <text>Active Claims (0)</text>
        </box>
        <EmptyState
          title="Active work claims. Claims prevent agents from duplicating each other's work."
          hint="Spawn agents with Ctrl+P. Each agent automatically claims work before starting."
        />
      </box>
    );
  }

  return (
    <EntityView
      kind="Claim"
      columns={columns}
      provider={provider}
      active={active}
      cursor={cursor}
      predicate={isActive}
      fallbackFetcher={fallbackFetcher}
      title="Active Claims"
      emptyTitle="Active work claims. Claims prevent agents from duplicating each other's work."
      emptyHint="Spawn agents with Ctrl+P. Each agent automatically claims work before starting."
      onDataChanged={onDataChanged}
      {...(onRowCountChanged ? { onRowCountChanged } : {})}
    />
  );
});
