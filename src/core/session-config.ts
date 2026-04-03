/**
 * Typed runtime config lens — extracts runtime-relevant fields from a
 * frozen GroveContract snapshot stored on a session.
 *
 * This is the canonical way to access session-scoped configuration.
 * Fields are intentionally a Pick<> of GroveContract so that the type
 * stays in sync with the contract schema automatically.
 */

import type { GroveContract } from "./contract.js";

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
