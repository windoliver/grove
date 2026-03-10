/**
 * Rules-based answering strategy.
 *
 * Deterministic keyword matching and option selection heuristics.
 * Fully testable without external dependencies.
 */

import type { RulesConfigType } from "../config.js";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/** Keywords that suggest preferring existing patterns/conventions. */
const EXISTING_KEYWORDS = [
  "existing",
  "current",
  "keep",
  "convention",
  "pattern",
  "standard",
  "default",
  "maintain",
];

/** Keywords that suggest simpler approaches. */
const SIMPLER_KEYWORDS = [
  "simple",
  "simpler",
  "minimal",
  "basic",
  "straightforward",
  "easy",
  "less",
  "fewer",
];

/**
 * Score an option string based on keyword relevance.
 *
 * @returns Higher score = more relevant to the preference.
 */
function scoreOption(option: string, keywords: readonly string[]): number {
  const lower = option.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Pick the best option from a list based on the configured preference.
 */
function pickOption(options: readonly string[], prefer: "simpler" | "existing" | "first"): string {
  if (options.length === 0) {
    throw new Error("No options provided");
  }
  if (options.length === 1 || prefer === "first") {
    return options[0]!;
  }

  const keywords = prefer === "simpler" ? SIMPLER_KEYWORDS : EXISTING_KEYWORDS;

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < options.length; i++) {
    const score = scoreOption(options[i]!, keywords);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // If no keyword matches, fall back to heuristics
  if (bestScore === 0) {
    if (prefer === "simpler") {
      // Prefer the shorter option (simpler = less verbose)
      let shortestIdx = 0;
      let shortestLen = options[0]!.length;
      for (let i = 1; i < options.length; i++) {
        if (options[i]!.length < shortestLen) {
          shortestLen = options[i]!.length;
          shortestIdx = i;
        }
      }
      return options[shortestIdx]!;
    }
    // For "existing" with no matches, default to first option
    return options[0]!;
  }

  return options[bestIdx]!;
}

export function createRulesStrategy(config: RulesConfigType): AnswerStrategy {
  return {
    name: "rules",

    async answer(input: AskUserInput): Promise<string> {
      // If options are provided, pick the best one
      if (input.options && input.options.length > 0) {
        return pickOption(input.options, config.prefer);
      }

      // For yes/no questions, answer "yes"
      const lower = input.question.toLowerCase();
      if (
        lower.includes("should i") ||
        lower.includes("do you want") ||
        lower.includes("shall i") ||
        lower.includes("is it ok") ||
        lower.includes("can i")
      ) {
        return "Yes";
      }

      // Fall back to default response
      return config.defaultResponse;
    },
  };
}
