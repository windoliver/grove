/**
 * Agent-based answering strategy.
 *
 * Routes questions to another acpx agent via subprocess.
 * Guards against missing acpx binary at initialization time.
 */

import type { AgentConfigType } from "../config.js";
import type { AnswerStrategy, AskUserInput } from "../strategy.js";

/** Spawn function type for dependency injection in tests. */
export type SpawnFn = (
  cmd: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; exitCode: number }>;

/**
 * Default spawn implementation using Bun.spawn.
 */
async function defaultSpawn(
  cmd: string[],
  opts: { timeout: number },
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutId = setTimeout(() => {
    proc.kill();
  }, opts.timeout);

  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), exitCode };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if a command is available on PATH.
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
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
 * @throws If the configured command is not available on PATH.
 */
export async function createAgentStrategy(
  config: AgentConfigType,
  spawn?: SpawnFn,
): Promise<AnswerStrategy> {
  // Guard: check if acpx is available
  if (!spawn) {
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
