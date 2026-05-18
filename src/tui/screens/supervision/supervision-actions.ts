/**
 * Supervision action descriptors. Pure module — pairs an action key with an
 * enablement predicate based on the selected agent's health.
 */

import type { AgentHealth } from "./agent-health.js";

export type SupervisionAction =
  | "approve"
  | "deny"
  | "always"
  | "reroute"
  | "kill"
  | "tail"
  | "dag"
  | "message";

export const SUPERVISION_ACTIONS: readonly SupervisionAction[] = [
  "approve",
  "deny",
  "always",
  "reroute",
  "kill",
  "tail",
  "dag",
  "message",
];

export function actionEnabled(action: SupervisionAction, health: AgentHealth): boolean {
  switch (action) {
    case "approve":
    case "deny":
    case "always":
      return health.kind === "approval";
    case "reroute":
      return health.kind === "blocked";
    case "kill":
      return health.kind !== "expired";
    case "tail":
    case "dag":
    case "message":
      return true;
  }
}
