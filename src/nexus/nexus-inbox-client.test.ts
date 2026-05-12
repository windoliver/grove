import { describe, expect, test } from "bun:test";
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
    createdAt: "2026-05-12T12:00:00.000Z",
    from: { agentId: "alice", agentName: "Alice" },
  };

  await delivery.deliverMessage({
    cid: expectedPayload.cid,
    body: expectedPayload.body,
    recipients: expectedPayload.recipients,
    createdAt: expectedPayload.createdAt,
    from: expectedPayload.from,
  });

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
