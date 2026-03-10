/**
 * Reusable tool registration for ask_user.
 *
 * Registers the `ask_user` MCP tool on any McpServer instance.
 * Used by both the standalone grove-ask-user binary and the built-in
 * grove-mcp integration.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AskUserConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { buildStrategyFromConfig } from "./strategy.js";

/**
 * Register the `ask_user` tool on an existing McpServer.
 *
 * @param server - McpServer instance to register the tool on.
 * @param config - Optional config; if omitted, resolved via GROVE_ASK_USER_CONFIG env var or defaults.
 */
export async function registerAskUserTools(
  server: McpServer,
  config?: AskUserConfig,
): Promise<void> {
  const resolved = config ?? loadConfig();
  const strategy = await buildStrategyFromConfig(resolved);

  console.error(`[ask-user] Initialized with strategy: ${strategy.name}`);

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
}
