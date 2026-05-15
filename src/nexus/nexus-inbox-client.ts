import type {
  DeliveredInboxMessage,
  InboxReadSource,
  MessageDelivery,
} from "../core/operations/inbox-delegation.js";
import type { InboxMessage, InboxQuery } from "../core/operations/messaging.js";
import type { NexusClient } from "./client.js";
import { NexusNotFoundError } from "./errors.js";
import { normalizeIpcRoleHandle } from "./ipc-roles.js";
import type { NexusIpcClient } from "./nexus-ipc-client.js";
import { encodeSegment } from "./vfs-paths.js";

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export interface NexusInboxClientOptions {
  readonly nexusUrl: string;
  readonly apiKey?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly client?: NexusClient | undefined;
  readonly fetch?: FetchFn | undefined;
}

export interface NexusMessageDeliveryOptions {
  readonly ipcClient: Pick<NexusIpcClient, "send">;
}

interface GroveMessagePayload {
  readonly kind: "grove.message";
  readonly cid: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly inReplyTo?: string | undefined;
  readonly createdAt: string;
  readonly from: { readonly agentId: string; readonly agentName?: string | undefined };
  readonly tags?: readonly string[] | undefined;
}

export class NexusInboxReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NexusInboxReadUnavailableError";
  }
}

export class NexusMessageDelivery implements MessageDelivery {
  private readonly ipcClient: Pick<NexusIpcClient, "send">;

  constructor(opts: NexusMessageDeliveryOptions) {
    this.ipcClient = opts.ipcClient;
  }

  async deliverMessage(message: DeliveredInboxMessage): Promise<void> {
    const sender = message.from.agentId;
    const failures = (
      await Promise.all(
        message.recipients.map(async (recipient) => {
          const role = normalizeIpcRoleHandle(recipient);
          try {
            const result = await this.ipcClient.send(sender, role, {
              kind: "grove.message",
              cid: message.cid,
              body: message.body,
              recipients: [...message.recipients],
              ...(message.inReplyTo !== undefined ? { inReplyTo: message.inReplyTo } : {}),
              createdAt: message.createdAt,
              from: message.from,
              tags: [...(message.tags ?? ["message"])],
            });
            if (result.ok) return undefined;
            return `${role}: ${result.error ?? "IPC send failed"}`;
          } catch (err) {
            const failureMessage = err instanceof Error ? err.message : String(err);
            return `${role}: ${failureMessage}`;
          }
        }),
      )
    ).filter((failure): failure is string => failure !== undefined);

    if (failures.length > 0) {
      const noun = failures.length === 1 ? "recipient" : "recipients";
      throw new Error(
        `Nexus IPC delivery failed for ${failures.length} ${noun}: ${failures.join("; ")}`,
      );
    }
  }
}

export class NexusInboxClient implements InboxReadSource {
  private readonly nexusUrl: string;
  private readonly apiKey: string | undefined;
  private readonly sessionId: string | undefined;
  private readonly zoneId: string | undefined;
  private readonly client: NexusClient | undefined;
  private readonly fetchFn: FetchFn;
  private directEndpointAvailable: boolean | undefined;

  constructor(opts: NexusInboxClientOptions) {
    this.nexusUrl = opts.nexusUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.sessionId = opts.sessionId;
    this.zoneId = opts.zoneId;
    this.client = opts.client;
    this.fetchFn = opts.fetch ?? fetch;
  }

  async readInbox(query?: InboxQuery): Promise<readonly InboxMessage[]> {
    const recipients = recipientHandles(query);
    const messages: InboxMessage[] = [];
    let sawSuccessfulRead = false;

    for (const handle of recipients) {
      const role = normalizeIpcRoleHandle(handle);
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
    // Scoped reads must use VFS paths. The optional direct IPC endpoint has no
    // session/zone-scope contract here.
    if (this.sessionId !== undefined || this.zoneId !== undefined) return undefined;
    if (this.directEndpointAvailable === false) return undefined;
    try {
      const params = new URLSearchParams();
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.fromAgentId !== undefined) params.set("from_agent_id", query.fromAgentId);
      if (query?.since !== undefined) params.set("since", query.since);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const init = requestInit(this.apiKey);
      const resp = await this.fetchFn(
        `${this.nexusUrl}/api/v2/ipc/inbox/${encodeURIComponent(role)}${suffix}`,
        init,
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
    const dir = inboxDirPath(role, this.sessionId, this.zoneId);
    const files = await this.listInboxFiles(dir);
    if (files === undefined) return undefined;

    const decoded = await Promise.all(
      files.map(async (entry) => this.readEnvelopeFile(entry.path)),
    );
    return decoded.flatMap((data) => (data === undefined ? [] : messageFromEnvelope(data)));
  }

  private async listInboxFiles(
    dir: string,
  ): Promise<readonly { readonly path: string }[] | undefined> {
    const client = this.client;
    if (client === undefined) return undefined;
    const files: { readonly path: string }[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    try {
      while (hasMore) {
        const listed = await client.list(dir, {
          limit: 100,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        files.push(
          ...listed.files
            .filter((entry) => !entry.isDirectory && entry.path.endsWith(".json"))
            .map((entry) => ({ path: entry.path })),
        );
        cursor = listed.nextCursor;
        hasMore = listed.hasMore && cursor !== undefined;
      }
      return files;
    } catch (err) {
      if (err instanceof NexusNotFoundError) return undefined;
      throw err;
    }
  }

  private async readEnvelopeFile(path: string): Promise<Uint8Array | undefined> {
    const raw = await this.readRawRestFile(path);
    if (raw !== undefined) return raw;
    return this.client?.read(path);
  }

  private async readRawRestFile(path: string): Promise<Uint8Array | undefined> {
    try {
      const url = `${this.nexusUrl}/api/v2/files/read?path=${encodeURIComponent(path)}`;
      const resp = await this.fetchFn(url, requestInit(this.apiKey));
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as { readonly content?: unknown };
      if (typeof body.content !== "string") return undefined;
      return new TextEncoder().encode(body.content);
    } catch {
      return undefined;
    }
  }
}

function inboxDirPath(
  role: string,
  sessionId?: string | undefined,
  zoneId?: string | undefined,
): string {
  const zonePrefix = zoneId ? `/zones/${encodeSegment(zoneId)}` : "";
  const sessionPrefix = sessionId ? `/sessions/${encodeSegment(sessionId)}` : "";
  return `${zonePrefix}${sessionPrefix}/ipc/${encodeSegment(role)}/inbox`;
}

function requestInit(apiKey: string | undefined): RequestInit {
  const init: RequestInit = {};
  if (apiKey) init.headers = { Authorization: `Bearer ${apiKey}` };
  return init;
}

function recipientHandles(query?: InboxQuery): readonly string[] {
  const handles = new Set<string>();
  if (query?.recipient !== undefined) handles.add(query.recipient);
  for (const r of query?.recipients ?? []) handles.add(r);
  if (handles.size === 0) handles.add("@all");
  if (![...handles].includes("@all")) handles.add("@all");
  return [...handles];
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
      ...(typeof m.inReplyTo === "string" ? { inReplyTo: m.inReplyTo } : {}),
      createdAt: m.createdAt,
      tags: messageTags(m.tags),
    },
  ];
}

function messageFromEnvelope(data: Uint8Array): InboxMessage[] {
  const decoded = decodeEnvelopeText(new TextDecoder().decode(data));
  if (decoded === undefined) return [];
  return messageFromEnvelopeObject(decoded);
}

function decodeEnvelopeText(text: string): { readonly payload?: unknown } | undefined {
  try {
    return JSON.parse(text) as { readonly payload?: unknown };
  } catch {
    try {
      return JSON.parse(Buffer.from(text, "base64").toString("utf8")) as {
        readonly payload?: unknown;
      };
    } catch {
      return undefined;
    }
  }
}

function messageFromEnvelopeObject(envelope: { readonly payload?: unknown }): InboxMessage[] {
  try {
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
        ...(typeof payload.inReplyTo === "string" ? { inReplyTo: payload.inReplyTo } : {}),
        createdAt: payload.createdAt,
        tags: messageTags(payload.tags),
      },
    ];
  } catch {
    return [];
  }
}

function messageTags(tags: unknown): readonly string[] {
  if (!Array.isArray(tags)) return ["message"];
  const filtered = tags.filter((tag): tag is string => typeof tag === "string");
  return filtered.length > 0 ? filtered : ["message"];
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
