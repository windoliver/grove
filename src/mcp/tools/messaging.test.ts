import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DeliveredInboxMessage } from "../../core/operations/inbox-delegation.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerMessagingTools } from "./messaging.js";

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly isError: boolean | undefined; readonly text: string }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (tool === undefined) throw new Error(`Tool ${name} not registered`);
  const result = (await tool.handler(args)) as {
    readonly isError?: boolean;
    readonly content: readonly { readonly type: string; readonly text: string }[];
  };
  return {
    isError: result.isError,
    text: result.content[0]?.text ?? "",
  };
}

describe("messaging tools", () => {
  let testDeps: TestMcpDeps;
  let server: McpServer;

  beforeEach(async () => {
    testDeps = await createTestMcpDeps();
    server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
  });

  afterEach(async () => {
    await testDeps.cleanup();
  });

  test("grove_read_inbox uses injected inbox source for recipient queries", async () => {
    registerMessagingTools(server, {
      ...testDeps.deps,
      contributionStore: {
        ...testDeps.deps.contributionStore,
        list: async () => {
          throw new Error("store.list should not run");
        },
      },
      inboxReadSource: {
        readInbox: async () => [
          {
            cid: "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            from: { agentId: "alice" },
            body: "from injected source",
            recipients: ["@bob"],
            createdAt: "2026-05-12T12:00:00.000Z",
            tags: ["message"],
          },
        ],
      },
    });

    const result = await callTool(server, "grove_read_inbox", { recipient: "@bob" });
    const data = JSON.parse(result.text) as {
      readonly messages: readonly { readonly body: string }[];
    };

    expect(result.isError).toBeUndefined();
    expect(data.messages[0]?.body).toBe("from injected source");
  });

  test("grove_send_message delivers payload through injected messageDelivery", async () => {
    const delivered: DeliveredInboxMessage[] = [];
    registerMessagingTools(server, {
      ...testDeps.deps,
      messageDelivery: {
        deliverMessage: async (message) => {
          delivered.push(message);
        },
      },
    });

    const result = await callTool(server, "grove_send_message", {
      body: "hello bob",
      recipients: ["@bob"],
      agent: { agentId: "alice", agentName: "Alice" },
    });

    expect(result.isError).toBeUndefined();
    expect(delivered).toEqual([
      {
        cid: JSON.parse(result.text).cid,
        body: "hello bob",
        recipients: ["@bob"],
        createdAt: JSON.parse(result.text).createdAt,
        from: { agentId: "alice", agentName: "Alice" },
      },
    ]);
  });
});
