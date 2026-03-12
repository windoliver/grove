/**
 * LLM-based answering strategy.
 *
 * Routes questions to a cheap model (default: Haiku 4.5) via the Anthropic SDK.
 * Supports dependency injection for testing.
 */

import type { LlmConfigType } from "../config.js";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/**
 * Minimal interface for the Anthropic messages API.
 * Allows dependency injection without importing the full SDK in tests.
 */
export interface AnthropicMessagesClient {
  create(params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

/**
 * Format the question and options into a clear prompt for the LLM.
 */
function formatPrompt(input: AskUserInput): string {
  const parts: string[] = [`Question: ${input.question}`];

  if (input.options && input.options.length > 0) {
    parts.push("");
    parts.push("Options:");
    for (let i = 0; i < input.options.length; i++) {
      parts.push(`${i + 1}. ${input.options[i]}`);
    }
  }

  if (input.context) {
    parts.push("");
    parts.push(`Context: ${input.context}`);
  }

  return parts.join("\n");
}

/**
 * Create an LLM answering strategy.
 *
 * @param config - LLM configuration (model, system prompt, timeout, max tokens).
 * @param client - Optional Anthropic messages client for testing. If not provided,
 *                 lazily loads the Anthropic SDK and uses ANTHROPIC_API_KEY from env.
 */
export function createLlmStrategy(
  config: LlmConfigType,
  client?: AnthropicMessagesClient,
): AnswerStrategy {
  let resolvedClient: AnthropicMessagesClient | undefined = client;

  return {
    name: "llm",

    async answer(input: AskUserInput): Promise<string> {
      if (!resolvedClient) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const sdk = new Anthropic({ timeout: config.timeoutMs });
        resolvedClient = sdk.messages;
      }

      const activeClient = resolvedClient;
      const response = await activeClient.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system: config.systemPrompt,
        messages: [{ role: "user", content: formatPrompt(input) }],
      });

      const textBlock = response.content.find((b) => b.type === "text" && b.text);
      if (!textBlock || !textBlock.text) {
        throw new Error("LLM returned no text content");
      }

      return textBlock.text.trim();
    },
  };
}
