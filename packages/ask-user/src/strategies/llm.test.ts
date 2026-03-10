import { describe, expect, test } from "bun:test";
import type { AnthropicMessagesClient } from "./llm.js";
import { createLlmStrategy } from "./llm.js";

const DEFAULT_LLM_CONFIG = {
  model: "claude-haiku-4-5-20251001",
  systemPrompt: "Be decisive.",
  timeoutMs: 30_000,
  maxTokens: 256,
};

function mockClient(response: string): AnthropicMessagesClient {
  return {
    async create() {
      return {
        content: [{ type: "text", text: response }],
      };
    },
  };
}

function failingClient(error: Error): AnthropicMessagesClient {
  return {
    async create() {
      throw error;
    },
  };
}

describe("createLlmStrategy", () => {
  test("returns answer from mock client", async () => {
    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, mockClient("Use option A"));
    const answer = await strategy.answer({ question: "Which option?" });
    expect(answer).toBe("Use option A");
  });

  test("trims whitespace from response", async () => {
    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, mockClient("  Use option B  \n"));
    const answer = await strategy.answer({ question: "Which?" });
    expect(answer).toBe("Use option B");
  });

  test("passes options and context in prompt", async () => {
    let capturedContent = "";
    const capturingClient: AnthropicMessagesClient = {
      async create(params) {
        // biome-ignore lint/style/noNonNullAssertion: test always has one message
        capturedContent = params.messages[0]!.content;
        return { content: [{ type: "text", text: "A" }] };
      },
    };

    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, capturingClient);
    await strategy.answer({
      question: "Which DB?",
      options: ["Postgres", "MySQL"],
      context: "We need JSONB support",
    });

    expect(capturedContent).toContain("Question: Which DB?");
    expect(capturedContent).toContain("1. Postgres");
    expect(capturedContent).toContain("2. MySQL");
    expect(capturedContent).toContain("Context: We need JSONB support");
  });

  test("passes configured model and system prompt", async () => {
    let capturedModel = "";
    let capturedSystem = "";
    const capturingClient: AnthropicMessagesClient = {
      async create(params) {
        capturedModel = params.model;
        capturedSystem = params.system;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const strategy = createLlmStrategy(
      { ...DEFAULT_LLM_CONFIG, model: "my-model", systemPrompt: "my-prompt" },
      capturingClient,
    );
    await strategy.answer({ question: "test" });

    expect(capturedModel).toBe("my-model");
    expect(capturedSystem).toBe("my-prompt");
  });

  test("throws on empty response", async () => {
    const emptyClient: AnthropicMessagesClient = {
      async create() {
        return { content: [] };
      },
    };

    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, emptyClient);
    await expect(strategy.answer({ question: "test" })).rejects.toThrow(
      "LLM returned no text content",
    );
  });

  test("throws on response with no text blocks", async () => {
    const noTextClient: AnthropicMessagesClient = {
      async create() {
        return { content: [{ type: "tool_use" }] };
      },
    };

    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, noTextClient);
    await expect(strategy.answer({ question: "test" })).rejects.toThrow(
      "LLM returned no text content",
    );
  });

  test("propagates API errors", async () => {
    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, failingClient(new Error("API timeout")));
    await expect(strategy.answer({ question: "test" })).rejects.toThrow("API timeout");
  });

  test("strategy name is 'llm'", () => {
    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, mockClient("x"));
    expect(strategy.name).toBe("llm");
  });

  test("handles unicode in question", async () => {
    const strategy = createLlmStrategy(DEFAULT_LLM_CONFIG, mockClient("Use UTF-8"));
    const answer = await strategy.answer({ question: "Support \u{1F680} emoji?" });
    expect(answer).toBe("Use UTF-8");
  });
});
