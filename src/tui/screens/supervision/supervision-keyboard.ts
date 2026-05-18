/**
 * Pure keyboard router for the supervision body (issue #193).
 *
 * Returns true if it consumed the key. Caller passes through to the global
 * router otherwise.
 */

import type { AgentHealth } from "./agent-health.js";
import { actionEnabled } from "./supervision-actions.js";

export interface SupervisionKey {
  readonly name: string;
}

export interface SupervisionKeyboardState {
  readonly selectedHealth: AgentHealth | undefined;
}

export interface SupervisionKeyboardActions {
  readonly moveCursor: (delta: number) => void;
  readonly pinSelection: () => void;
  readonly jumpTop: () => void;
  readonly jumpBottom: () => void;
  readonly approve: () => void;
  readonly deny: () => void;
  readonly always: () => void;
  readonly openTail: () => void;
  readonly openDag: () => void;
  readonly reroute: () => void;
  readonly kill: () => void;
  readonly openMessage: () => void;
}

export function routeSupervisionKey(
  key: SupervisionKey,
  state: SupervisionKeyboardState,
  actions: SupervisionKeyboardActions,
): boolean {
  const health = state.selectedHealth;
  switch (key.name) {
    case "j":
      actions.moveCursor(1);
      return true;
    case "k":
      actions.moveCursor(-1);
      return true;
    case "return":
    case "enter":
      actions.pinSelection();
      return true;
    case "g":
      actions.jumpTop();
      return true;
    case "G":
      actions.jumpBottom();
      return true;
    case "y":
      if (health && actionEnabled("approve", health)) {
        actions.approve();
        return true;
      }
      return false;
    case "n":
      if (health && actionEnabled("deny", health)) {
        actions.deny();
        return true;
      }
      return false;
    case "a":
      if (health && actionEnabled("always", health)) {
        actions.always();
        return true;
      }
      return false;
    case "t":
      if (health && actionEnabled("tail", health)) {
        actions.openTail();
        return true;
      }
      return false;
    case "d":
      if (health && actionEnabled("dag", health)) {
        actions.openDag();
        return true;
      }
      return false;
    case "r":
      if (health && actionEnabled("reroute", health)) {
        actions.reroute();
        return true;
      }
      return false;
    case "K":
      if (health && actionEnabled("kill", health)) {
        actions.kill();
        return true;
      }
      return false;
    case "m":
      if (health && actionEnabled("message", health)) {
        actions.openMessage();
        return true;
      }
      return false;
    default:
      return false;
  }
}
