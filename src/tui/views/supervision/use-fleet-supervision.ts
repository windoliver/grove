/**
 * Hook that fans out provider reads and joins them through classifyAgent
 * into a stable SupervisedAgent[]. Pure-builder export (`buildSupervisedFleet`)
 * is unit-tested without React.
 */

import { useMemo } from "react";
import type { Claim, Contribution } from "../../../core/models.js";
import { ClaimStatus } from "../../../core/models.js";
import { classifyAgent, type HandoffServerState, summarize } from "./derive-state.js";
import type { FleetSummary, PendingApproval, SupervisedAgent } from "./types.js";
import type { SupervisionThresholds } from "./thresholds.js";

export interface BuildFleetInput {
  readonly claims: readonly Claim[];
  readonly contributions: readonly Contribution[];
  readonly contribsByAgent: ReadonlyMap<string, readonly Contribution[]>;
  readonly costs: ReadonlyMap<string, { costUsd: number; tokens: number; contextPercent?: number }>;
  readonly sessions: ReadonlyMap<string, string>;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly handoffsByAgent: ReadonlyMap<
    string,
    { targetUnhealthy: boolean; serverState: HandoffServerState | undefined }
  >;
  readonly completedClaimsByAgent: ReadonlyMap<string, number>;
  readonly now: number;
  readonly thresholds: SupervisionThresholds;
}

/** Pure builder — unit-testable without React. */
export function buildSupervisedFleet(input: BuildFleetInput): readonly SupervisedAgent[] {
  // Pick one claim per agent: prefer Active over non-Active; among same-status, prefer newest createdAt.
  const byAgent = new Map<string, Claim>();
  for (const c of input.claims) {
    const prev = byAgent.get(c.agent.agentId);
    if (!prev) {
      byAgent.set(c.agent.agentId, c);
      continue;
    }
    const prevActive = prev.status === ClaimStatus.Active;
    const curActive = c.status === ClaimStatus.Active;
    if (curActive && !prevActive) {
      byAgent.set(c.agent.agentId, c);
      continue;
    }
    if (curActive === prevActive) {
      if (Date.parse(c.createdAt) > Date.parse(prev.createdAt)) byAgent.set(c.agent.agentId, c);
    }
  }

  // Pick oldest pending approval per agent (FIFO is at the queue level; for classifier purposes any single one suffices, but oldest is operator-meaningful).
  const approvalsByAgent = new Map<string, PendingApproval>();
  for (const a of input.pendingApprovals) {
    const existing = approvalsByAgent.get(a.agentId);
    if (!existing || a.requestedAt < existing.requestedAt) {
      approvalsByAgent.set(a.agentId, a);
    }
  }

  const out: SupervisedAgent[] = [];
  for (const [agentId, claim] of byAgent) {
    const contribs = input.contribsByAgent.get(agentId) ?? [];
    const cost = input.costs.get(agentId);
    const handoff = input.handoffsByAgent.get(agentId);
    const result = classifyAgent({
      claim,
      contributions: contribs,
      handoffTargetUnhealthy: handoff?.targetUnhealthy ?? false,
      handoffServerState: handoff?.serverState,
      pendingApproval: approvalsByAgent.get(agentId),
      completedAt: input.completedClaimsByAgent.get(agentId),
      now: input.now,
      thresholds: input.thresholds,
      costUsdLastMin: cost?.costUsd,
      contextPercent: cost?.contextPercent,
    });
    const supervised: SupervisedAgent = {
      agentId,
      ...(claim.agent.agentName !== undefined ? { agentName: claim.agent.agentName } : {}),
      role: claim.agent.role ?? "agent",
      platform: claim.agent.platform ?? "unknown",
      state: result.state,
      stateReason: result.stateReason,
      lastActionAt: result.lastActionAt,
      ...(claim.targetRef !== undefined ? { currentTask: claim.targetRef } : {}),
      costUsd: cost?.costUsd ?? 0,
      tokens: cost?.tokens ?? 0,
      ...(cost?.contextPercent !== undefined ? { contextPercent: cost.contextPercent } : {}),
      ...(input.sessions.get(agentId) !== undefined ? { sessionName: input.sessions.get(agentId) } : {}),
      ...(approvalsByAgent.get(agentId) !== undefined ? { pendingApproval: approvalsByAgent.get(agentId) } : {}),
      contribCount: contribs.length,
      costSpike: result.costSpike,
      contextHot: result.contextHot,
    };
    out.push(supervised);
  }
  return out;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface FleetState {
  readonly agents: readonly SupervisedAgent[];
  readonly summary: FleetSummary;
}

export interface UseFleetSupervisionInputs {
  readonly claims: readonly Claim[];
  readonly contributions: readonly Contribution[];
  readonly costs: ReadonlyMap<string, { costUsd: number; tokens: number; contextPercent?: number }>;
  readonly sessions: ReadonlyMap<string, string>;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly handoffsByAgent: ReadonlyMap<
    string,
    { targetUnhealthy: boolean; serverState: HandoffServerState | undefined }
  >;
  readonly completedClaimsByAgent: ReadonlyMap<string, number>;
  /** Source of the "now" timestamp — typically Date.now() refreshed each tick by the consumer. */
  readonly tickMs: number;
  readonly thresholds: SupervisionThresholds;
}

export function useFleetSupervision(inputs: UseFleetSupervisionInputs): FleetState {
  return useMemo(() => {
    const contribsByAgent = groupContribsByAgent(inputs.contributions);
    const agents = buildSupervisedFleet({
      claims: inputs.claims,
      contributions: inputs.contributions,
      contribsByAgent,
      costs: inputs.costs,
      sessions: inputs.sessions,
      pendingApprovals: inputs.pendingApprovals,
      handoffsByAgent: inputs.handoffsByAgent,
      completedClaimsByAgent: inputs.completedClaimsByAgent,
      now: inputs.tickMs,
      thresholds: inputs.thresholds,
    });
    return { agents, summary: summarize(agents) };
  }, [
    inputs.claims,
    inputs.contributions,
    inputs.costs,
    inputs.sessions,
    inputs.pendingApprovals,
    inputs.handoffsByAgent,
    inputs.completedClaimsByAgent,
    inputs.tickMs,
    inputs.thresholds,
  ]);
}

function groupContribsByAgent(
  contribs: readonly Contribution[],
): ReadonlyMap<string, readonly Contribution[]> {
  const out = new Map<string, Contribution[]>();
  for (const c of contribs) {
    const id = c.agent.agentId;
    const list = out.get(id);
    if (list) list.push(c);
    else out.set(id, [c]);
  }
  return out;
}
