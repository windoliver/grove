/**
 * Strategy interface and composite fallback chain.
 *
 * Each strategy implements AnswerStrategy. The chain wraps a primary
 * strategy with a fallback, transparently retrying on primary failure.
 */

import type { AskUserConfig, StrategyNameType } from "./config.js";

/** Input to an answering strategy. */
export interface AskUserInput {
  readonly question: string;
  readonly options?: readonly string[] | undefined;
  readonly context?: string | undefined;
}

/** A strategy that answers agent questions. */
export interface AnswerStrategy {
  readonly name: string;
  answer(input: AskUserInput): Promise<string>;
}

/** Safe default answer when both primary and fallback fail. */
const SAFE_DEFAULT = "Proceed with the simpler, more conventional approach.";

/**
 * Create a composite strategy chain with fallback.
 *
 * If the primary strategy throws, the fallback fires. If both fail,
 * returns a safe default answer and logs warnings to stderr.
 */
export function createStrategyChain(
  primary: AnswerStrategy,
  fallback: AnswerStrategy | undefined,
): AnswerStrategy {
  return {
    name: `${primary.name}${fallback ? `+${fallback.name}` : ""}`,

    async answer(input: AskUserInput): Promise<string> {
      try {
        return await primary.answer(input);
      } catch (primaryError: unknown) {
        console.error(
          `[ask-user] Primary strategy "${primary.name}" failed:`,
          primaryError instanceof Error ? primaryError.message : primaryError,
        );

        if (fallback) {
          try {
            return await fallback.answer(input);
          } catch (fallbackError: unknown) {
            console.error(
              `[ask-user] Fallback strategy "${fallback.name}" also failed:`,
              fallbackError instanceof Error ? fallbackError.message : fallbackError,
            );
          }
        }

        console.error("[ask-user] All strategies failed, returning safe default.");
        return SAFE_DEFAULT;
      }
    },
  };
}

/**
 * Resolve a strategy name to its implementation.
 *
 * Uses dynamic imports to lazy-load only the configured strategy's deps.
 */
export async function resolveStrategy(
  name: StrategyNameType,
  config: AskUserConfig,
): Promise<AnswerStrategy> {
  switch (name) {
    case "llm": {
      const { createLlmStrategy } = await import("./strategies/llm.js");
      return createLlmStrategy(config.llm);
    }
    case "rules": {
      const { createRulesStrategy } = await import("./strategies/rules.js");
      return createRulesStrategy(config.rules);
    }
    case "agent": {
      const { createAgentStrategy } = await import("./strategies/agent.js");
      return createAgentStrategy(config.agent);
    }
    case "interactive": {
      const { createInteractiveStrategy } = await import("./strategies/interactive.js");
      return createInteractiveStrategy();
    }
  }
}

/**
 * Build the full strategy chain from config.
 *
 * Eagerly initializes both primary and fallback strategies at startup.
 */
export async function buildStrategyFromConfig(config: AskUserConfig): Promise<AnswerStrategy> {
  const primary = await resolveStrategy(config.strategy, config);
  const fallback = config.fallback ? await resolveStrategy(config.fallback, config) : undefined;
  return createStrategyChain(primary, fallback);
}
