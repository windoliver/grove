/**
 * Rules-based answering strategy.
 *
 * Deterministic keyword matching and option selection heuristics.
 * Fully testable without external dependencies.
 *
 * SAFETY: When no options are provided, this strategy always returns the
 * configured default response rather than trying to infer yes/no intent.
 * This prevents auto-approving destructive prompts like "Should I drop
 * the backup table?" when used as a fallback after an LLM failure.
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
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked above
    return options[0]!;
  }

  const keywords = prefer === "simpler" ? SIMPLER_KEYWORDS : EXISTING_KEYWORDS;

  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt) continue;
    const score = scoreOption(opt, keywords);
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
      let shortestLen = options[0]?.length ?? 0;
      for (let i = 1; i < options.length; i++) {
        const len = options[i]?.length ?? 0;
        if (len < shortestLen) {
          shortestLen = len;
          shortestIdx = i;
        }
      }
      // biome-ignore lint/style/noNonNullAssertion: bounds-checked via shortestIdx
      return options[shortestIdx]!;
    }
    // For "existing" with no matches, default to first option
    // biome-ignore lint/style/noNonNullAssertion: bounds-checked above
    return options[0]!;
  }

  // biome-ignore lint/style/noNonNullAssertion: bounds-checked via bestIdx loop
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

      // Without explicit options we cannot safely infer intent.
      // Returning a conservative default avoids auto-approving
      // potentially destructive actions (e.g. "Should I drop the table?").
      return config.defaultResponse;
    },
  };
}
