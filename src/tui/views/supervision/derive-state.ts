/**
 * Pure classifier for the Supervision screen. See:
 *   docs/superpowers/specs/2026-05-15-tui-supervision-hero-design.md
 *
 * Priority (first match wins):
 *   1 awaiting  — pendingApproval set
 *   2 blocked   — expired lease OR handoff target unhealthy OR server flags it
 *   3 thrashing — >= thrashContribs to same target within thrashWindowMs
 *   4 stuck     — claim (= current task; claims are 1:1 with targetRef in Grove) older than stuckMs and contribution-kind diversity <= 1
 *   5 silent    — no contribution > silentMs and lease valid
 *   6 running   — active claim and lastContribAt within silentMs
 *   7 done      — claim complete and now - completedAt < completedRetentionMs
 *   8 idle      — fallthrough
 */

import { type Claim, ClaimStatus, type Contribution } from "../../../core/models.js";
import type { PendingApproval, SupervisedAgent } from "./types.js";
import type { SupervisionThresholds } from "./thresholds.js";

export type HandoffServerState = "overdue" | "blocked" | "dead_lettered" | "pending";

export interface ClassifyInput {
  readonly claim: Claim | undefined;
  readonly contributions: readonly Contribution[];
  readonly handoffTargetUnhealthy: boolean;
  readonly handoffServerState: HandoffServerState | undefined;
  readonly pendingApproval: PendingApproval | undefined;
  readonly completedAt: number | undefined;
  readonly now: number;
  readonly thresholds: SupervisionThresholds;
  readonly costUsdLastMin?: number;
  readonly contextPercent?: number;
}

export interface ClassifyResult {
  readonly state: SupervisedAgent["state"];
  readonly stateReason: string;
  readonly lastActionAt: number;
  readonly costSpike: boolean;
  readonly contextHot: boolean;
}

export function classifyAgent(input: ClassifyInput): ClassifyResult {
  const { claim, contributions, pendingApproval, now, thresholds } = input;

  const lastContribAt = contributions.reduce<number>((max, c) => {
    const t = Date.parse(c.createdAt);
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, 0);
  const claimStartedAt = claim ? Date.parse(claim.createdAt) : 0;
  const baselineLastActionAt = lastContribAt || claimStartedAt || now;

  const costSpike = (input.costUsdLastMin ?? 0) > thresholds.costSpikeUsdPerMin;
  const contextHot = (input.contextPercent ?? 0) >= thresholds.contextPctCritical;

  // 1 awaiting
  if (pendingApproval) {
    return {
      state: "awaiting",
      stateReason: `pending ${pendingApproval.kind}`,
      lastActionAt: pendingApproval.requestedAt,
      costSpike,
      contextHot,
    };
  }

  // 2 blocked — expired lease
  if (claim && claim.status === ClaimStatus.Active) {
    const leaseExp = Date.parse(claim.leaseExpiresAt);
    if (!Number.isNaN(leaseExp) && leaseExp < now) {
      return {
        state: "blocked",
        stateReason: `lease expired ${formatAge(now - leaseExp)} ago`,
        lastActionAt: baselineLastActionAt,
        costSpike,
        contextHot,
      };
    }
  }
  // 2 blocked — handoff signals
  if (input.handoffTargetUnhealthy) {
    return {
      state: "blocked",
      stateReason: "handoff target unhealthy",
      lastActionAt: baselineLastActionAt,
      costSpike,
      contextHot,
    };
  }
  if (
    input.handoffServerState === "overdue" ||
    input.handoffServerState === "blocked" ||
    input.handoffServerState === "dead_lettered"
  ) {
    return {
      state: "blocked",
      stateReason: `handoff ${input.handoffServerState}`,
      lastActionAt: baselineLastActionAt,
      costSpike,
      contextHot,
    };
  }

  // 3 thrashing
  const inWindow = contributions.filter((c) => {
    const t = Date.parse(c.createdAt);
    return !Number.isNaN(t) && now - t <= thresholds.thrashWindowMs;
  });
  // Thrashing key is contributions[i].relations[0].targetCid — the "primary"
  // relation. Contributions can have multiple relations, but in Grove the
  // first slot is the target the contribution is *about*; subsequent slots
  // are usually parent/derives-from links. Looking past slot 0 would
  // mis-flag a normal review chain as a loop.
  if (inWindow.length >= thresholds.thrashContribs) {
    const ref = inWindow[0];
    const refTarget = ref?.relations[0]?.targetCid;
    const allSame =
      refTarget !== undefined &&
      inWindow.every((c) => c.relations[0]?.targetCid === refTarget);
    if (allSame) {
      return {
        state: "thrashing",
        stateReason: `${inWindow.length} contribs in ${Math.round(thresholds.thrashWindowMs / 1000)}s`,
        lastActionAt: baselineLastActionAt,
        costSpike,
        contextHot,
      };
    }
  }

  // 4 stuck
  if (claim && claim.status === ClaimStatus.Active) {
    const claimAge = now - claimStartedAt;
    const stuckCandidates = contributions.filter((c) => {
      const t = Date.parse(c.createdAt);
      return !Number.isNaN(t) && now - t <= thresholds.stuckMs;
    });
    const kinds = new Set(stuckCandidates.map((c) => c.kind));
    // Claim.targetRef is immutable — agents release+recreate when switching
    // tasks, so claim age equals time on current task.
    if (claimAge > thresholds.stuckMs && kinds.size <= 1) {
      return {
        state: "stuck",
        stateReason: `${formatAge(claimAge)} same task`,
        lastActionAt: baselineLastActionAt,
        costSpike,
        contextHot,
      };
    }
  }

  // 5 silent
  if (claim && claim.status === ClaimStatus.Active) {
    const refAt = lastContribAt || claimStartedAt;
    if (refAt > 0 && now - refAt > thresholds.silentMs) {
      return {
        state: "silent",
        stateReason: `silent ${formatAge(now - refAt)}`,
        lastActionAt: baselineLastActionAt,
        costSpike,
        contextHot,
      };
    }
  }

  // 6 running
  if (claim && claim.status === ClaimStatus.Active) {
    return {
      state: "running",
      stateReason: lastContribAt ? `last ${formatAge(now - lastContribAt)}` : "starting",
      lastActionAt: baselineLastActionAt,
      costSpike,
      contextHot,
    };
  }

  // 7 done
  if (input.completedAt !== undefined && now - input.completedAt < thresholds.completedRetentionMs) {
    return {
      state: "done",
      stateReason: `done ${formatAge(now - input.completedAt)} ago`,
      lastActionAt: input.completedAt,
      costSpike,
      contextHot,
    };
  }

  // 8 idle
  return {
    state: "idle",
    stateReason: "idle",
    lastActionAt: baselineLastActionAt,
    costSpike,
    contextHot,
  };
}

function formatAge(ms: number): string {
  if (ms < 1_000) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}
