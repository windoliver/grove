/**
 * Messaging operations — send and read agent-to-agent messages.
 *
 * Messages are modeled as `discussion`-kind contributions with
 * `responds_to` relations and `recipients` + `ephemeral` context fields.
 * This reuses the existing contribution graph (DRY) while keeping
 * messages out of frontier ranking (ephemeral flag).
 *
 * All messages flow through the ContributionStore — Nexus-first,
 * with local SQLite as fallback.
 */

import type { AgentIdentity, Contribution, ContributionInput } from "../models.js";
import { ContributionKind, ContributionMode, RelationType } from "../models.js";
import type { ContributionStore } from "../store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for sending a message. */
export interface SendMessageInput {
  /** The agent sending the message. */
  readonly agent: AgentIdentity;
  /** Message body text. */
  readonly body: string;
  /** Recipients: "@agent-name" handles, "@all" for broadcast. */
  readonly recipients: readonly string[];
  /** Optional CID to respond to (creates responds_to relation). */
  readonly inReplyTo?: string | undefined;
  /** Optional tags for filtering. */
  readonly tags?: readonly string[] | undefined;
}

/** A message read from the inbox. */
export interface InboxMessage {
  readonly cid: string;
  readonly from: AgentIdentity;
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
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Send a message as a discussion contribution.
 *
 * The message is stored as a `discussion`-kind contribution with:
 * - `context.ephemeral = true` (excluded from frontier ranking)
 * - `context.recipients` (array of @handles)
 * - `context.message_body` (the text content)
 * - Optional `responds_to` relation for threaded replies
 */
export async function sendMessage(
  store: ContributionStore,
  input: SendMessageInput,
  computeCid: (input: ContributionInput) => string,
): Promise<Contribution> {
  if (input.recipients.length === 0) {
    throw new Error("Message must have at least one recipient");
  }
  if (input.body.trim().length === 0) {
    throw new Error("Message body cannot be empty");
  }

  const contributionInput: ContributionInput = {
    kind: ContributionKind.Discussion,
    mode: ContributionMode.Exploration,
    summary: truncateSummary(input.body),
    description: input.body,
    artifacts: {},
    relations: input.inReplyTo
      ? [{ targetCid: input.inReplyTo, relationType: RelationType.RespondsTo }]
      : [],
    tags: [...(input.tags ?? []), "message"],
    context: {
      ephemeral: true,
      recipients: [...input.recipients],
      message_body: input.body,
    },
    agent: input.agent,
    createdAt: new Date().toISOString(),
  };

  const cid = computeCid(contributionInput);
  const contribution: Contribution = {
    ...contributionInput,
    cid,
    manifestVersion: 1,
  };

  await store.put(contribution);
  return contribution;
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
    ...(storeLimit !== undefined ? { limit: storeLimit } : {}),
  });

  let messages = contributions.filter((c) => {
    if (c.context?.ephemeral !== true) return false;
    if (!Array.isArray(c.context.recipients)) return false;
    return true;
  });

  // Filter by single recipient (legacy)
  if (query?.recipient !== undefined) {
    const target = query.recipient;
    messages = messages.filter((c) => {
      const recipients = c.context?.recipients as string[];
      return recipients.includes(target) || recipients.includes("@all");
    });
  }

  // Filter by multiple recipients (matches if any handle appears in the message)
  if (query?.recipients !== undefined && query.recipients.length > 0) {
    const handles = new Set(query.recipients);
    messages = messages.filter((c) => {
      const recipients = c.context?.recipients as string[];
      return recipients.some((r) => handles.has(r));
    });
  }

  // Filter by sender
  if (query?.fromAgentId !== undefined) {
    messages = messages.filter((c) => c.agent.agentId === query.fromAgentId);
  }

  // Filter by timestamp
  if (query?.since !== undefined) {
    const sinceMs = Date.parse(query.since);
    messages = messages.filter((c) => Date.parse(c.createdAt) >= sinceMs);
  }

  // Sort by most recent first
  messages.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  // Apply limit
  const limit = query?.limit ?? 50;
  messages = messages.slice(0, limit);

  return messages.map(contributionToMessage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contributionToMessage(c: Contribution): InboxMessage {
  const inReplyTo = c.relations.find((r) => r.relationType === RelationType.RespondsTo)?.targetCid;

  return {
    cid: c.cid,
    from: c.agent,
    body: (c.context?.message_body as string) ?? c.description ?? c.summary,
    recipients: (c.context?.recipients as string[]) ?? [],
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
