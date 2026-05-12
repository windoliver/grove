import type { AgentIdentity } from "../models.js";
import type { ContributionStore } from "../store.js";
import { resolveAgent } from "./agent.js";
import type { OperationDeps } from "./deps.js";
import type { InboxMessage, InboxQuery, SendMessageInput, SendMessageResult } from "./messaging.js";
import { readInbox, sendMessageAsDiscussion } from "./messaging.js";
import type { OperationResult } from "./result.js";

export interface InboxReadSource {
  readInbox(query?: InboxQuery): Promise<readonly InboxMessage[]>;
}

function hasRecipientFilter(query?: InboxQuery): boolean {
  return (
    query?.recipient !== undefined ||
    (query?.recipients !== undefined && query.recipients.length > 0)
  );
}

export async function readInboxWithSource(
  store: ContributionStore,
  query?: InboxQuery,
  source?: InboxReadSource | undefined,
): Promise<readonly InboxMessage[]> {
  if (source === undefined || !hasRecipientFilter(query)) {
    return readInbox(store, query);
  }

  try {
    return await source.readInbox(query);
  } catch {
    return readInbox(store, query);
  }
}

export interface DeliveredInboxMessage {
  readonly cid: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly createdAt: string;
  readonly from: AgentIdentity;
}

export interface MessageDelivery {
  deliverMessage(message: DeliveredInboxMessage): Promise<void>;
}

export async function sendMessageWithDelivery(
  input: SendMessageInput,
  deps: OperationDeps,
  delivery?: MessageDelivery | undefined,
): Promise<OperationResult<SendMessageResult>> {
  const result = await sendMessageAsDiscussion(input, deps);
  if (!result.ok || delivery === undefined) return result;

  const from = resolveAgent(input.agent);
  try {
    await delivery.deliverMessage({
      cid: result.value.cid,
      body: input.body,
      recipients: [...input.recipients],
      createdAt: result.value.createdAt,
      from,
    });
  } catch {
    // Best-effort Nexus delivery must not roll back the canonical contribution.
  }

  return result;
}
