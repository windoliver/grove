/**
 * Typed runtime config lens for per-session policy enforcement.
 *
 * The full GroveContract is stored as a frozen snapshot in each session.
 * This module defines the narrow subset of fields that the PolicyEnforcer
 * and SessionOrchestrator actually read at runtime.
 */

import type { GroveContract } from "./contract.js";

/**
 * The subset of GroveContract fields read at runtime for per-session
 * policy enforcement and orchestration.
 */
export type SessionRuntimeConfig = Pick<
  GroveContract,
  | "mode"
  | "metrics"
  | "gates"
  | "stopConditions"
  | "agentConstraints"
  | "concurrency"
  | "execution"
  | "outcomePolicy"
  | "evaluation"
  | "rateLimits"
  | "hooks"
  | "topology"
>;

/** Extract runtime config from a session's frozen contract snapshot. */
export function getSessionRuntimeConfig(session: {
  config?: GroveContract;
}): SessionRuntimeConfig | undefined {
  if (!session.config) return undefined;
  const c = session.config;
  return {
    mode: c.mode,
    metrics: c.metrics,
    gates: c.gates,
    stopConditions: c.stopConditions,
    agentConstraints: c.agentConstraints,
    concurrency: c.concurrency,
    execution: c.execution,
    outcomePolicy: c.outcomePolicy,
    evaluation: c.evaluation,
    rateLimits: c.rateLimits,
    hooks: c.hooks,
    topology: c.topology,
  };
}
