/**
 * Agent identity resolution for CLI commands.
 *
 * Re-exports from the shared operations agent module so that CLI
 * consumers import from the canonical source of truth.
 *
 * The `resolveAgentRole` function is CLI-specific (topology matching)
 * and remains here.
 */

export type { AgentOverrides } from "../core/operations/agent.js";
export { resolveAgent } from "../core/operations/agent.js";

import type { AgentIdentity } from "../core/models.js";
import type { AgentRole, AgentTopology } from "../core/topology.js";

/**
 * Resolve the AgentRole from a topology for a given agent identity.
 *
 * Matching precedence:
 * 1. Explicit role — agentIdentity.role matches a topology role name
 * 2. Agent name fallback — agentIdentity.agentName matches a role name (case-insensitive)
 * 3. Agent ID fallback — agentIdentity.agentId contains a role name (case-insensitive)
 *
 * Returns undefined if topology is missing or no match is found.
 */
export function resolveAgentRole(
  topology: AgentTopology | undefined,
  agentIdentity: AgentIdentity,
): AgentRole | undefined {
  if (topology === undefined) {
    return undefined;
  }

  // 1. Explicit role match
  if (agentIdentity.role !== undefined) {
    const match = topology.roles.find((r) => r.name === agentIdentity.role);
    if (match !== undefined) {
      return match;
    }
  }

  // 2. Agent name fallback (case-insensitive)
  if (agentIdentity.agentName !== undefined) {
    const nameLower = agentIdentity.agentName.toLowerCase();
    const match = topology.roles.find((r) => r.name.toLowerCase() === nameLower);
    if (match !== undefined) {
      return match;
    }
  }

  // 3. Agent ID fallback — check if agentId contains a role name (case-insensitive)
  const idLower = agentIdentity.agentId.toLowerCase();
  for (const role of topology.roles) {
    if (idLower.includes(role.name.toLowerCase())) {
      return role;
    }
  }

  return undefined;
}
