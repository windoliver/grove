import { describe, expect, test } from "bun:test";
import type { AskUserConfig } from "./config.js";
import type { AnswerStrategy, AskUserInput } from "./strategy.js";
import { buildStrategyFromConfig, createStrategyChain } from "./strategy.js";

function mockStrategy(name: string, answer: string): AnswerStrategy {
  return {
    name,
    async answer() {
      return answer;
    },
  };
}

function failingStrategy(name: string, error: Error): AnswerStrategy {
  return {
    name,
    async answer() {
      throw error;
    },
  };
}

function capturingStrategy(
  name: string,
  answer: string,
): AnswerStrategy & { calls: AskUserInput[] } {
  const calls: AskUserInput[] = [];
  return {
    name,
    calls,
    async answer(input: AskUserInput) {
      calls.push(input);
      return answer;
    },
  };
}

describe("createStrategyChain", () => {
  test("returns primary answer on success", async () => {
    const chain = createStrategyChain(
      mockStrategy("primary", "from primary"),
      mockStrategy("fallback", "from fallback"),
    );
    const answer = await chain.answer({ question: "test" });
    expect(answer).toBe("from primary");
  });

  test("falls back on primary failure", async () => {
    const chain = createStrategyChain(
      failingStrategy("primary", new Error("boom")),
      mockStrategy("fallback", "from fallback"),
    );
    const answer = await chain.answer({ question: "test" });
    expect(answer).toBe("from fallback");
  });

  test("returns safe default on double failure", async () => {
    const chain = createStrategyChain(
      failingStrategy("primary", new Error("boom1")),
      failingStrategy("fallback", new Error("boom2")),
    );
    const answer = await chain.answer({ question: "test" });
    expect(answer).toBe("Proceed with the simpler, more conventional approach.");
  });

  test("returns safe default when no fallback and primary fails", async () => {
    const chain = createStrategyChain(failingStrategy("primary", new Error("boom")), undefined);
    const answer = await chain.answer({ question: "test" });
    expect(answer).toBe("Proceed with the simpler, more conventional approach.");
  });

  test("does not call fallback when primary succeeds", async () => {
    const fallback = capturingStrategy("fallback", "nope");
    const chain = createStrategyChain(mockStrategy("primary", "yes"), fallback);
    await chain.answer({ question: "test" });
    expect(fallback.calls).toHaveLength(0);
  });

  test("passes input to fallback on primary failure", async () => {
    const fallback = capturingStrategy("fallback", "from fallback");
    const chain = createStrategyChain(failingStrategy("primary", new Error("boom")), fallback);
    await chain.answer({
      question: "What DB?",
      options: ["Postgres"],
      context: "ctx",
    });
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]?.question).toBe("What DB?");
    expect(fallback.calls[0]?.options).toEqual(["Postgres"]);
    expect(fallback.calls[0]?.context).toBe("ctx");
  });

  test("chain name combines primary and fallback", () => {
    const chain = createStrategyChain(mockStrategy("llm", "x"), mockStrategy("rules", "y"));
    expect(chain.name).toBe("llm+rules");
  });

  test("chain name is just primary when no fallback", () => {
    const chain = createStrategyChain(mockStrategy("llm", "x"), undefined);
    expect(chain.name).toBe("llm");
  });

  test("handles non-Error thrown by primary", async () => {
    const primary: AnswerStrategy = {
      name: "bad",
      async answer() {
        throw "string error"; // eslint-disable-line no-throw-literal
      },
    };
    const chain = createStrategyChain(primary, mockStrategy("fallback", "ok"));
    const answer = await chain.answer({ question: "test" });
    expect(answer).toBe("ok");
  });
});

describe("buildStrategyFromConfig — lazy fallback", () => {
  test("starts successfully when fallback is 'agent' but acpx is missing", async () => {
    // This should NOT throw — the fallback is lazy
    const config: AskUserConfig = {
      strategy: "rules",
      fallback: "agent",
      llm: {
        model: "claude-haiku-4-5-20251001",
        systemPrompt: "test",
        timeoutMs: 30_000,
        maxTokens: 256,
      },
      rules: {
        prefer: "first",
        defaultResponse: "default",
      },
      agent: {
        command: "nonexistent-binary-xyz",
        args: [],
        timeoutMs: 5000,
      },
    };

    const strategy = await buildStrategyFromConfig(config);
    // Primary should work fine
    const answer = await strategy.answer({
      question: "test",
      options: ["A", "B"],
    });
    expect(answer).toBe("A");
  });

  test("lazy fallback fires when primary fails", async () => {
    const config: AskUserConfig = {
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
        defaultResponse: "from rules",
      },
      agent: {
        command: "acpx",
        args: [],
        timeoutMs: 5000,
      },
    };

    const strategy = await buildStrategyFromConfig(config);
    // No options → returns default response from rules
    const answer = await strategy.answer({ question: "open-ended question" });
    expect(answer).toBe("from rules");
  });
});
