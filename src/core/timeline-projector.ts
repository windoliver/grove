import type { AgentSession } from "./agent-runtime.js";
import type { Claim, Contribution, JsonValue } from "./models.js";
import { ContributionKind, RelationType } from "./models.js";
import {
  type PlanTask,
  type PlanTaskStatus,
  parsePlanContext,
} from "./operations/context-schemas.js";
import type { CostSummary, ResourceRef, TimelineEventType, WorkBlock } from "./timeline.js";
import { TimelineEventType as TimelineEventTypes } from "./timeline.js";
import type { TimelineEventInput } from "./timeline-store.js";

export interface ContributionTimelineProjectionOptions {
  readonly previousPlan?: Contribution | undefined;
}

export function timelineEventsForContribution(
  c: Contribution,
  opts: ContributionTimelineProjectionOptions = {},
): readonly TimelineEventInput[] {
  const sessionId = contextString(c.context, "session_id");
  const workBlockId = contextString(c.context, "work_block_id");
  const base = {
    ...(sessionId === undefined ? {} : { sessionId }),
    occurredAt: c.createdAt,
    actor: c.agent,
    ...(workBlockId === undefined ? {} : { workBlockId }),
  };
  const events: TimelineEventInput[] = [
    {
      eventId: `te:contribution:${c.cid}:created`,
      ...base,
      type: TimelineEventTypes.ContributionCreated,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: contributionCreatedPayload(c),
    },
  ];

  if (c.kind === ContributionKind.AskUser || contextBoolean(c.context, "ask_user_question")) {
    events.push({
      eventId: `te:contribution:${c.cid}:approval:requested`,
      ...base,
      type: TimelineEventTypes.ApprovalRequested,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: {
        question: contextString(c.context, "question_text") ?? c.description ?? c.summary,
      },
    });
  }

  if (c.kind === ContributionKind.Response || contextBoolean(c.context, "ask_user_answer")) {
    const targetRefs: ResourceRef[] = [{ kind: "Contribution", id: c.cid }];
    const questionCid = c.relations.find(
      (relation) => relation.relationType === RelationType.RespondsTo,
    )?.targetCid;
    if (questionCid !== undefined) {
      targetRefs.push({ kind: "Contribution", id: questionCid });
    }
    events.push({
      eventId: `te:contribution:${c.cid}:approval:decided`,
      ...base,
      type: TimelineEventTypes.ApprovalDecided,
      targetRefs,
      payload: { answer: contextString(c.context, "answer_text") ?? c.description ?? c.summary },
    });
  }

  for (const [name, hash] of Object.entries(c.artifacts)) {
    events.push({
      eventId: `te:contribution:${c.cid}:artifact:${name}`,
      ...base,
      type: TimelineEventTypes.ArtifactLinked,
      targetRefs: [{ kind: "Artifact", id: hash, label: name }],
      payload: { contributionCid: c.cid, name, contentHash: hash },
    });
  }

  const usageReport = c.context?.usage_report;
  if (usageReport !== undefined) {
    events.push({
      eventId: `te:contribution:${c.cid}:cost:reported`,
      ...base,
      type: TimelineEventTypes.CostReported,
      targetRefs: [{ kind: "Contribution", id: c.cid }],
      payload: { usageReport },
    });
  }

  events.push(...planTimelineEvents(c, base, opts.previousPlan));

  return events;
}

export function timelineEventForClaim(
  claim: Claim,
  eventType: TimelineEventType,
  opts: { readonly occurredAt?: string | undefined } = {},
): TimelineEventInput {
  const sessionId = contextString(claim.context, "session_id");
  const workBlockId = contextString(claim.context, "work_block_id");
  const revision = claim.revision ?? 0;
  return {
    eventId: `te:claim:${claim.claimId}:${revision}:${eventType}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    type: eventType,
    occurredAt: opts.occurredAt ?? defaultClaimEventTime(claim, eventType),
    actor: claim.agent,
    ...(workBlockId === undefined ? {} : { workBlockId }),
    targetRefs: [{ kind: "Claim", id: claim.claimId }],
    payload: {
      claimId: claim.claimId,
      targetRef: claim.targetRef,
      status: claim.status,
      intentSummary: claim.intentSummary,
      revision,
    },
  };
}

export function claimTimelineEventTypeForStatus(
  status: Claim["status"],
): TimelineEventType | undefined {
  switch (status) {
    case "completed":
      return TimelineEventTypes.ClaimCompleted;
    case "released":
      return TimelineEventTypes.ClaimReleased;
    case "expired":
      return TimelineEventTypes.ClaimExpired;
    case "active":
      return TimelineEventTypes.ClaimLeaseRefreshed;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return undefined;
    }
  }
}

export function claimWorkBlockId(claim: Claim): string | undefined {
  return contextString(claim.context, "work_block_id");
}

export function timelineEventForWorkBlock(
  block: WorkBlock,
  eventType: TimelineEventType,
  opts: { readonly occurredAt?: string | undefined } = {},
): TimelineEventInput {
  return {
    eventId: `te:work_block:${block.workBlockId}:${block.revision}:${eventType}`,
    ...(block.sessionId === undefined ? {} : { sessionId: block.sessionId }),
    type: eventType,
    occurredAt: opts.occurredAt ?? workBlockEventTime(block, eventType),
    actor: block.actor,
    workBlockId: block.workBlockId,
    targetRefs: [{ kind: "WorkBlock", id: block.workBlockId }],
    payload: {
      workBlockId: block.workBlockId,
      goal: block.goal,
      status: block.status,
      revision: block.revision,
    },
  };
}

export function timelineEventForAgentSession(
  session: AgentSession,
  op: "ADDED" | "MODIFIED" | "DELETED",
  opts: { readonly occurredAt?: string | undefined } = {},
): TimelineEventInput {
  const eventType = agentSessionTimelineEventType(op);
  return {
    eventId: `te:agent_session:${session.id}:${eventType}:${session.status}`,
    sessionId: session.id,
    type: eventType,
    occurredAt: opts.occurredAt ?? new Date().toISOString(),
    actor: {
      agentId: session.id,
      role: session.role,
      ...(session.platform === undefined ? {} : { platform: session.platform }),
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.agent === undefined ? {} : { runtime: session.agent }),
    },
    targetRefs: [{ kind: "AgentSession", id: session.id }],
    payload: {
      sessionId: session.id,
      role: session.role,
      status: session.status,
      ...(session.pid === undefined ? {} : { pid: session.pid }),
      ...(session.platform === undefined ? {} : { platform: session.platform }),
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.agent === undefined ? {} : { agent: session.agent }),
    },
  };
}

export function workBlockTimelineEventTypeForStatus(
  status: WorkBlock["status"],
): TimelineEventType {
  switch (status) {
    case "running":
      return TimelineEventTypes.WorkBlockStarted;
    case "completed":
      return TimelineEventTypes.WorkBlockCompleted;
    case "failed":
      return TimelineEventTypes.WorkBlockFailed;
    case "pending":
    case "blocked":
    case "waiting_approval":
    case "cancelled":
      return TimelineEventTypes.WorkBlockStatusChanged;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return TimelineEventTypes.WorkBlockStatusChanged;
    }
  }
}

export function costSummaryForUsageReport(report: JsonValue | undefined): CostSummary | undefined {
  if (!isJsonObject(report)) return undefined;
  const inputTokens = numberField(report, "input_tokens");
  const outputTokens = numberField(report, "output_tokens");
  const costUsd = numberField(report, "cost_usd");
  const model = stringField(report, "model");
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    costUsd === undefined &&
    model === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(model === undefined ? {} : { model }),
  };
}

function contributionCreatedPayload(c: Contribution): Readonly<Record<string, JsonValue>> {
  return {
    cid: c.cid,
    kind: c.kind,
    mode: c.mode,
    summary: c.summary,
    tags: [...c.tags],
    ...(c.description === undefined ? {} : { description: c.description }),
  };
}

function planTimelineEvents(
  c: Contribution,
  base: {
    readonly sessionId?: string | undefined;
    readonly occurredAt: string;
    readonly actor: Contribution["agent"];
    readonly workBlockId?: string | undefined;
  },
  previousPlan: Contribution | undefined,
): readonly TimelineEventInput[] {
  if (c.kind !== ContributionKind.Plan) return [];
  const current = parsePlanContext(c.context);
  if (current === undefined) return [];
  const previous =
    previousPlan?.kind === ContributionKind.Plan
      ? parsePlanContext(previousPlan.context)
      : undefined;
  const previousById = new Map(previous?.tasks.map((task) => [task.id, task]));
  const events: TimelineEventInput[] = [];

  for (const task of current.tasks) {
    const prior = previousById.get(task.id);
    if (prior === undefined) {
      events.push(planTaskEvent(c, base, task, TimelineEventTypes.PlanTaskCreated));
    } else if (prior.status !== task.status) {
      events.push(
        planTaskEvent(c, base, task, TimelineEventTypes.PlanTaskStatusChanged, prior.status),
      );
    }
  }

  return events;
}

function planTaskEvent(
  c: Contribution,
  base: {
    readonly sessionId?: string | undefined;
    readonly occurredAt: string;
    readonly actor: Contribution["agent"];
    readonly workBlockId?: string | undefined;
  },
  task: PlanTask,
  type: TimelineEventType,
  previousStatus?: PlanTaskStatus | undefined,
): TimelineEventInput {
  return {
    eventId: `te:plan:${c.cid}:task:${task.id}:${task.status}`,
    ...base,
    type,
    targetRefs: [
      { kind: "Contribution", id: c.cid },
      { kind: "AgentTask", id: task.id, label: task.title },
    ],
    payload: {
      planCid: c.cid,
      taskId: task.id,
      title: task.title,
      status: task.status,
      ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
      ...(previousStatus === undefined ? {} : { previousStatus }),
    },
  };
}

function defaultClaimEventTime(claim: Claim, eventType: TimelineEventType): string {
  if (eventType === TimelineEventTypes.ClaimCreated) return claim.createdAt;
  return claim.heartbeatAt;
}

function workBlockEventTime(block: WorkBlock, eventType: TimelineEventType): string {
  if (
    eventType === TimelineEventTypes.WorkBlockCompleted ||
    eventType === TimelineEventTypes.WorkBlockFailed
  ) {
    return block.completedAt ?? block.updatedAt;
  }
  if (eventType === TimelineEventTypes.WorkBlockStarted) {
    return block.startedAt ?? block.updatedAt;
  }
  return block.updatedAt;
}

function agentSessionTimelineEventType(op: "ADDED" | "MODIFIED" | "DELETED"): TimelineEventType {
  switch (op) {
    case "ADDED":
      return TimelineEventTypes.AgentSessionStarted;
    case "MODIFIED":
      return TimelineEventTypes.AgentSessionStatusChanged;
    case "DELETED":
      return TimelineEventTypes.AgentSessionStopped;
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return TimelineEventTypes.AgentSessionStatusChanged;
    }
  }
}

function contextString(
  context: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): string | undefined {
  const value = context?.[key];
  return typeof value === "string" ? value : undefined;
}

function contextBoolean(
  context: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): boolean {
  return context?.[key] === true;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(
  record: { readonly [key: string]: JsonValue },
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(
  record: { readonly [key: string]: JsonValue },
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
