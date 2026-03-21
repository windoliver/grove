/**
 * `grove whoami` — display the resolved agent identity and environment.
 *
 * Reads GROVE_AGENT_* env vars and prints the resolved identity,
 * along with grove directory and git context for diagnostics.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

import { resolveAgent } from "../../core/operations/agent.js";
import { outputJson } from "../format.js";
import { resolveGroveDir } from "../utils/grove-dir.js";

/** Try to resolve the current git branch, or return undefined. */
function gitBranch(): string | undefined {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export async function handleWhoami(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const agent = resolveAgent();

  // Resolve grove directory (may not exist)
  let groveDir: string | undefined;
  try {
    groveDir = resolveGroveDir().groveDir;
  } catch {
    // Not inside a grove — that's fine
  }

  const branch = gitBranch();

  if (values.json) {
    outputJson({
      ...agent,
      ...(groveDir !== undefined && { groveDir }),
      ...(branch !== undefined && { branch }),
    });
    return;
  }

  // Agent identity
  console.log(`Agent ID:  ${agent.agentId}`);
  if (agent.role) console.log(`Role:      ${agent.role}`);
  if (agent.agentName) console.log(`Name:      ${agent.agentName}`);
  if (agent.model) console.log(`Model:     ${agent.model}`);
  if (agent.platform) console.log(`Platform:  ${agent.platform}`);
  if (agent.provider) console.log(`Provider:  ${agent.provider}`);
  if (agent.toolchain) console.log(`Toolchain: ${agent.toolchain}`);
  if (agent.runtime) console.log(`Runtime:   ${agent.runtime}`);
  if (agent.version) console.log(`Version:   ${agent.version}`);

  // Environment context
  if (groveDir || branch) {
    console.log();
    if (groveDir) console.log(`Grove:     ${groveDir}`);
    if (branch) console.log(`Branch:    ${branch}`);
  }
}
