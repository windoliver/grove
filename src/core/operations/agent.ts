/**
 * Unified agent identity resolution for all surfaces.
 *
 * Consolidates CLI (src/cli/agent.ts) and MCP (src/mcp/agent-identity.ts)
 * agent resolution into a single core function.
 *
 * Precedence: explicit overrides > environment variables > defaults.
 */

import { hostname } from "node:os";

import type { AgentIdentity } from "../models.js";

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

/** Partial agent identity overrides (all fields optional). */
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
 * Resolve agent identity from overrides and environment variables.
 *
 * Precedence: overrides > env vars > defaults.
 * The only required field is `agentId`, which defaults to `hostname-pid`.
 */
export function resolveAgent(overrides?: AgentOverrides): AgentIdentity {
  const env = process.env;

  const agentId = overrides?.agentId ?? env[ENV_VARS.agentId] ?? `${hostname()}-${process.pid}`;

  const identity: AgentIdentity = {
    agentId,
    ...(pick(overrides?.agentName, env[ENV_VARS.agentName]) !== undefined && {
      agentName: pick(overrides?.agentName, env[ENV_VARS.agentName]),
    }),
    ...(pick(overrides?.provider, env[ENV_VARS.provider]) !== undefined && {
      provider: pick(overrides?.provider, env[ENV_VARS.provider]),
    }),
    ...(pick(overrides?.model, env[ENV_VARS.model]) !== undefined && {
      model: pick(overrides?.model, env[ENV_VARS.model]),
    }),
    ...(pick(overrides?.platform, env[ENV_VARS.platform]) !== undefined && {
      platform: pick(overrides?.platform, env[ENV_VARS.platform]),
    }),
    ...(pick(overrides?.version, env[ENV_VARS.version]) !== undefined && {
      version: pick(overrides?.version, env[ENV_VARS.version]),
    }),
    ...(pick(overrides?.toolchain, env[ENV_VARS.toolchain]) !== undefined && {
      toolchain: pick(overrides?.toolchain, env[ENV_VARS.toolchain]),
    }),
    ...(pick(overrides?.runtime, env[ENV_VARS.runtime]) !== undefined && {
      runtime: pick(overrides?.runtime, env[ENV_VARS.runtime]),
    }),
    ...(pick(overrides?.role, env[ENV_VARS.role]) !== undefined && {
      role: pick(overrides?.role, env[ENV_VARS.role]),
    }),
  };

  return identity;
}

function pick(overrideValue: string | undefined, envValue: string | undefined): string | undefined {
  return overrideValue ?? envValue ?? undefined;
}
