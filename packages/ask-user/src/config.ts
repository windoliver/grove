/**
 * Configuration schema and loading for @grove/ask-user.
 *
 * Config is loaded from a JSON file path specified by GROVE_ASK_USER_CONFIG
 * env var, with sensible defaults if no config is provided.
 */

import { readFileSync } from "node:fs";
import { z } from "zod/v4";

/** Valid strategy names. */
export type StrategyNameType = "llm" | "rules" | "agent" | "interactive";

/** Rules strategy configuration. */
export interface RulesConfigType {
  readonly prefer: "simpler" | "existing" | "first";
  readonly defaultResponse: string;
}

/** LLM strategy configuration. */
export interface LlmConfigType {
  readonly model: string;
  readonly systemPrompt: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
}

/** Agent strategy configuration. */
export interface AgentConfigType {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** Full @grove/ask-user configuration. */
export interface AskUserConfig {
  readonly strategy: StrategyNameType;
  readonly fallback: StrategyNameType;
  readonly llm: LlmConfigType;
  readonly rules: RulesConfigType;
  readonly agent: AgentConfigType;
}

// --- Internal Zod schemas (not exported, avoids isolatedDeclarations issues) ---

const strategyNameSchema = z.enum(["llm", "rules", "agent", "interactive"]);

const rulesConfigSchema = z
  .object({
    prefer: z.enum(["simpler", "existing", "first"]).default("simpler"),
    defaultResponse: z.string().default("Proceed with the simpler, more conventional approach."),
  })
  .strict();

const llmConfigSchema = z
  .object({
    model: z.string().default("claude-haiku-4-5-20251001"),
    systemPrompt: z
      .string()
      .default(
        "You are answering questions on behalf of a developer. Be decisive. Pick the simpler option. One sentence max.",
      ),
    timeoutMs: z.number().int().positive().default(30_000),
    maxTokens: z.number().int().positive().default(256),
  })
  .strict();

const agentConfigSchema = z
  .object({
    command: z.string().default("acpx"),
    args: z.array(z.string()).default(["--approve-all", "claude"]),
    timeoutMs: z.number().int().positive().default(60_000),
  })
  .strict();

const configSchema = z
  .object({
    strategy: strategyNameSchema.default("llm"),
    fallback: strategyNameSchema.optional().default("rules"),
    llm: llmConfigSchema.optional().default(() => llmConfigSchema.parse({})),
    rules: rulesConfigSchema.optional().default(() => rulesConfigSchema.parse({})),
    agent: agentConfigSchema.optional().default(() => agentConfigSchema.parse({})),
  })
  .strict();

const DEFAULT_CONFIG: AskUserConfig = configSchema.parse({}) as AskUserConfig;

/**
 * Parse and validate raw config input against the schema.
 *
 * @param input - Raw configuration object.
 * @returns Validated configuration.
 * @throws On invalid input.
 */
export function parseConfig(input: unknown): AskUserConfig {
  return configSchema.parse(input) as AskUserConfig;
}

/**
 * Load configuration from env var path or return defaults.
 *
 * @returns Validated configuration.
 * @throws On invalid config file content.
 */
export function loadConfig(): AskUserConfig {
  const configPath = process.env.GROVE_ASK_USER_CONFIG;
  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return parseConfig(parsed);
}
