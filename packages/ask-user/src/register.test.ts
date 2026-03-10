/**
 * Tests for registerAskUserTools — the reusable tool registration function.
 *
 * Uses InMemoryTransport + Client for clean MCP round-trip testing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AskUserConfig } from "./config.js";
import { registerAskUserTools } from "./register.js";

/** Rules-only config for deterministic testing. */
const rulesConfig: AskUserConfig = {
  strategy: "rules",
  fallback: "rules",
  llm: {
    model: "claude-haiku-4-5-20251001",
    systemPrompt: "test",
    timeoutMs: 30_000,
    maxTokens: 256,
  },
  rules: {
    prefer: "first",
    defaultResponse: "default answer",
  },
  agent: {
    command: "acpx",
    args: [],
    timeoutMs: 5000,
  },
};

describe("registerAskUserTools", () => {
  let server: McpServer;
  let client: Client;
  let closeAll: () => Promise<void>;

  beforeEach(async () => {
    server = new McpServer({ name: "test-server", version: "0.1.0" });
    await registerAskUserTools(server, rulesConfig);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    closeAll = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await closeAll();
  });

  test("registers ask_user tool", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain("ask_user");
  });

  test("ask_user tool has correct schema", async () => {
    const tools = await client.listTools();
    const askUser = tools.tools.find((t) => t.name === "ask_user");
    expect(askUser).toBeDefined();
    expect(askUser?.inputSchema.properties).toHaveProperty("question");
    expect(askUser?.inputSchema.properties).toHaveProperty("options");
    expect(askUser?.inputSchema.properties).toHaveProperty("context");
  });

  test("returns answer for question with options", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "Which one?",
        options: ["Alpha", "Beta"],
      },
    });

    // Rules strategy with prefer=first picks first option
    expect(result.content).toEqual([{ type: "text", text: "Alpha" }]);
  });

  test("returns default response for question without options", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "What should I do?",
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "default answer" }]);
  });

  test("works with context parameter", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "Pick one",
        options: ["A", "B"],
        context: "We need performance",
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "A" }]);
  });
});
