/**
 * Interactive answering strategy.
 *
 * Prompts a human via TTY (stdin/stdout). Falls back gracefully
 * if no TTY is available.
 */

import { createInterface } from "node:readline";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/** Readline factory for dependency injection in tests. */
export type ReadlineFn = (prompt: string) => Promise<string>;

/**
 * Default readline implementation using node:readline.
 */
function defaultReadline(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if stdin is a TTY
    if (!process.stdin.isTTY) {
      reject(new Error("No TTY available for interactive input"));
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // MCP servers must not write to stdout
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Create an interactive answering strategy.
 *
 * @param readline - Optional readline function for testing.
 */
export function createInteractiveStrategy(readline?: ReadlineFn): AnswerStrategy {
  const readlineFn = readline ?? defaultReadline;

  return {
    name: "interactive",

    async answer(input: AskUserInput): Promise<string> {
      const parts: string[] = [`[ask-user] ${input.question}`];

      if (input.options && input.options.length > 0) {
        for (let i = 0; i < input.options.length; i++) {
          parts.push(`  ${i + 1}. ${input.options[i]}`);
        }
        parts.push("Enter choice number or type your answer: ");
      } else {
        parts.push("Your answer: ");
      }

      const prompt = parts.join("\n");
      const raw = await readlineFn(prompt);

      // If options provided and user typed exactly a number, resolve to the option text.
      // Only match bare integers (e.g. "2") — not "2 bananas" or "1password".
      if (input.options && input.options.length > 0 && /^\d+$/.test(raw)) {
        const idx = Number.parseInt(raw, 10);
        if (idx >= 1 && idx <= input.options.length) {
          // biome-ignore lint/style/noNonNullAssertion: bounds-checked above
          return input.options[idx - 1]!;
        }
      }

      if (!raw) {
        throw new Error("No input received from user");
      }

      return raw;
    },
  };
}
