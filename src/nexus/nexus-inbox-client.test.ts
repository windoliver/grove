import { describe, expect, test } from "bun:test";
import { MockNexusClient } from "./mock-client.js";
import { NexusInboxClient } from "./nexus-inbox-client.js";

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
      "/ipc/bob/inbox/msg-bob.json",
      encodeEnvelope({
        message_id: "same",
        sender: "alice",
        recipient: "bob",
        timestamp: payload.createdAt,
        payload,
      }),
    );
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
      fetch: async () => new Response("", { status: 404 }),
    });

    const messages = await client.readInbox({ recipients: ["@bob", "@all"] });

    expect(messages.map((m) => m.cid)).toEqual([cid]);
  });
});
