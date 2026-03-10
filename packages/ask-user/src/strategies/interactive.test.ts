import { describe, expect, test } from "bun:test";
import type { ReadlineFn } from "./interactive.js";
import { createInteractiveStrategy } from "./interactive.js";

function mockReadline(response: string): ReadlineFn {
  return async () => response;
}

function failingReadline(error: Error): ReadlineFn {
  return async () => {
    throw error;
  };
}

describe("createInteractiveStrategy", () => {
  test("returns user input", async () => {
    const strategy = createInteractiveStrategy(mockReadline("my answer"));
    const answer = await strategy.answer({ question: "What do you think?" });
    expect(answer).toBe("my answer");
  });

  test("resolves numeric choice to option text", async () => {
    const strategy = createInteractiveStrategy(mockReadline("2"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta", "Gamma"],
    });
    expect(answer).toBe("Beta");
  });

  test("resolves first option for choice 1", async () => {
    const strategy = createInteractiveStrategy(mockReadline("1"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta"],
    });
    expect(answer).toBe("Alpha");
  });

  test("returns raw input for out-of-range number", async () => {
    const strategy = createInteractiveStrategy(mockReadline("5"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta"],
    });
    expect(answer).toBe("5");
  });

  test("returns raw text input when options provided but text typed", async () => {
    const strategy = createInteractiveStrategy(mockReadline("custom answer"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta"],
    });
    expect(answer).toBe("custom answer");
  });

  test("returns digit-prefixed text verbatim, not as option index", async () => {
    const strategy = createInteractiveStrategy(mockReadline("2 bananas"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta"],
    });
    expect(answer).toBe("2 bananas");
  });

  test("returns digit-containing word verbatim, not as option index", async () => {
    const strategy = createInteractiveStrategy(mockReadline("1password"));
    const answer = await strategy.answer({
      question: "Pick one",
      options: ["Alpha", "Beta"],
    });
    expect(answer).toBe("1password");
  });

  test("throws on empty input", async () => {
    const strategy = createInteractiveStrategy(mockReadline(""));
    await expect(strategy.answer({ question: "test" })).rejects.toThrow(
      "No input received from user",
    );
  });

  test("throws on no TTY", async () => {
    const strategy = createInteractiveStrategy(
      failingReadline(new Error("No TTY available for interactive input")),
    );
    await expect(strategy.answer({ question: "test" })).rejects.toThrow("No TTY available");
  });

  test("passes question in prompt to readline", async () => {
    let capturedPrompt = "";
    const capturingReadline: ReadlineFn = async (prompt) => {
      capturedPrompt = prompt;
      return "ok";
    };

    const strategy = createInteractiveStrategy(capturingReadline);
    await strategy.answer({
      question: "Should I refactor?",
      options: ["Yes", "No"],
    });

    expect(capturedPrompt).toContain("Should I refactor?");
    expect(capturedPrompt).toContain("1. Yes");
    expect(capturedPrompt).toContain("2. No");
  });

  test("strategy name is 'interactive'", () => {
    const strategy = createInteractiveStrategy(mockReadline("x"));
    expect(strategy.name).toBe("interactive");
  });
});
