/**
 * Spawn validation helpers for topology-aware agent spawning.
 *
 * Advisory approach: warns when over capacity but does not block claims.
 * Used by the command palette and agent graph view to surface capacity info.
 */

import type { Claim } from "../../core/models.js";
import type { AgentRole, AgentTopology } from "../../core/topology.js";

/** Result of checking whether a spawn is allowed by topology. */
export interface SpawnCheck {
  readonly allowed: boolean;
  readonly role: AgentRole | undefined;
  readonly currentInstances: number;
  readonly maxInstances: number | undefined;
  readonly warning?: string | undefined;
}

/** Check if spawning an agent with the given role is allowed by topology constraints. */
export function checkSpawn(
  topology: AgentTopology | undefined,
  roleName: string,
  activeClaims: readonly Claim[],
  parentAgentId?: string | undefined,
  /** Active spawn count per role — used when claims are not auto-created on spawn. */
  activeSpawnCounts?: ReadonlyMap<string, number>,
): SpawnCheck {
  if (topology === undefined) {
    return {
      allowed: true,
      role: undefined,
      currentInstances: 0,
      maxInstances: undefined,
    };
  }

  const role = topology.roles.find((r) => r.name === roleName);
  if (role === undefined) {
    return {
      allowed: false,
      role: undefined,
      currentInstances: 0,
      maxInstances: undefined,
      warning: `Role '${roleName}' not defined in topology`,
    };
  }

  // Use spawn counts if available (no auto-claims), fall back to claim-based counting
  const currentInstances =
    activeSpawnCounts?.get(roleName) ??
    new Set(activeClaims.filter((c) => c.agent.role === roleName).map((c) => c.agent.agentId)).size;

  if (role.maxInstances !== undefined && currentInstances >= role.maxInstances) {
    return {
      allowed: false,
      role,
      currentInstances,
      maxInstances: role.maxInstances,
      warning: `Role '${roleName}' at capacity (${currentInstances}/${role.maxInstances})`,
    };
  }

  // Check max_children_per_agent if parent agent ID is known
  if (parentAgentId !== undefined) {
    const childrenCheck = checkSpawnChildren(topology, parentAgentId, activeClaims);
    if (!childrenCheck.allowed) {
      return {
        allowed: false,
        role,
        currentInstances,
        maxInstances: role.maxInstances,
        warning: childrenCheck.warning,
      };
    }
  }

  return {
    allowed: true,
    role,
    currentInstances,
    maxInstances: role.maxInstances,
  };
}

/** Result of checking spawn depth constraint. */
export interface SpawnDepthCheck {
  readonly allowed: boolean;
  readonly maxDepth: number | undefined;
  readonly warning?: string | undefined;
}

/** Check spawning depth constraint. */
export function checkSpawnDepth(
  topology: AgentTopology | undefined,
  currentDepth: number,
): SpawnDepthCheck {
  if (topology === undefined) {
    return { allowed: true, maxDepth: undefined };
  }

  const maxDepth = topology.spawning?.maxDepth;
  if (maxDepth === undefined) {
    return { allowed: true, maxDepth: undefined };
  }

  if (currentDepth >= maxDepth) {
    return {
      allowed: false,
      maxDepth,
      warning: `Spawn depth ${currentDepth} exceeds max_depth ${maxDepth}`,
    };
  }

  return { allowed: true, maxDepth };
}

/** Result of checking max_children_per_agent constraint. */
export interface SpawnChildrenCheck {
  readonly allowed: boolean;
  readonly currentChildren: number;
  readonly maxChildrenPerAgent: number | undefined;
  readonly warning?: string | undefined;
}

/** Check if a parent agent has reached the max_children_per_agent limit. */
export function checkSpawnChildren(
  topology: AgentTopology | undefined,
  parentAgentId: string,
  activeClaims: readonly Claim[],
): SpawnChildrenCheck {
  if (topology === undefined) {
    return { allowed: true, currentChildren: 0, maxChildrenPerAgent: undefined };
  }

  const maxChildren = topology.spawning?.maxChildrenPerAgent;
  if (maxChildren === undefined) {
    return { allowed: true, currentChildren: 0, maxChildrenPerAgent: undefined };
  }

  // Count active claims whose agent references the parent agent
  const currentChildren = activeClaims.filter(
    (c) => c.context?.parentAgentId === parentAgentId,
  ).length;

  if (currentChildren >= maxChildren) {
    return {
      allowed: false,
      currentChildren,
      maxChildrenPerAgent: maxChildren,
      warning: `Parent agent '${parentAgentId}' at child capacity (${currentChildren}/${maxChildren})`,
    };
  }

  return { allowed: true, currentChildren, maxChildrenPerAgent: maxChildren };
}
