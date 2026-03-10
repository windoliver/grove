#!/usr/bin/env bun
/**
 * MCP server entry point for @grove/ask-user (standalone mode).
 *
 * Exposes an `ask_user` tool that agents call when they need clarification.
 * In headless mode, routes questions to the configured answering strategy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAskUserTools } from "./register.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "grove-ask-user",
    version: "0.1.0",
  });

  await registerAskUserTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[ask-user] MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("[ask-user] Fatal error:", err);
  process.exit(1);
});
