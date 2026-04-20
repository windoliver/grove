/**
 * Inbox query operations.
 *
 * Sending a message is just a discussion contribution with an ephemeral
 * context payload — see `sendMessageAsDiscussion()` below for the helper
 * that wraps `discussOperation`. This module's primary responsibility is
 * the read side: filtering, sorting, and projecting discussion contributions
 * back into InboxMessage shapes.
 *
 * All messages flow through the ContributionStore — Nexus-first, with
 * local SQLite as fallback.
 */

import type { Contribution } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { ContributionStore } from "../store.js";
import type { AgentOverrides } from "./agent.js";
import { buildMessageContext, parseMessageContext } from "./context-schemas.js";
import { contributeOperation } from "./contribute.js";
import type { OperationDeps } from "./deps.js";
import type { OperationResult } from "./result.js";
import { ok, validationErr } from "./result.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for sending a message via the discussion-as-message helper. */
export interface SendMessageInput {
  /** Sending agent (overrides; resolved by discussOperation). */
  readonly agent?: AgentOverrides | undefined;
  /** Message body text. Must be non-empty after trimming. */
  readonly body: string;
  /** Recipients: "@agent-name" handles, "@all" for broadcast. Must be non-empty. */
  readonly recipients: readonly string[];
  /** Optional CID to respond to (creates responds_to relation). */
  readonly inReplyTo?: string | undefined;
  /** Optional tags for filtering. */
  readonly tags?: readonly string[] | undefined;
  /** Optional idempotency key for retry safety. */
  readonly idempotencyKey?: string | undefined;
}

/** Result of sending a message via the helper. */
export interface SendMessageResult {
  readonly cid: string;
  readonly summary: string;
  readonly recipients: readonly string[];
  readonly createdAt: string;
}

/** A message read from the inbox. */
export interface InboxMessage {
  readonly cid: string;
  readonly from: import("../models.js").AgentIdentity;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly inReplyTo?: string | undefined;
  readonly createdAt: string;
  readonly tags: readonly string[];
}

/** Filters for reading inbox messages. */
export interface InboxQuery {
  /** Filter to messages addressed to this handle (e.g., "@claude-eng"). */
  readonly recipient?: string | undefined;
  /** Filter to messages addressed to any of these handles (e.g., ["@agent-id", "@role", "@all"]). */
  readonly recipients?: readonly string[] | undefined;
  /** Filter to messages from this agent ID. */
  readonly fromAgentId?: string | undefined;
  /** Only return messages after this ISO timestamp. */
  readonly since?: string | undefined;
  /** Maximum number of messages to return. */
  readonly limit?: number | undefined;
  readonly sessionId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Send a message by creating an ephemeral discussion contribution.
 *
 * Sugar over contributeOperation: builds a discussion-kind contribution
 * with the ephemeral message context (recipients + body) and an optional
 * responds_to relation. Routes through the canonical write pipeline so
 * role-kind constraints, hooks, and idempotency apply uniformly with
 * other contributions.
 *
 * Replaces the previous standalone sendMessage that took a raw store +
 * computeCid and bypassed PolicyEnforcer / TopologyRouter (the #228 bug
 * for the messaging path).
 */
export async function sendMessageAsDiscussion(
  input: SendMessageInput,
  deps: OperationDeps,
): Promise<OperationResult<SendMessageResult>> {
  if (input.recipients.length === 0) {
    return validationErr("Message must have at least one recipient");
  }
  if (input.body.trim().length === 0) {
    return validationErr("Message body cannot be empty");
  }

  const result = await contributeOperation(
    {
      kind: ContributionKind.Discussion,
      mode: ContributionMode.Exploration,
      summary: truncateSummary(input.body),
      description: input.body,
      relations: input.inReplyTo
        ? [{ targetCid: input.inReplyTo, relationType: RelationType.RespondsTo }]
        : [],
      tags: [...(input.tags ?? []), "message"],
      context: buildMessageContext({ recipients: input.recipients, body: input.body }),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    deps,
  );

  if (!result.ok) return result as OperationResult<SendMessageResult>;
  return ok({
    cid: result.value.cid,
    summary: result.value.summary,
    recipients: [...input.recipients],
    createdAt: result.value.createdAt,
  });
}

/**
 * Read inbox messages from the contribution store.
 *
 * Filters discussion contributions that have `context.ephemeral = true`
 * and `context.recipients` containing the specified handle.
 */
export async function readInbox(
  store: ContributionStore,
  query?: InboxQuery,
): Promise<readonly InboxMessage[]> {
  // When filtering by recipient(s), we must fetch all discussions so
  // post-fetch filtering doesn't miss older messages buried under
  // unrelated traffic. Only apply a store-level limit when no
  // recipient filtering is requested.
  const needsRecipientFilter =
    query?.recipient !== undefined ||
    (query?.recipients !== undefined && query.recipients.length > 0);
  const storeLimit = needsRecipientFilter ? undefined : (query?.limit ?? 50) * 3;

  const contributions = await store.list({
    kind: ContributionKind.Discussion,
    tags: ["message"],
    ...(storeLimit !== undefined ? { limit: storeLimit } : {}),
    ...(query?.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
  });

  // Pair each contribution with its parsed message context up front so we
  // don't re-parse on every filter pass and so wrong-shape contributions are
  // dropped exactly once.
  let messages = contributions.flatMap((c) => {
    const ctx = parseMessageContext(c.context);
    return ctx === undefined ? [] : [{ contribution: c, context: ctx }];
  });

  // Filter by single recipient (legacy)
  if (query?.recipient !== undefined) {
    const target = query.recipient;
    messages = messages.filter(
      ({ context }) => context.recipients.includes(target) || context.recipients.includes("@all"),
    );
  }

  // Filter by multiple recipients (matches if any handle appears in the message)
  if (query?.recipients !== undefined && query.recipients.length > 0) {
    const handles = new Set(query.recipients);
    messages = messages.filter(
      ({ context }) =>
        context.recipients.includes("@all") || context.recipients.some((r) => handles.has(r)),
    );
  }

  // Filter by sender
  if (query?.fromAgentId !== undefined) {
    messages = messages.filter(
      ({ contribution }) => contribution.agent.agentId === query.fromAgentId,
    );
  }

  // Filter by timestamp
  if (query?.since !== undefined) {
    const sinceMs = Date.parse(query.since);
    messages = messages.filter(({ contribution }) => Date.parse(contribution.createdAt) >= sinceMs);
  }

  // Sort by most recent first
  messages.sort(
    (a, b) => Date.parse(b.contribution.createdAt) - Date.parse(a.contribution.createdAt),
  );

  // Apply limit
  const limit = query?.limit ?? 50;
  messages = messages.slice(0, limit);

  return messages.map(({ contribution, context }) => contributionToMessage(contribution, context));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contributionToMessage(
  c: Contribution,
  ctx: { readonly recipients: readonly string[]; readonly message_body: string },
): InboxMessage {
  const inReplyTo = c.relations.find((r) => r.relationType === RelationType.RespondsTo)?.targetCid;

  return {
    cid: c.cid,
    from: c.agent,
    body: ctx.message_body,
    recipients: [...ctx.recipients],
    inReplyTo,
    createdAt: c.createdAt,
    tags: [...c.tags],
  };
}

/** Truncate message body to a short summary (first line, max 120 chars). */
function truncateSummary(body: string): string {
  const firstLine = body.split("\n")[0] ?? body;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
