/**
 * Agent identity resolution for MCP tools.
 *
 * When agents call MCP tools, they can optionally provide an agent identity
 * object. If omitted, identity is resolved from GROVE_AGENT_* environment
 * variables (same as the CLI), falling back to hostname-pid.
 *
 * This lets MCP hosts like Claude Code or Codex set env vars once rather
 * than passing agent identity on every tool call.
 */

import { hostname } from "node:os";

import type { AgentIdentity } from "../core/models.js";

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
} as const;

/** Partial agent identity as provided by tool callers (all fields optional). */
export interface AgentInput {
  readonly agentId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly platform?: string | undefined;
  readonly version?: string | undefined;
  readonly toolchain?: string | undefined;
  readonly runtime?: string | undefined;
}

/**
 * Resolve agent identity from tool input and environment variables.
 *
 * Precedence: tool input > env vars > defaults.
 * The only required field is `agentId`, which defaults to `hostname-pid`.
 */
export function resolveAgentIdentity(input?: AgentInput): AgentIdentity {
  const env = process.env;

  const agentId = input?.agentId ?? env[ENV_VARS.agentId] ?? `${hostname()}-${process.pid}`;

  const identity: AgentIdentity = {
    agentId,
    ...(pick(input?.agentName, env[ENV_VARS.agentName]) !== undefined && {
      agentName: pick(input?.agentName, env[ENV_VARS.agentName]),
    }),
    ...(pick(input?.provider, env[ENV_VARS.provider]) !== undefined && {
      provider: pick(input?.provider, env[ENV_VARS.provider]),
    }),
    ...(pick(input?.model, env[ENV_VARS.model]) !== undefined && {
      model: pick(input?.model, env[ENV_VARS.model]),
    }),
    ...(pick(input?.platform, env[ENV_VARS.platform]) !== undefined && {
      platform: pick(input?.platform, env[ENV_VARS.platform]),
    }),
    ...(pick(input?.version, env[ENV_VARS.version]) !== undefined && {
      version: pick(input?.version, env[ENV_VARS.version]),
    }),
    ...(pick(input?.toolchain, env[ENV_VARS.toolchain]) !== undefined && {
      toolchain: pick(input?.toolchain, env[ENV_VARS.toolchain]),
    }),
    ...(pick(input?.runtime, env[ENV_VARS.runtime]) !== undefined && {
      runtime: pick(input?.runtime, env[ENV_VARS.runtime]),
    }),
  };

  return identity;
}

function pick(inputValue: string | undefined, envValue: string | undefined): string | undefined {
  return inputValue ?? envValue ?? undefined;
}
