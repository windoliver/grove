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

  const currentInstances = activeClaims.filter((c) => c.agent.role === roleName).length;

  if (role.maxInstances !== undefined && currentInstances >= role.maxInstances) {
    return {
      allowed: false,
      role,
      currentInstances,
      maxInstances: role.maxInstances,
      warning: `Role '${roleName}' at capacity (${currentInstances}/${role.maxInstances})`,
    };
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
