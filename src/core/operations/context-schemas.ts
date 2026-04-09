/**
 * Typed context schemas for kind-specific contribution data.
 *
 * Plans and messages stuff structured fields into the generic
 * `context: Record<string, JsonValue>` field on a contribution. Without a
 * central schema, every read site uses unsafe casts (`as string`,
 * `as PlanTask[]`) and every write site is a free-form object literal.
 *
 * This module is the single source of truth for those magic context keys:
 *
 * - `PlanContext` — fields stored on `kind=plan` contributions
 * - `MessageContext` — fields stored on `kind=discussion` contributions
 *   that are messages (vs. regular discussions)
 *
 * Each schema has a builder (writer side) and a parser (reader side).
 * The builder returns a `Record<string, JsonValue>` ready to drop into
 * `ContributeInput.context`. The parser narrows untyped context into a
 * typed object or returns undefined when the context doesn't match.
 */

import { z } from "zod";

import type { JsonValue } from "../models.js";

// ---------------------------------------------------------------------------
// Plan context
// ---------------------------------------------------------------------------

export const PLAN_TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly status: PlanTaskStatus;
  readonly assignee?: string | undefined;
}

export interface PlanContext {
  readonly plan_title: string;
  readonly tasks: readonly PlanTask[];
}

const PlanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(PLAN_TASK_STATUSES),
  assignee: z.string().optional(),
});

const PlanContextSchema = z.object({
  plan_title: z.string(),
  tasks: z.array(PlanTaskSchema),
});

/**
 * Build a Plan context payload for `ContributeInput.context`.
 * Encapsulates the field names so writers don't have to remember the
 * magic keys.
 */
export function buildPlanContext(input: {
  readonly title: string;
  readonly tasks: readonly PlanTask[];
}): Record<string, JsonValue> {
  return {
    plan_title: input.title,
    tasks: input.tasks as unknown as JsonValue,
  };
}

/**
 * Parse the plan-specific fields out of an untyped contribution context.
 * Returns undefined when the context is missing or malformed (no exception
 * — readers can treat this as "not a plan context").
 */
export function parsePlanContext(
  context: Readonly<Record<string, JsonValue>> | undefined,
): PlanContext | undefined {
  if (context === undefined) return undefined;
  const result = PlanContextSchema.safeParse(context);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Message context
// ---------------------------------------------------------------------------

export interface MessageContext {
  readonly ephemeral: true;
  readonly recipients: readonly string[];
  readonly message_body: string;
}

const MessageContextSchema = z.object({
  ephemeral: z.literal(true),
  recipients: z.array(z.string()).min(1),
  message_body: z.string(),
});

/**
 * Build a Message context payload for `ContributeInput.context`.
 * Messages are ephemeral discussions with addressed recipients — this
 * helper sets the ephemeral marker, recipients list, and body verbatim.
 */
export function buildMessageContext(input: {
  readonly recipients: readonly string[];
  readonly body: string;
}): Record<string, JsonValue> {
  return {
    ephemeral: true,
    recipients: [...input.recipients],
    message_body: input.body,
  };
}

/**
 * Parse the message-specific fields out of an untyped contribution context.
 * Returns undefined when the context is missing or doesn't have the
 * ephemeral message shape (e.g., a regular non-ephemeral discussion).
 */
export function parseMessageContext(
  context: Readonly<Record<string, JsonValue>> | undefined,
): MessageContext | undefined {
  if (context === undefined) return undefined;
  const result = MessageContextSchema.safeParse(context);
  return result.success ? result.data : undefined;
}

/**
 * Quick predicate: true when a context represents an ephemeral message.
 * Cheaper than running the full Zod parser when callers only need the
 * boolean (e.g., to skip topology routing for chat).
 */
export function isEphemeralMessageContext(
  context: Readonly<Record<string, JsonValue>> | undefined,
): boolean {
  return context !== undefined && context.ephemeral === true;
}
