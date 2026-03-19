/**
 * `grove whoami` — display the resolved agent identity.
 *
 * Reads GROVE_AGENT_* env vars and prints the resolved identity.
 * Useful for debugging agent configuration in spawned environments.
 */

import { parseArgs } from "node:util";

import { resolveAgent } from "../../core/operations/agent.js";
import { outputJson } from "../format.js";

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

  if (values.json) {
    outputJson(agent);
    return;
  }

  console.log(`Agent ID:  ${agent.agentId}`);
  if (agent.role) console.log(`Role:      ${agent.role}`);
  if (agent.agentName) console.log(`Name:      ${agent.agentName}`);
  if (agent.model) console.log(`Model:     ${agent.model}`);
  if (agent.platform) console.log(`Platform:  ${agent.platform}`);
  if (agent.provider) console.log(`Provider:  ${agent.provider}`);
  if (agent.toolchain) console.log(`Toolchain: ${agent.toolchain}`);
  if (agent.runtime) console.log(`Runtime:   ${agent.runtime}`);
  if (agent.version) console.log(`Version:   ${agent.version}`);
}
