/**
 * E2E test: spawn the MCP server as a subprocess, connect via SDK client,
 * call the ask_user tool, and verify the round-trip.
 *
 * Uses the "rules" strategy to avoid real API calls.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const testDir = join(tmpdir(), `ask-user-e2e-${Date.now()}`);
const configPath = join(testDir, "config.json");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });

  // Write config that uses rules strategy (no external dependencies)
  writeFileSync(
    configPath,
    JSON.stringify({
      strategy: "rules",
      rules: {
        prefer: "first",
        defaultResponse: "Just do it.",
      },
    }),
  );

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(__dirname, "server.ts")],
    env: {
      ...process.env,
      GROVE_ASK_USER_CONFIG: configPath,
    },
  });

  client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("E2E: MCP ask_user tool", () => {
  test("lists ask_user tool", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("ask_user");
  });

  test("answers question with options using rules strategy", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "Which database?",
        options: ["Postgres", "MySQL", "SQLite"],
      },
    });

    // Rules strategy with prefer=first should pick first option
    expect(result.content).toEqual([{ type: "text", text: "Postgres" }]);
  });

  test("returns default response for question without options", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "Should I add error handling?",
      },
    });

    // Rules strategy returns default response (does NOT auto-approve)
    expect(result.content).toEqual([{ type: "text", text: "Just do it." }]);
  });

  test("answers open-ended question with default response", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "What architecture pattern would you recommend?",
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "Just do it." }]);
  });

  test("handles context parameter", async () => {
    const result = await client.callTool({
      name: "ask_user",
      arguments: {
        question: "Which approach?",
        options: ["A", "B"],
        context: "We need high performance",
      },
    });

    // Should still work (context doesn't affect rules strategy)
    expect(result.content).toEqual([{ type: "text", text: "A" }]);
  });
});
