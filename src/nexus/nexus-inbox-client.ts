import type { InboxReadSource } from "../core/operations/inbox-delegation.js";
import type { InboxMessage, InboxQuery } from "../core/operations/messaging.js";
import type { NexusClient } from "./client.js";
import { NexusNotFoundError } from "./errors.js";

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export interface NexusInboxClientOptions {
  readonly nexusUrl: string;
  readonly apiKey: string;
  readonly sessionId?: string | undefined;
  readonly client?: NexusClient | undefined;
  readonly fetch?: FetchFn | undefined;
}

interface GroveMessagePayload {
  readonly kind: "grove.message";
  readonly cid: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly createdAt: string;
  readonly from: { readonly agentId: string; readonly agentName?: string | undefined };
}

export class NexusInboxReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NexusInboxReadUnavailableError";
  }
}

export class NexusInboxClient implements InboxReadSource {
  private readonly nexusUrl: string;
  private readonly apiKey: string;
  private readonly sessionId: string | undefined;
  private readonly client: NexusClient | undefined;
  private readonly fetchFn: FetchFn;
  private directEndpointAvailable: boolean | undefined;

  constructor(opts: NexusInboxClientOptions) {
    this.nexusUrl = opts.nexusUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.sessionId = opts.sessionId;
    this.client = opts.client;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async readInbox(query?: InboxQuery): Promise<readonly InboxMessage[]> {
    const recipients = recipientHandles(query);
    const messages: InboxMessage[] = [];
    let sawSuccessfulRead = false;

    for (const handle of recipients) {
      const role = normalizeHandle(handle);
      const direct = await this.readDirect(role, query);
      if (direct !== undefined) {
        sawSuccessfulRead = true;
        messages.push(...direct);
        continue;
      }

      const fallback = await this.readFiles(role);
      if (fallback !== undefined) {
        sawSuccessfulRead = true;
        messages.push(...fallback);
      }
    }

    if (!sawSuccessfulRead) {
      throw new NexusInboxReadUnavailableError("Nexus inbox read unavailable");
    }

    return filterSortLimit(dedupe(messages), query);
  }

  private async readDirect(
    role: string,
    query?: InboxQuery,
  ): Promise<readonly InboxMessage[] | undefined> {
    if (this.directEndpointAvailable === false) return undefined;
    try {
      const params = new URLSearchParams();
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const resp = await this.fetchFn(
        `${this.nexusUrl}/api/v2/ipc/inbox/${encodeURIComponent(role)}${suffix}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
      );
      if (resp.status === 404 || resp.status === 405) {
        this.directEndpointAvailable = false;
        return undefined;
      }
      if (!resp.ok) return undefined;
      this.directEndpointAvailable = true;
      const body = (await resp.json()) as { readonly messages?: readonly unknown[] };
      return (body.messages ?? []).flatMap(messageFromDirect);
    } catch {
      return undefined;
    }
  }

  private async readFiles(role: string): Promise<readonly InboxMessage[] | undefined> {
    if (this.client === undefined) return undefined;
    const client = this.client;
    const dir = this.sessionId
      ? `/sessions/${this.sessionId}/ipc/${role}/inbox`
      : `/ipc/${role}/inbox`;
    try {
      const listed = await client.list(dir, { limit: 100 });
      const files = listed.files.filter(
        (entry) => !entry.isDirectory && entry.path.endsWith(".json"),
      );
      const decoded = await Promise.all(files.map(async (entry) => client.read(entry.path)));
      return decoded.flatMap((data) => (data === undefined ? [] : messageFromEnvelope(data)));
    } catch (err) {
      if (err instanceof NexusNotFoundError) return [];
      throw err;
    }
  }
}

function recipientHandles(query?: InboxQuery): readonly string[] {
  const handles = new Set<string>();
  if (query?.recipient !== undefined) handles.add(query.recipient);
  for (const r of query?.recipients ?? []) handles.add(r);
  if (handles.size === 0) handles.add("@all");
  if (![...handles].includes("@all")) handles.add("@all");
  return [...handles];
}

function normalizeHandle(handle: string): string {
  return handle.startsWith("@") ? handle.slice(1) : handle;
}

function messageFromDirect(value: unknown): InboxMessage[] {
  if (!value || typeof value !== "object") return [];
  const m = value as Partial<InboxMessage>;
  if (typeof m.cid !== "string" || typeof m.body !== "string" || typeof m.createdAt !== "string")
    return [];
  if (!m.from || typeof m.from.agentId !== "string" || !Array.isArray(m.recipients)) return [];
  return [
    {
      cid: m.cid,
      from: m.from,
      body: m.body,
      recipients: m.recipients,
      createdAt: m.createdAt,
      tags: ["message"],
    },
  ];
}

function messageFromEnvelope(data: Uint8Array): InboxMessage[] {
  try {
    const envelope = JSON.parse(new TextDecoder().decode(data)) as { payload?: unknown };
    const payload = envelope.payload as Partial<GroveMessagePayload> | undefined;
    if (payload?.kind !== "grove.message") return [];
    if (
      typeof payload.cid !== "string" ||
      typeof payload.body !== "string" ||
      typeof payload.createdAt !== "string" ||
      !Array.isArray(payload.recipients) ||
      payload.from === undefined ||
      typeof payload.from.agentId !== "string"
    ) {
      return [];
    }
    return [
      {
        cid: payload.cid,
        from: payload.from,
        body: payload.body,
        recipients: payload.recipients,
        createdAt: payload.createdAt,
        tags: ["message"],
      },
    ];
  } catch {
    return [];
  }
}

function dedupe(messages: readonly InboxMessage[]): readonly InboxMessage[] {
  const seen = new Set<string>();
  const result: InboxMessage[] = [];
  for (const m of messages) {
    if (seen.has(m.cid)) continue;
    seen.add(m.cid);
    result.push(m);
  }
  return result;
}

function filterSortLimit(
  messages: readonly InboxMessage[],
  query?: InboxQuery,
): readonly InboxMessage[] {
  let result = [...messages];
  const requestedRecipients = queryRecipients(query);
  if (requestedRecipients !== undefined) {
    result = result.filter(
      (m) => m.recipients.includes("@all") || m.recipients.some((r) => requestedRecipients.has(r)),
    );
  }
  if (query?.fromAgentId !== undefined)
    result = result.filter((m) => m.from.agentId === query.fromAgentId);
  if (query?.since !== undefined) {
    const sinceMs = Date.parse(query.since);
    result = result.filter((m) => Date.parse(m.createdAt) >= sinceMs);
  }
  result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return result.slice(0, query?.limit ?? 50);
}

function queryRecipients(query?: InboxQuery): ReadonlySet<string> | undefined {
  const recipients = new Set<string>();
  if (query?.recipient !== undefined) recipients.add(query.recipient);
  for (const r of query?.recipients ?? []) recipients.add(r);
  return recipients.size === 0 ? undefined : recipients;
}
