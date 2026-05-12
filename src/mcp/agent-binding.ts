import type { AgentOverrides } from "../core/operations/agent.js";

/**
 * Bind MCP-submitted agent identity to the stdio process identity.
 *
 * Tool arguments are model-generated and can be wrong or spoofed. In per-agent
 * stdio MCP, GROVE_AGENT_ID/GROVE_AGENT_ROLE are the trusted runtime binding.
 */
export function bindAgentIdentity(agent: AgentOverrides | undefined): AgentOverrides {
  const envAgentId = process.env.GROVE_AGENT_ID;
  const envRole = process.env.GROVE_AGENT_ROLE;
  const bound: AgentOverrides = {
    ...(agent ?? {}),
    ...(envAgentId !== undefined && envAgentId.length > 0 ? { agentId: envAgentId } : {}),
    ...(envRole !== undefined && envRole.length > 0 ? { role: envRole } : {}),
  };

  if (bound.role !== undefined) return bound;

  const inferredRole = inferRoleFromAgentId(bound.agentId);
  return inferredRole !== undefined ? { ...bound, role: inferredRole } : bound;
}

function inferRoleFromAgentId(agentId: string | undefined): string | undefined {
  if (agentId === undefined || !agentId.includes("-")) return undefined;
  const role = agentId.replace(/-[a-z0-9]+$/i, "");
  return role !== agentId && role.length > 0 ? role : undefined;
}
