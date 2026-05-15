import { z } from "zod";

import type { AgentIdentity, JsonValue } from "./models.js";
import {
  type ResourceRef,
  type SessionTimeline,
  type TimelineEvent,
  TimelineEventType,
  type WorkBlock,
  WorkBlockOrigin,
  WorkBlockStatus,
} from "./timeline.js";

const TimestampSchema = z.string().datetime({
  offset: true,
  message: "expected ISO-8601 timestamp",
});

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const AgentIdentitySchema: z.ZodType<AgentIdentity> = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
    toolchain: z.string().optional(),
    runtime: z.string().optional(),
    role: z.string().optional(),
  })
  .strict();

const ResourceRefSchema: z.ZodType<ResourceRef> = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1),
    label: z.string().optional(),
    href: z.string().optional(),
  })
  .strict();

const CostSummarySchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    model: z.string().optional(),
  })
  .strict();

export const WorkBlockSchema: z.ZodType<WorkBlock> = z
  .object({
    workBlockId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    goal: z.string().min(1),
    actor: AgentIdentitySchema,
    origin: z.enum(Object.values(WorkBlockOrigin) as [WorkBlockOrigin, ...WorkBlockOrigin[]]),
    status: z.enum(Object.values(WorkBlockStatus) as [WorkBlockStatus, ...WorkBlockStatus[]]),
    startedAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    inputRefs: z.array(ResourceRefSchema),
    outputRefs: z.array(ResourceRefSchema),
    evidenceRefs: z.array(ResourceRefSchema),
    approvalRefs: z.array(ResourceRefSchema),
    contributionCids: z.array(z.string()),
    artifactHashes: z.array(z.string()),
    claimIds: z.array(z.string()),
    costSummary: CostSummarySchema.optional(),
    links: z.array(ResourceRefSchema).optional(),
    context: z.record(z.string(), JsonValueSchema).optional(),
    revision: z.number().int().min(1),
    createdAt: TimestampSchema,
  })
  .strict();

export const TimelineEventSchema: z.ZodType<TimelineEvent> = z
  .object({
    eventId: z.string().min(1),
    resourceVersion: z.string().regex(/^\d+$/),
    sessionId: z.string().min(1).optional(),
    type: z.enum(Object.values(TimelineEventType) as [TimelineEventType, ...TimelineEventType[]]),
    occurredAt: TimestampSchema,
    recordedAt: TimestampSchema,
    actor: AgentIdentitySchema.optional(),
    workBlockId: z.string().min(1).optional(),
    targetRefs: z.array(ResourceRefSchema),
    payload: z.record(z.string(), JsonValueSchema),
  })
  .strict();

export const SessionTimelineSchema: z.ZodType<SessionTimeline> = z
  .object({
    sessionId: z.string().min(1).optional(),
    events: z.array(TimelineEventSchema),
    workBlocks: z.array(WorkBlockSchema).optional(),
    timelineResourceVersion: z.string().regex(/^\d+$/),
  })
  .strict();

export function parseWorkBlock(data: unknown): WorkBlock {
  return WorkBlockSchema.parse(data);
}

export function parseWorkBlocks(data: unknown): readonly WorkBlock[] {
  return z.array(WorkBlockSchema).parse(data);
}

export function parseTimelineEvent(data: unknown): TimelineEvent {
  return TimelineEventSchema.parse(data);
}

export function parseTimelineEvents(data: unknown): readonly TimelineEvent[] {
  return z.array(TimelineEventSchema).parse(data);
}

export function parseSessionTimeline(data: unknown): SessionTimeline {
  return SessionTimelineSchema.parse(data);
}
