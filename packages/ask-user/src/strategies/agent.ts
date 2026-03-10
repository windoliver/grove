/**
 * Agent-based answering strategy.
 *
 * Routes questions to another acpx agent via subprocess.
 * Uses node:child_process for cross-runtime compatibility (Node + Bun).
 */

import { execFile } from "node:child_process";
import type { AgentConfigType } from "../config.js";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/** Spawn function type for dependency injection in tests. */
export type SpawnFn = (
  cmd: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Default spawn implementation using node:child_process.
 * Works in both Node.js and Bun runtimes.
 */
function defaultSpawn(
  cmd: string[],
  opts: { timeout: number },
): Promise<{ stdout: string; exitCode: number }> {
  const [command, ...args] = cmd;
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error("Empty command"));
      return;
    }
    execFile(command, args, { timeout: opts.timeout }, (error, stdout) => {
      if (error?.killed) {
        reject(new Error(`Agent process timed out after ${opts.timeout}ms`));
        return;
      }
      // execFile sets error for non-zero exit, but we handle that ourselves
      const exitCode = error?.code != null ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout: stdout.trim(), exitCode });
    });
  });
}

/**
 * Check if a command is available on PATH.
 * Uses node:child_process for cross-runtime compatibility.
 */
function isCommandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [command], (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Format the question into a prompt for the agent.
 */
function formatAgentPrompt(input: AskUserInput): string {
  const parts: string[] = [
    "Answer the following question decisively in one sentence.",
    "",
    input.question,
  ];

  if (input.options && input.options.length > 0) {
    parts.push("");
    parts.push(`Options: ${input.options.join(", ")}`);
  }

  if (input.context) {
    parts.push("");
    parts.push(`Context: ${input.context}`);
  }

  return parts.join("\n");
}

/**
 * Create an agent answering strategy.
 *
 * @param config - Agent configuration (command, args, timeout).
 * @param spawn - Optional spawn function for testing.
 * @param skipAvailabilityCheck - If true, skip the command availability check
 *   (used internally when the strategy is created lazily as a fallback).
 */
export async function createAgentStrategy(
  config: AgentConfigType,
  spawn?: SpawnFn,
  skipAvailabilityCheck?: boolean,
): Promise<AnswerStrategy> {
  // Guard: check if acpx is available (skip when DI spawn provided or when lazy)
  if (!spawn && !skipAvailabilityCheck) {
    const available = await isCommandAvailable(config.command);
    if (!available) {
      throw new Error(
        `Agent strategy requires "${config.command}" on PATH but it was not found. ` +
          `Install it or use a different strategy.`,
      );
    }
  }

  const spawnFn = spawn ?? defaultSpawn;

  return {
    name: "agent",

    async answer(input: AskUserInput): Promise<string> {
      const prompt = formatAgentPrompt(input);
      const cmd = [config.command, ...config.args, prompt];

      const result = await spawnFn(cmd, { timeout: config.timeoutMs });

      if (result.exitCode !== 0) {
        throw new Error(`Agent process exited with code ${result.exitCode}`);
      }

      const answer = result.stdout.trim();
      if (!answer) {
        throw new Error("Agent returned empty response");
      }

      return answer;
    },
  };
}
