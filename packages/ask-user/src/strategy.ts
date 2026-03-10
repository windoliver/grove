/**
 * Strategy interface and composite fallback chain.
 *
 * Each strategy implements AnswerStrategy. The chain wraps a primary
 * strategy with a fallback, transparently retrying on primary failure.
 *
 * The fallback is initialized lazily on first use so that a misconfigured
 * or unavailable fallback (e.g. agent strategy without acpx) does not
 * prevent the server from starting when the primary strategy is healthy.
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
 *
 * @param asFallback - When true, strategy creation tolerates missing
 *   external dependencies (e.g. acpx not on PATH) so that an
 *   unreachable fallback does not block server startup.
 */
export async function resolveStrategy(
  name: StrategyNameType,
  config: AskUserConfig,
  asFallback = false,
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
      return createAgentStrategy(config.agent, undefined, asFallback);
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
 * The primary strategy is initialized eagerly (fails fast on bad config).
 * The fallback is initialized lazily on first use so that a missing
 * dependency (e.g. acpx not installed) does not abort server startup
 * when the primary strategy can handle every request.
 */
export async function buildStrategyFromConfig(config: AskUserConfig): Promise<AnswerStrategy> {
  const primary = await resolveStrategy(config.strategy, config);

  if (!config.fallback) {
    return createStrategyChain(primary, undefined);
  }

  // Build a lazy wrapper that resolves the fallback on first call.
  let resolvedFallback: AnswerStrategy | undefined;
  let fallbackFailed = false;

  const lazyFallback: AnswerStrategy = {
    name: config.fallback,
    async answer(input: AskUserInput): Promise<string> {
      if (fallbackFailed) {
        throw new Error(`Fallback strategy "${config.fallback}" previously failed to initialize`);
      }
      if (!resolvedFallback) {
        try {
          resolvedFallback = await resolveStrategy(config.fallback, config, true);
        } catch (initError: unknown) {
          fallbackFailed = true;
          console.error(
            `[ask-user] Fallback strategy "${config.fallback}" failed to initialize:`,
            initError instanceof Error ? initError.message : initError,
          );
          throw initError;
        }
      }
      return resolvedFallback.answer(input);
    },
  };

  return createStrategyChain(primary, lazyFallback);
}
