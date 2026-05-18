/**
 * Pure derivation of agent supervision health (issue #193).
 *
 * Inputs come from the fleet model (claim + monitor output timestamps +
 * handoffs + permissions). The first matching rule wins.
 */

import type { PermissionPrompt } from "../../hooks/use-agent-monitor.js";

export interface HealthThresholds {
  /** No output for longer than this → silent. */
  readonly silentMs: number;
  /** currentTask unchanged for longer than this (with recent output) → stuck. */
  readonly stuckMs: number;
  /** attemptCount >= this with a recent retry → thrashing. */
  readonly thrashRetries: number;
  /** "Recent retry" window: lastRetryAt within this from now. */
  readonly thrashWindowMs: number;
  /** Minimum blocked age before health flips to "blocked". */
  readonly blockedMinMs: number;
  /** Heartbeat lapse beyond this counts as silent. */
  readonly heartbeatLapseMs: number;
}

export const HEALTH_THRESHOLDS: HealthThresholds = {
  silentMs: 5 * 60_000,
  stuckMs: 8 * 60_000,
  thrashRetries: 3,
  thrashWindowMs: 30_000,
  blockedMinMs: 60_000,
  heartbeatLapseMs: 60_000,
};

export type AgentHealth =
  | { kind: "running" }
  | { kind: "idle" }
  | { kind: "approval"; cmd: string }
  | { kind: "blocked"; on: string; sinceMs: number }
  | { kind: "stuck"; sinceMs: number }
  | { kind: "thrashing"; retries: number }
  | { kind: "silent"; sinceMs: number }
  | { kind: "error"; reason: string }
  | { kind: "expired" };

export interface HealthInput {
  /** Carried for caller correlation (fleet join / logging); not used by
   *  deriveAgentHealth itself. */
  readonly role: string;
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
  readonly attemptCount: number;
  readonly lastRetryAt: string | undefined;
  readonly lastOutputAt: string | undefined;
  readonly currentTask: string | undefined;
  readonly currentTaskSinceMs: number;
  readonly pendingApproval: PermissionPrompt | undefined;
  readonly blockedOn: string | undefined;
  readonly blockedSinceMs: number;
  readonly agentFailure: string | undefined;
}

/** Sort weight — lower = surfaced first. */
export function healthPriority(h: AgentHealth): number {
  switch (h.kind) {
    case "error":
      return 0;
    case "approval":
      return 1;
    case "blocked":
      return 2;
    case "stuck":
      return 3;
    case "thrashing":
      return 4;
    case "silent":
      return 5;
    case "running":
      return 6;
    case "idle":
      return 7;
    case "expired":
      return 8;
  }
}

export function deriveAgentHealth(i: HealthInput, nowMs: number, t: HealthThresholds): AgentHealth {
  if (i.agentFailure) return { kind: "error", reason: i.agentFailure };
  if (i.pendingApproval) return { kind: "approval", cmd: i.pendingApproval.command };

  const leaseMs = new Date(i.leaseExpiresAt).getTime();
  if (leaseMs <= nowMs) return { kind: "expired" };

  if (
    i.attemptCount >= t.thrashRetries &&
    i.lastRetryAt !== undefined &&
    // <= : lastRetryAt must be *within* the window, not older than it
    nowMs - new Date(i.lastRetryAt).getTime() <= t.thrashWindowMs
  ) {
    return { kind: "thrashing", retries: i.attemptCount };
  }

  if (i.blockedOn !== undefined && i.blockedSinceMs > t.blockedMinMs) {
    return { kind: "blocked", on: i.blockedOn, sinceMs: i.blockedSinceMs };
  }

  const lastOutMs = i.lastOutputAt ? new Date(i.lastOutputAt).getTime() : undefined;
  if (lastOutMs !== undefined && nowMs - lastOutMs > t.silentMs) {
    return { kind: "silent", sinceMs: nowMs - lastOutMs };
  }

  if (i.currentTask !== undefined && i.currentTaskSinceMs > t.stuckMs && lastOutMs !== undefined) {
    return { kind: "stuck", sinceMs: i.currentTaskSinceMs };
  }

  const heartMs = new Date(i.heartbeatAt).getTime();
  if (nowMs - heartMs > t.heartbeatLapseMs) {
    return { kind: "silent", sinceMs: nowMs - heartMs };
  }

  if (lastOutMs !== undefined) return { kind: "running" };
  return { kind: "idle" };
}
