import type { AgentIdentity, JsonValue } from "./models.js";

export const WorkBlockStatus = {
  Pending: "pending",
  Running: "running",
  Blocked: "blocked",
  WaitingApproval: "waiting_approval",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type WorkBlockStatus = (typeof WorkBlockStatus)[keyof typeof WorkBlockStatus];

export const WorkBlockOrigin = {
  Manual: "manual",
  Agent: "agent",
  Scheduled: "scheduled",
  Triggered: "triggered",
} as const;
export type WorkBlockOrigin = (typeof WorkBlockOrigin)[keyof typeof WorkBlockOrigin];

export const TimelineEventType = {
  WorkBlockCreated: "work_block.created",
  WorkBlockStarted: "work_block.started",
  WorkBlockStatusChanged: "work_block.status_changed",
  WorkBlockCompleted: "work_block.completed",
  WorkBlockFailed: "work_block.failed",
  AgentSessionStarted: "agent_session.started",
  AgentSessionStatusChanged: "agent_session.status_changed",
  AgentSessionStopped: "agent_session.stopped",
  ClaimCreated: "claim.created",
  ClaimLeaseRefreshed: "claim.lease_refreshed",
  ClaimCompleted: "claim.completed",
  ClaimReleased: "claim.released",
  ClaimExpired: "claim.expired",
  ContributionCreated: "contribution.created",
  ArtifactLinked: "artifact.linked",
  ApprovalRequested: "approval.requested",
  ApprovalDecided: "approval.decided",
  CostReported: "cost.reported",
  PlanTaskCreated: "plan.task_created",
  PlanTaskStatusChanged: "plan.task_status_changed",
  RunHealthDegraded: "run.health_degraded",
  RunHealthRecovered: "run.health_recovered",
} as const;
export type TimelineEventType = (typeof TimelineEventType)[keyof typeof TimelineEventType];

export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string | undefined;
  readonly href?: string | undefined;
}

export interface CostSummary {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly model?: string | undefined;
}

export interface WorkBlock {
  readonly workBlockId: string;
  readonly sessionId?: string | undefined;
  readonly goal: string;
  readonly actor: AgentIdentity;
  readonly origin: WorkBlockOrigin;
  readonly status: WorkBlockStatus;
  readonly startedAt?: string | undefined;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
  readonly inputRefs: readonly ResourceRef[];
  readonly outputRefs: readonly ResourceRef[];
  readonly evidenceRefs: readonly ResourceRef[];
  readonly approvalRefs: readonly ResourceRef[];
  readonly contributionCids: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly claimIds: readonly string[];
  readonly costSummary?: CostSummary | undefined;
  readonly links?: readonly ResourceRef[] | undefined;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly revision: number;
  readonly createdAt: string;
}

export interface TimelineEvent {
  readonly eventId: string;
  readonly resourceVersion: string;
  readonly sessionId?: string | undefined;
  readonly type: TimelineEventType;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor?: AgentIdentity | undefined;
  readonly workBlockId?: string | undefined;
  readonly targetRefs: readonly ResourceRef[];
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface SessionTimeline {
  readonly sessionId?: string | undefined;
  readonly events: readonly TimelineEvent[];
  readonly workBlocks?: readonly WorkBlock[] | undefined;
  readonly timelineResourceVersion: string;
}

export function buildWorkBlockId(uuid: () => string = () => crypto.randomUUID()): string {
  return `wb_${uuid()}`;
}

export function buildTimelineEventId(uuid: () => string = () => crypto.randomUUID()): string {
  return `te_${uuid()}`;
}

export function timelineScope(sessionId?: string): string {
  if (sessionId === undefined) {
    return "global";
  }

  return `session/${encodeTimelineSegment(sessionId)}`;
}

export function mergeCostSummary(
  existing: CostSummary | undefined,
  incoming: CostSummary,
): CostSummary {
  return {
    inputTokens: addOptional(existing?.inputTokens, incoming.inputTokens),
    outputTokens: addOptional(existing?.outputTokens, incoming.outputTokens),
    costUsd: addOptional(existing?.costUsd, incoming.costUsd),
    model: incoming.model ?? existing?.model,
  };
}

function encodeTimelineSegment(segment: string): string {
  return segment.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function addOptional(
  existingValue: number | undefined,
  incomingValue: number | undefined,
): number | undefined {
  if (existingValue === undefined) {
    return incomingValue;
  }
  if (incomingValue === undefined) {
    return existingValue;
  }
  return existingValue + incomingValue;
}
