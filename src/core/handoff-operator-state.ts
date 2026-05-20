import { AgentTaskConditionType, AgentTaskPhase, type AgentTaskView } from "./agent-task.js";
import { type Handoff, HandoffStatus } from "./handoff.js";

export const HandoffOperatorState = {
  Pending: "pending",
  Overdue: "overdue",
  Blocked: "blocked",
  DeadLettered: "dead_lettered",
  Resolved: "resolved",
  Cancelled: "cancelled",
  ManuallyResolved: "manually_resolved",
} as const;
export type HandoffOperatorState = (typeof HandoffOperatorState)[keyof typeof HandoffOperatorState];

export const HandoffOperatorAction = {
  Resend: "resend",
  Reroute: "reroute",
  Cancel: "cancel",
  ManualResolve: "manual_resolve",
} as const;
export type HandoffOperatorAction =
  (typeof HandoffOperatorAction)[keyof typeof HandoffOperatorAction];

export interface HandoffHealthSignal {
  readonly role: string;
  readonly healthy: boolean;
  readonly reason: string;
}

export interface HandoffOperatorProjection {
  readonly handoff: Handoff;
  readonly state: HandoffOperatorState;
  readonly reason: string;
  readonly actions: readonly HandoffOperatorAction[];
}

export interface HandoffOperatorOptions {
  readonly now?: string | undefined;
  readonly healthSignals?: readonly HandoffHealthSignal[] | undefined;
}

export interface HandoffOperatorCounts {
  readonly pending: number;
  readonly overdue: number;
  readonly blocked: number;
  readonly deadLettered: number;
}

const UNRESOLVED_STATUSES: ReadonlySet<HandoffStatus> = new Set([
  HandoffStatus.PendingPickup,
  HandoffStatus.Delivered,
  HandoffStatus.Processed,
]);

const BLOCKED_ACTIONS: readonly HandoffOperatorAction[] = [
  HandoffOperatorAction.Resend,
  HandoffOperatorAction.Reroute,
  HandoffOperatorAction.Cancel,
  HandoffOperatorAction.ManualResolve,
];

const OVERDUE_ACTIONS: readonly HandoffOperatorAction[] = [
  HandoffOperatorAction.Resend,
  HandoffOperatorAction.Cancel,
  HandoffOperatorAction.ManualResolve,
];

const DEAD_LETTERED_ACTIONS: readonly HandoffOperatorAction[] = [
  HandoffOperatorAction.Resend,
  HandoffOperatorAction.Reroute,
  HandoffOperatorAction.ManualResolve,
];

const PENDING_ACTIONS: readonly HandoffOperatorAction[] = [
  HandoffOperatorAction.Resend,
  HandoffOperatorAction.Cancel,
];

const FINAL_ACTIONS: readonly HandoffOperatorAction[] = [];

export function deriveHandoffOperatorProjection(
  handoff: Handoff,
  options?: HandoffOperatorOptions,
): HandoffOperatorProjection {
  const state = deriveState(handoff, options);
  return {
    handoff,
    state,
    reason: reasonFor(handoff, state, options),
    actions: actionsFor(state),
  };
}

export function countHandoffOperatorStates(
  projections: readonly HandoffOperatorProjection[],
): HandoffOperatorCounts {
  const counts = {
    pending: 0,
    overdue: 0,
    blocked: 0,
    deadLettered: 0,
  };

  for (const projection of projections) {
    if (projection.state === HandoffOperatorState.Pending) counts.pending += 1;
    if (projection.state === HandoffOperatorState.Overdue) counts.overdue += 1;
    if (projection.state === HandoffOperatorState.Blocked) counts.blocked += 1;
    if (projection.state === HandoffOperatorState.DeadLettered) counts.deadLettered += 1;
  }

  return counts;
}

export function healthSignalsFromAgentTasks(
  tasks: readonly AgentTaskView[],
): readonly HandoffHealthSignal[] {
  const signals: HandoffHealthSignal[] = [];

  for (const task of tasks) {
    if (task.status.phase === AgentTaskPhase.Failed) {
      signals.push({
        role: task.spec.role,
        healthy: false,
        reason: "agent task failed",
      });
      continue;
    }

    const unhealthyCondition = task.status.conditions.find(isUnhealthyTaskCondition);
    if (unhealthyCondition === undefined) continue;

    signals.push({
      role: task.spec.role,
      healthy: false,
      reason: conditionReason(unhealthyCondition.reason, unhealthyCondition.type),
    });
  }

  return signals;
}

export function healthSignalsFromAgentFailures(
  failures: ReadonlyMap<string, string> | undefined,
): readonly HandoffHealthSignal[] {
  if (failures === undefined) return [];

  const signals: HandoffHealthSignal[] = [];
  for (const [role, reason] of failures.entries()) {
    signals.push({ role, healthy: false, reason });
  }
  return signals;
}

function deriveState(handoff: Handoff, options?: HandoffOperatorOptions): HandoffOperatorState {
  if (handoff.status === HandoffStatus.DeadLettered) return HandoffOperatorState.DeadLettered;
  if (handoff.status === HandoffStatus.Replied) return HandoffOperatorState.Resolved;
  if (handoff.status === HandoffStatus.Cancelled) return HandoffOperatorState.Cancelled;
  if (handoff.status === HandoffStatus.ManuallyResolved) {
    return HandoffOperatorState.ManuallyResolved;
  }
  if (handoff.status === HandoffStatus.Expired) return HandoffOperatorState.Overdue;
  if (!UNRESOLVED_STATUSES.has(handoff.status)) return HandoffOperatorState.Pending;

  if (unhealthySignalFor(handoff, options?.healthSignals) !== undefined) {
    return HandoffOperatorState.Blocked;
  }

  if (handoff.replyDueAt !== undefined && Date.parse(handoff.replyDueAt) <= nowMs(options)) {
    return HandoffOperatorState.Overdue;
  }

  return HandoffOperatorState.Pending;
}

function reasonFor(
  handoff: Handoff,
  state: HandoffOperatorState,
  options?: HandoffOperatorOptions,
): string {
  if (state === HandoffOperatorState.Pending) return "waiting for target role";
  if (state === HandoffOperatorState.Overdue) return "deadline passed";
  if (state === HandoffOperatorState.Blocked) {
    const reason = unhealthySignalFor(handoff, options?.healthSignals)?.reason;
    return reason === undefined
      ? "target unavailable"
      : conditionReason(reason, "target unavailable");
  }
  if (state === HandoffOperatorState.DeadLettered) return "delivery failed";
  if (state === HandoffOperatorState.Resolved) return "reply received";
  if (state === HandoffOperatorState.Cancelled) {
    return handoff.terminalReason ?? "operator cancelled";
  }
  return handoff.terminalReason ?? "operator resolved";
}

function actionsFor(state: HandoffOperatorState): readonly HandoffOperatorAction[] {
  if (state === HandoffOperatorState.Blocked) return BLOCKED_ACTIONS;
  if (state === HandoffOperatorState.Overdue) return OVERDUE_ACTIONS;
  if (state === HandoffOperatorState.DeadLettered) return DEAD_LETTERED_ACTIONS;
  if (state === HandoffOperatorState.Pending) return PENDING_ACTIONS;
  return FINAL_ACTIONS;
}

function unhealthySignalFor(
  handoff: Handoff,
  healthSignals?: readonly HandoffHealthSignal[] | undefined,
): HandoffHealthSignal | undefined {
  return healthSignals?.find((signal) => signal.role === handoff.toRole && !signal.healthy);
}

function nowMs(options?: HandoffOperatorOptions): number {
  return Date.parse(options?.now ?? new Date().toISOString());
}

function isUnhealthyTaskCondition(condition: {
  readonly type: string;
  readonly status: string;
}): boolean {
  if (condition.status !== "True") return false;
  return (
    condition.type === AgentTaskConditionType.Blocked ||
    condition.type === AgentTaskConditionType.Unschedulable ||
    condition.type === AgentTaskConditionType.Failed
  );
}

function conditionReason(reason: string, fallback: string): string {
  if (reason.length > 0) return reason;
  return fallback;
}
