/**
 * @grove/ask-user — Public API exports.
 *
 * Exports the strategy interface, config types, and factory functions
 * for programmatic use (e.g., embedding in other servers or testing).
 */

export type {
  AgentConfigType,
  AskUserConfig,
  LlmConfigType,
  RulesConfigType,
  StrategyNameType,
} from "./config.js";
export { loadConfig, parseConfig } from "./config.js";
export { registerAskUserTools } from "./register.js";
export type { SpawnFn } from "./strategies/agent.js";
export { createAgentStrategy } from "./strategies/agent.js";
export type { ReadlineFn } from "./strategies/interactive.js";
export { createInteractiveStrategy } from "./strategies/interactive.js";
export type { AnthropicMessagesClient } from "./strategies/llm.js";
export { createLlmStrategy } from "./strategies/llm.js";
export { createRulesStrategy } from "./strategies/rules.js";
export type { AnswerStrategy, AskUserInput } from "./strategy.js";
export { buildStrategyFromConfig, createStrategyChain, resolveStrategy } from "./strategy.js";
