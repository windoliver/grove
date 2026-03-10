/**
 * `grove ask` command — ask a question from the command line.
 *
 * Defaults to interactive strategy (TTY prompt) for CLI use.
 * Use --strategy to override (e.g., --strategy rules for scripting).
 */

import { parseArgs } from "node:util";

import type { AskUserConfig, StrategyNameType } from "@grove/ask-user";
import { buildStrategyFromConfig, loadConfig, parseConfig } from "@grove/ask-user";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Parsed options for `grove ask`. */
export interface AskOptions {
  readonly question: string;
  readonly options: readonly string[];
  readonly context: string | undefined;
  readonly strategy: StrategyNameType | undefined;
  readonly config: string | undefined;
}

/**
 * Parse `grove ask` arguments.
 *
 * Usage: grove ask "question" [--options a,b,c] [--context "..."] [--strategy rules] [--config path]
 */
export function parseAskArgs(args: readonly string[]): AskOptions {
  const { values, positionals } = parseArgs({
    args: args as string[],
    options: {
      options: { type: "string" },
      context: { type: "string" },
      strategy: { type: "string" },
      config: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const question = positionals[0];
  if (!question) {
    throw new Error(
      "Usage: grove ask <question> [--options a,b,c] [--strategy interactive|rules|llm|agent]",
    );
  }

  const strategyValue = values.strategy as string | undefined;
  if (strategyValue && !["llm", "rules", "agent", "interactive"].includes(strategyValue)) {
    throw new Error(`Invalid strategy '${strategyValue}'. Valid: llm, rules, agent, interactive`);
  }

  const optionsList = values.options
    ? (values.options as string).split(",").map((s) => s.trim())
    : [];

  return {
    question,
    options: optionsList,
    context: values.context as string | undefined,
    strategy: strategyValue as StrategyNameType | undefined,
    config: values.config as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute `grove ask` with the given options.
 */
export async function executeAsk(opts: AskOptions): Promise<string> {
  let config: AskUserConfig;

  if (opts.config) {
    // Load from explicit config path
    const { readFileSync } = await import("node:fs");
    const raw: unknown = JSON.parse(readFileSync(opts.config, "utf-8"));
    config = parseConfig(raw);
  } else {
    config = loadConfig();
  }

  // Override strategy for CLI use: default to interactive
  if (opts.strategy) {
    config = { ...config, strategy: opts.strategy };
  } else if (!process.env.GROVE_ASK_USER_CONFIG) {
    // No explicit config and no env var — default to interactive for CLI
    config = { ...config, strategy: "interactive" };
  }

  const strategy = await buildStrategyFromConfig(config);
  return strategy.answer({
    question: opts.question,
    options: opts.options.length > 0 ? opts.options : undefined,
    context: opts.context,
  });
}

/**
 * Handle the `grove ask` CLI command.
 */
export async function handleAsk(args: readonly string[]): Promise<void> {
  const opts = parseAskArgs(args);
  const answer = await executeAsk(opts);
  console.log(answer);
}
