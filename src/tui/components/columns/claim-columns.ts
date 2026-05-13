/**
 * Reusable Claim columns for EntityView (claims.tsx, agent-list.tsx).
 */

import type { ClaimEntity } from "../../../core/entity.js";
import { formatDuration } from "../../../shared/duration.js";
import { formatTimestamp } from "../../../shared/format.js";
import type { EntityColumn } from "../entity-view.js";

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 2)}..` : s);

export const claimIdColumn = (width = 20): EntityColumn<ClaimEntity> => ({
  header: "CLAIM_ID",
  key: "claimId",
  width,
  render: (e) => trunc(e.id, width),
});

export const targetColumn = (width = 24): EntityColumn<ClaimEntity> => ({
  header: "TARGET",
  key: "target",
  width,
  render: (e) => trunc(e.spec.targetRef, width),
});

export const agentColumn = (width = 16): EntityColumn<ClaimEntity> => ({
  header: "AGENT",
  key: "agent",
  width,
  render: (e) => e.spec.agent.agentName ?? e.spec.agent.agentId,
});

export const intentColumn = (width = 28): EntityColumn<ClaimEntity> => ({
  header: "INTENT",
  key: "intent",
  width,
  render: (e) => trunc(e.spec.intentSummary ?? "", width),
});

export const heartbeatColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "HEARTBEAT",
  key: "heartbeat",
  width,
  render: (e) => formatTimestamp(e.status.heartbeatAt),
});

/**
 * STATUS column with duplicate-target highlight. Closes over a
 * `targetCounts` map so the wrapper can pre-compute counts and pass
 * them in. Returns the same EntityColumn shape; the render function
 * is recreated when counts change (cheap).
 */
export const statusColumnWithCounts = (
  targetCounts: ReadonlyMap<string, number>,
  width = 10,
): EntityColumn<ClaimEntity> => ({
  header: "STATUS",
  key: "status",
  width,
  render: (e) => {
    const remaining = new Date(e.status.leaseExpiresAt).getTime() - Date.now();
    const dup = (targetCounts.get(e.spec.targetRef) ?? 0) > 1;
    const phase = e.status.phase;
    if (phase === "active" && remaining <= 0) return "EXPIRED";
    return dup ? `${phase} DUP` : phase;
  },
});

export const leaseColumn = (width = 14): EntityColumn<ClaimEntity> => ({
  header: "LEASE",
  key: "lease",
  width,
  render: (e) => {
    const remaining = new Date(e.status.leaseExpiresAt).getTime() - Date.now();
    return remaining > 0 ? formatDuration(remaining) : "expired";
  },
});

/** Predicate: only entities in `active` phase. */
export const isActive = (e: ClaimEntity): boolean => e.status.phase === "active";
