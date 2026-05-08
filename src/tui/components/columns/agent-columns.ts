/**
 * Agent columns for the agent-list view. Several columns depend on
 * a join context (tmux session names, cost rollups) — those are
 * factory functions that close over the context.
 */

import type { ClaimEntity } from "../../../core/entity.js";
import type { Claim } from "../../../core/models.js";
import { agentStatusIcon } from "../../theme.js";
import type { EntityColumn } from "../entity-view.js";

export interface AgentJoinCtx {
  readonly tmuxSessions: readonly string[];
  readonly agentSessions: ReadonlyMap<string, string>; // agentId → session
  readonly costs: ReadonlyMap<string, { costUsd: number; tokens: number; contextPercent?: number }>;
  readonly spinnerFrame: number;
}

const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}K`
      : String(n);

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 2)}..` : s);

const claimToFlat = (e: ClaimEntity): Claim => ({
  claimId: e.id,
  targetRef: e.spec.targetRef,
  agent: e.spec.agent,
  status: e.status.phase,
  intentSummary: e.spec.intentSummary,
  createdAt: e.metadata.creationTimestamp ?? e.status.heartbeatAt,
  heartbeatAt: e.status.heartbeatAt,
  leaseExpiresAt: e.status.leaseExpiresAt,
  context: e.spec.context,
  attemptCount: e.status.attemptCount,
});

const deriveAgentStatus = (
  claim: Claim,
  session: string | undefined,
  tmuxSessions: readonly string[],
): string => {
  const remaining = new Date(claim.leaseExpiresAt).getTime() - Date.now();
  if (remaining <= 0) return "expired";
  if (!session) return "claimed";
  if (!tmuxSessions.includes(session)) return "error";
  if (Date.now() - new Date(claim.heartbeatAt).getTime() > 60_000) return "stalled";
  return "running";
};

export const agentIdColumn = (width = 16): EntityColumn<ClaimEntity> => ({
  header: "AGENT",
  key: "agentId",
  width,
  render: (e) => e.spec.agent.agentName ?? e.spec.agent.agentId,
});

export const roleColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "ROLE",
  key: "role",
  width,
  render: (e) => e.spec.agent.role ?? "worker",
});

export const platformColumn = (width = 12): EntityColumn<ClaimEntity> => ({
  header: "PLATFORM",
  key: "platform",
  width,
  render: (e) => e.spec.agent.platform ?? "-",
});

export const targetColumn = (width = 18): EntityColumn<ClaimEntity> => ({
  header: "TARGET",
  key: "target",
  width,
  render: (e) => trunc(e.spec.targetRef, width),
});

export const statusColumn = (ctx: AgentJoinCtx, width = 12): EntityColumn<ClaimEntity> => ({
  header: "STATUS",
  key: "status",
  width,
  render: (e) => {
    const claim = claimToFlat(e);
    const session = ctx.agentSessions.get(claim.agent.agentId);
    const status = deriveAgentStatus(claim, session, ctx.tmuxSessions);
    const { icon } = agentStatusIcon(status, ctx.spinnerFrame);
    return `${icon} ${status}`;
  },
});

export const costColumn = (ctx: AgentJoinCtx, width = 14): EntityColumn<ClaimEntity> => ({
  header: "COST",
  key: "cost",
  width,
  render: (e) => {
    const c = ctx.costs.get(e.spec.agent.agentId);
    return c ? `$${c.costUsd.toFixed(2)} | ${formatTokens(c.tokens)}` : "-";
  },
});

export const sessionColumn = (ctx: AgentJoinCtx, width = 16): EntityColumn<ClaimEntity> => ({
  header: "SESSION",
  key: "session",
  width,
  render: (e) => ctx.agentSessions.get(e.spec.agent.agentId) ?? "-",
});

/** Sort: coordinators first, then alphabetical by name. */
export const byRoleAndName = (a: ClaimEntity, b: ClaimEntity): number => {
  const ra = a.spec.agent.role ?? "worker";
  const rb = b.spec.agent.role ?? "worker";
  if (ra !== rb) {
    if (ra === "coordinator") return -1;
    if (rb === "coordinator") return 1;
    return ra.localeCompare(rb);
  }
  const na = a.spec.agent.agentName ?? a.spec.agent.agentId;
  const nb = b.spec.agent.agentName ?? b.spec.agent.agentId;
  return na.localeCompare(nb);
};
