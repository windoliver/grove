#!/usr/bin/env node
/**
 * MCP server entry point for @grove/ask-user.
 *
 * Exposes an `ask_user` tool that agents call when they need clarification.
 * In headless mode, routes questions to the configured answering strategy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { loadConfig } from "./config.js";
import { buildStrategyFromConfig } from "./strategy.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const strategy = await buildStrategyFromConfig(config);

  console.error(`[ask-user] Initialized with strategy: ${strategy.name}`);

  const server = new McpServer({
    name: "grove-ask-user",
    version: "0.1.0",
  });

  server.tool(
    "ask_user",
    "Ask a question when you need clarification. In headless mode, routed to an AI answerer.",
    {
      question: z.string().describe("The question to ask"),
      options: z.array(z.string()).optional().describe("Available choices (optional)"),
      context: z.string().optional().describe("Additional context for the answerer (optional)"),
    },
    async ({ question, options, context }) => {
      console.error(`[ask-user] Question: ${question}`);
      if (options && options.length > 0) {
        console.error(`[ask-user] Options: ${options.join(", ")}`);
      }

      const answer = await strategy.answer({
        question,
        options,
        context,
      });

      console.error(`[ask-user] Answer (via ${strategy.name}): ${answer}`);

      return {
        content: [{ type: "text" as const, text: answer }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[ask-user] MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("[ask-user] Fatal error:", err);
  process.exit(1);
});
