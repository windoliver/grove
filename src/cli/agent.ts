/**
 * Agent identity resolution for CLI commands.
 *
 * Resolves agent identity from CLI flags and environment variables.
 * Precedence: CLI flags > environment variables > defaults.
 */

import { hostname } from "node:os";

import type { AgentIdentity } from "../core/models.js";
import type { AgentRole, AgentTopology } from "../core/topology.js";

/** Environment variable names for agent identity fields. */
const ENV_VARS = {
  agentId: "GROVE_AGENT_ID",
  agentName: "GROVE_AGENT_NAME",
  provider: "GROVE_AGENT_PROVIDER",
  model: "GROVE_AGENT_MODEL",
  platform: "GROVE_AGENT_PLATFORM",
  version: "GROVE_AGENT_VERSION",
  toolchain: "GROVE_AGENT_TOOLCHAIN",
  runtime: "GROVE_AGENT_RUNTIME",
  role: "GROVE_AGENT_ROLE",
} as const;

/** CLI overrides for agent identity (all optional). */
export interface AgentOverrides {
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly platform?: string | undefined;
  readonly version?: string | undefined;
  readonly toolchain?: string | undefined;
  readonly runtime?: string | undefined;
  readonly role?: string | undefined;
}

/**
 * Resolve agent identity from CLI overrides and environment variables.
 *
 * Precedence: CLI flags > env vars > defaults.
 * The only required field is `agentId`, which defaults to `hostname-pid`.
 */
export function resolveAgent(overrides?: AgentOverrides): AgentIdentity {
  const env = process.env;

  const agentId = overrides?.agentId ?? env[ENV_VARS.agentId] ?? `${hostname()}-${process.pid}`;

  const identity: AgentIdentity = {
    agentId,
    ...(resolveField(overrides?.agentName, env[ENV_VARS.agentName]) && {
      agentName: resolveField(overrides?.agentName, env[ENV_VARS.agentName]),
    }),
    ...(resolveField(overrides?.provider, env[ENV_VARS.provider]) && {
      provider: resolveField(overrides?.provider, env[ENV_VARS.provider]),
    }),
    ...(resolveField(overrides?.model, env[ENV_VARS.model]) && {
      model: resolveField(overrides?.model, env[ENV_VARS.model]),
    }),
    ...(resolveField(overrides?.platform, env[ENV_VARS.platform]) && {
      platform: resolveField(overrides?.platform, env[ENV_VARS.platform]),
    }),
    ...(resolveField(overrides?.version, env[ENV_VARS.version]) && {
      version: resolveField(overrides?.version, env[ENV_VARS.version]),
    }),
    ...(resolveField(overrides?.toolchain, env[ENV_VARS.toolchain]) && {
      toolchain: resolveField(overrides?.toolchain, env[ENV_VARS.toolchain]),
    }),
    ...(resolveField(overrides?.runtime, env[ENV_VARS.runtime]) && {
      runtime: resolveField(overrides?.runtime, env[ENV_VARS.runtime]),
    }),
    ...(resolveField(overrides?.role, env[ENV_VARS.role]) && {
      role: resolveField(overrides?.role, env[ENV_VARS.role]),
    }),
  };

  return identity;
}

/**
 * Resolve the AgentRole from a topology for a given agent identity.
 *
 * Returns undefined if topology is missing, agent has no role, or
 * the role name doesn't match any role defined in the topology.
 */
export function resolveAgentRole(
  topology: AgentTopology | undefined,
  agentIdentity: AgentIdentity,
): AgentRole | undefined {
  if (topology === undefined) {
    return undefined;
  }
  if (agentIdentity.role === undefined) {
    return undefined;
  }
  const roleName = agentIdentity.role;
  return topology.roles.find((r) => r.name === roleName);
}

function resolveField(
  cliValue: string | undefined,
  envValue: string | undefined,
): string | undefined {
  return cliValue ?? envValue ?? undefined;
}
