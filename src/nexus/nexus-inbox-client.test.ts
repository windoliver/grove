import { describe, expect, test } from "bun:test";
import type {
  FileMeta,
  ListEntry,
  ListResult,
  MkdirOptions,
  NexusClient,
  SearchOptions,
  SearchResult,
  WriteOptions,
  WriteResult,
} from "./client.js";
import { NexusNotFoundError } from "./errors.js";
import { MockNexusClient } from "./mock-client.js";
import { NexusInboxClient, NexusMessageDelivery } from "./nexus-inbox-client.js";

const encoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function encodeEnvelope(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function stubClient(overrides: Partial<NexusClient>): NexusClient {
  return {
    read: async () => undefined,
    readWithMeta: async () => undefined,
    write: async (
      _path: string,
      content: Uint8Array,
      _opts?: WriteOptions,
    ): Promise<WriteResult> => ({
      bytesWritten: content.byteLength,
      etag: "etag",
    }),
    exists: async () => false,
    stat: async (): Promise<FileMeta | undefined> => undefined,
    delete: async () => false,
    list: async (): Promise<ListResult> => ({ files: [], hasMore: false }),
    mkdir: async (_path: string, _opts?: MkdirOptions) => undefined,
    search: async (_query: string, _opts?: SearchOptions): Promise<readonly SearchResult[]> => [],
    close: async () => undefined,
    ...overrides,
  };
}

describe("NexusInboxClient", () => {
  test("parses direct IPC inbox endpoint messages", async () => {
    const fetchCalls: string[] = [];
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      fetch: async (input) => {
        fetchCalls.push(String(input));
        return jsonResponse({
          messages: [
            {
              cid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              from: { agentId: "alice" },
              body: "direct",
              recipients: ["@bob"],
              createdAt: "2026-05-12T12:00:00.000Z",
            },
          ],
          total: 1,
        });
      },
    });

    const messages = await client.readInbox({ recipient: "@bob", limit: 10 });

    expect(fetchCalls[0]).toBe("http://nexus.test/api/v2/ipc/inbox/bob?limit=10");
    expect(messages.map((m) => m.body)).toEqual(["direct"]);
  });

  test("passes sender and timestamp filters to the direct IPC inbox endpoint", async () => {
    const fetchCalls: string[] = [];
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      fetch: async (input) => {
        fetchCalls.push(String(input));
        return jsonResponse({
          messages: [
            {
              cid: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              from: { agentId: "alice" },
              body: "direct",
              recipients: ["@bob"],
              createdAt: "2026-05-12T12:00:00.000Z",
            },
          ],
        });
      },
    });

    await client.readInbox({
      recipient: "@bob",
      fromAgentId: "alice",
      since: "2026-05-12T00:00:00.000Z",
      limit: 10,
    });

    expect(fetchCalls[0]).toBe(
      "http://nexus.test/api/v2/ipc/inbox/bob?limit=10&from_agent_id=alice&since=2026-05-12T00%3A00%3A00.000Z",
    );
  });

  test("falls back to session-scoped inbox files when endpoint is unavailable", async () => {
    const vfs = new MockNexusClient();
    await vfs.write(
      "/sessions/sess-1/ipc/bob/inbox/msg-1.json",
      encodeEnvelope({
        message_id: "msg-1",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T12:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          body: "from file",
          recipients: ["@bob"],
          createdAt: "2026-05-12T12:00:00.000Z",
          from: { agentId: "alice" },
        },
      }),
    );
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      sessionId: "sess-1",
      client: vfs,
      fetch: async () => new Response("", { status: 404 }),
    });

    const messages = await client.readInbox({ recipient: "@bob" });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("from file");
  });

  test("reads session inbox file content through raw REST read before NexusClient decoding", async () => {
    const envelope = {
      message_id: "msg-1",
      sender: "alice",
      recipient: "bob",
      timestamp: "2026-05-12T12:00:00.000Z",
      payload: {
        kind: "grove.message",
        cid: "blake3:1212121212121212121212121212121212121212121212121212121212121212",
        body: "raw rest file",
        recipients: ["@bob"],
        createdAt: "2026-05-12T12:00:00.000Z",
        from: { agentId: "alice" },
      },
    };
    const rawEnvelope = JSON.stringify(envelope);
    const file: ListEntry = {
      name: "msg-1.json",
      path: "/sessions/sess-1/ipc/bob/inbox/msg-1.json",
      isDirectory: false,
    };
    const client = stubClient({
      list: async () => ({ files: [file], hasMore: false }),
      read: async () => new Uint8Array(Buffer.from(rawEnvelope, "base64")),
    });
    const inbox = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      sessionId: "sess-1",
      client,
      fetch: async (input) => {
        const url = String(input);
        if (url.startsWith("http://nexus.test/api/v2/files/read?")) {
          return jsonResponse({ content: rawEnvelope });
        }
        return new Response("", { status: 404 });
      },
    });

    const messages = await inbox.readInbox({ recipient: "@bob" });

    expect(messages.map((m) => m.body)).toEqual(["raw rest file"]);
  });

  test("throws unavailable when no Nexus inbox path can be listed", async () => {
    const client = stubClient({
      list: async () => {
        throw new NexusNotFoundError("/ipc/bob/inbox");
      },
    });
    const inbox = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client,
      fetch: async () => new Response("", { status: 404 }),
    });

    await expect(inbox.readInbox({ recipient: "@bob" })).rejects.toThrow(
      "Nexus inbox read unavailable",
    );
  });

  test("rejects unsafe recipient handles before listing Nexus paths", async () => {
    const listedPaths: string[] = [];
    const client = stubClient({
      list: async (path) => {
        listedPaths.push(path);
        return { files: [], hasMore: false };
      },
    });
    const inbox = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client,
      fetch: async () => new Response("", { status: 404 }),
    });

    await expect(inbox.readInbox({ recipient: "@../secrets" })).rejects.toThrow(
      "Invalid Nexus IPC role handle",
    );
    expect(listedPaths).toEqual([]);
  });

  test("session-scoped inbox reads skip direct endpoint and use session VFS path", async () => {
    const vfs = new MockNexusClient();
    const listedPaths: string[] = [];
    const originalList = vfs.list.bind(vfs);
    vfs.list = async (path, opts) => {
      listedPaths.push(path);
      return originalList(path, opts);
    };
    await vfs.write(
      "/sessions/sess-2/ipc/bob/inbox/msg-1.json",
      encodeEnvelope({
        message_id: "msg-1",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T12:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:abababababababababababababababababababababababababababababababab",
          body: "session scoped",
          recipients: ["@bob"],
          createdAt: "2026-05-12T12:00:00.000Z",
          from: { agentId: "alice" },
        },
      }),
    );
    const fetchCalls: string[] = [];
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      sessionId: "sess-2",
      client: vfs,
      fetch: async (input) => {
        fetchCalls.push(String(input));
        throw new Error("session reads must not use direct endpoint");
      },
    });

    const messages = await client.readInbox({ recipient: "@bob" });

    expect(fetchCalls.filter((url) => url.includes("/api/v2/ipc/inbox/"))).toEqual([]);
    expect(listedPaths).toContain("/sessions/sess-2/ipc/bob/inbox");
    expect(messages.map((m) => m.body)).toEqual(["session scoped"]);
  });

  test("paginates inbox file listings before applying sender filters", async () => {
    const vfs = new MockNexusClient();
    for (let i = 0; i <= 100; i++) {
      const id = String(i).padStart(3, "0");
      const fromAgentId = i === 100 ? "target" : "other";
      await vfs.write(
        `/ipc/bob/inbox/msg-${id}.json`,
        encodeEnvelope({
          message_id: `msg-${id}`,
          sender: fromAgentId,
          recipient: "bob",
          timestamp: `2026-05-12T12:${id.slice(1)}:00.000Z`,
          payload: {
            kind: "grove.message",
            cid: `blake3:${id}${"0".repeat(61)}`,
            body: `message ${id}`,
            recipients: ["@bob"],
            createdAt: `2026-05-12T12:${id.slice(1)}:00.000Z`,
            from: { agentId: fromAgentId },
          },
        }),
      );
    }
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client: vfs,
      fetch: async () => new Response("", { status: 404 }),
    });

    const messages = await client.readInbox({ recipient: "@bob", fromAgentId: "target" });

    expect(messages.map((m) => m.body)).toEqual(["message 100"]);
  });

  test("falls back to inbox files when direct endpoint fetch throws", async () => {
    const vfs = new MockNexusClient();
    await vfs.write(
      "/ipc/bob/inbox/msg-1.json",
      encodeEnvelope({
        message_id: "msg-1",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T12:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          body: "after fetch failure",
          recipients: ["@bob"],
          createdAt: "2026-05-12T12:00:00.000Z",
          from: { agentId: "alice" },
        },
      }),
    );
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client: vfs,
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });

    const messages = await client.readInbox({ recipient: "@bob" });

    expect(messages.map((m) => m.body)).toEqual(["after fetch failure"]);
  });

  test("file-backed messages preserve reply metadata and tags", async () => {
    const vfs = new MockNexusClient();
    const inReplyTo = "blake3:9999999999999999999999999999999999999999999999999999999999999999";
    await vfs.write(
      "/ipc/bob/inbox/msg-1.json",
      encodeEnvelope({
        message_id: "msg-1",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T12:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          body: "threaded",
          recipients: ["@bob"],
          inReplyTo,
          createdAt: "2026-05-12T12:00:00.000Z",
          from: { agentId: "alice" },
          tags: ["handoff", "message"],
        },
      }),
    );
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client: vfs,
      fetch: async () => new Response("", { status: 404 }),
    });

    const messages = await client.readInbox({ recipient: "@bob" });

    expect(messages[0]?.inReplyTo).toBe(inReplyTo);
    expect(messages[0]?.tags).toEqual(["handoff", "message"]);
  });

  test("filters misfiled inbox payloads while keeping broadcast messages", async () => {
    const vfs = new MockNexusClient();
    await vfs.write(
      "/ipc/bob/inbox/msg-charlie.json",
      encodeEnvelope({
        message_id: "msg-charlie",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T12:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          body: "misfiled",
          recipients: ["@charlie"],
          createdAt: "2026-05-12T12:00:00.000Z",
          from: { agentId: "alice" },
        },
      }),
    );
    await vfs.write(
      "/ipc/bob/inbox/msg-all.json",
      encodeEnvelope({
        message_id: "msg-all",
        sender: "alice",
        recipient: "bob",
        timestamp: "2026-05-12T13:00:00.000Z",
        payload: {
          kind: "grove.message",
          cid: "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          body: "broadcast",
          recipients: ["@all"],
          createdAt: "2026-05-12T13:00:00.000Z",
          from: { agentId: "alice" },
        },
      }),
    );
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client: vfs,
      fetch: async () => new Response("", { status: 404 }),
    });

    const messages = await client.readInbox({ recipient: "@bob" });

    expect(messages.map((m) => m.body)).toEqual(["broadcast"]);
  });

  test("dedupes direct and broadcast messages newest first", async () => {
    const vfs = new MockNexusClient();
    const cid = "blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const payload = {
      kind: "grove.message",
      cid,
      body: "broadcast",
      recipients: ["@all"],
      createdAt: "2026-05-12T13:00:00.000Z",
      from: { agentId: "alice" },
    };
    await vfs.write(
      "/ipc/all/inbox/msg-all.json",
      encodeEnvelope({
        message_id: "same",
        sender: "alice",
        recipient: "all",
        timestamp: payload.createdAt,
        payload,
      }),
    );
    const client = new NexusInboxClient({
      nexusUrl: "http://nexus.test",
      apiKey: "secret",
      client: vfs,
      fetch: async (input) => {
        if (String(input) === "http://nexus.test/api/v2/ipc/inbox/bob") {
          return jsonResponse({
            messages: [
              {
                cid,
                from: { agentId: "alice" },
                body: "direct",
                recipients: ["@bob"],
                createdAt: "2026-05-12T13:00:00.000Z",
              },
            ],
            total: 1,
          });
        }
        return new Response("", { status: 404 });
      },
    });

    const messages = await client.readInbox({ recipients: ["@bob", "@all"] });

    expect(messages.map((m) => m.cid)).toEqual([cid]);
    expect(messages.map((m) => m.body)).toEqual(["direct"]);
  });
});

test("NexusMessageDelivery sends Grove-marked payloads to each recipient inbox", async () => {
  const calls: { sender: string; recipient: string; payload: Record<string, unknown> }[] = [];
  const delivery = new NexusMessageDelivery({
    ipcClient: {
      send: async (sender: string, recipient: string, payload: Record<string, unknown>) => {
        calls.push({ sender, recipient, payload });
        return { ok: true, messageId: `msg-${recipient}` };
      },
    },
  });

  const expectedPayload = {
    kind: "grove.message",
    cid: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    body: "hello",
    recipients: ["@bob", "@all"],
    inReplyTo: "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    createdAt: "2026-05-12T12:00:00.000Z",
    from: { agentId: "alice", agentName: "Alice" },
    tags: ["handoff", "message"],
  };
  const message = {
    cid: expectedPayload.cid,
    body: expectedPayload.body,
    recipients: expectedPayload.recipients,
    inReplyTo: expectedPayload.inReplyTo,
    createdAt: expectedPayload.createdAt,
    from: expectedPayload.from,
    tags: expectedPayload.tags,
  };

  await delivery.deliverMessage(message);

  expect(calls).toHaveLength(2);
  expect(calls.map((c) => c.recipient)).toEqual(["bob", "all"]);
  expect(calls[0]?.sender).toBe("alice");
  expect(calls[0]?.payload).toEqual(expectedPayload);
  expect(calls[1]?.payload).toEqual(expectedPayload);
});

test("NexusMessageDelivery rejects failed send results after attempting all recipients", async () => {
  const calls: string[] = [];
  const delivery = new NexusMessageDelivery({
    ipcClient: {
      send: async (_sender: string, recipient: string, _payload: Record<string, unknown>) => {
        calls.push(recipient);
        if (recipient === "all") {
          return { ok: false, error: "IPC failed" };
        }
        return { ok: true, messageId: `msg-${recipient}` };
      },
    },
  });

  await expect(
    delivery.deliverMessage({
      cid: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      body: "hello",
      recipients: ["@bob", "@all"],
      createdAt: "2026-05-12T12:00:00.000Z",
      from: { agentId: "alice", agentName: "Alice" },
    }),
  ).rejects.toThrow("Nexus IPC delivery failed for 1 recipient: all: IPC failed");
  expect(calls).toEqual(["bob", "all"]);
});

test("NexusMessageDelivery rejects unsafe recipients before sending", async () => {
  const calls: string[] = [];
  const delivery = new NexusMessageDelivery({
    ipcClient: {
      send: async (_sender: string, recipient: string, _payload: Record<string, unknown>) => {
        calls.push(recipient);
        return { ok: true, messageId: `msg-${recipient}` };
      },
    },
  });

  await expect(
    delivery.deliverMessage({
      cid: "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      body: "hello",
      recipients: ["@../secrets"],
      createdAt: "2026-05-12T12:00:00.000Z",
      from: { agentId: "alice", agentName: "Alice" },
    }),
  ).rejects.toThrow("Invalid Nexus IPC role handle");
  expect(calls).toEqual([]);
});
