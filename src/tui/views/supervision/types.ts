// src/tui/views/supervision/types.ts
/**
 * Type surface for the Supervision screen. See:
 *   docs/superpowers/specs/2026-05-15-tui-supervision-hero-design.md
 */

export type AgentState =
  | "running"
  | "silent"
  | "stuck"
  | "blocked"
  | "thrashing"
  | "awaiting"
  | "done"
  | "idle";

export type DrillTab = "feed" | "dag" | "term";

export interface PendingApproval {
  readonly agentId: string;
  readonly requestId: string;
  readonly kind: "tmux-permission" | "contract-decision" | "handoff-reroute";
  readonly prompt: string;
  readonly fullBody: string;
  readonly requestedAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SupervisedAgent {
  readonly agentId: string;
  readonly agentName?: string;
  readonly role: string;
  readonly platform: string;
  readonly state: AgentState;
  readonly stateReason: string;
  readonly lastActionAt: number;
  readonly currentTask?: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly contextPercent?: number;
  readonly sessionName?: string;
  readonly pendingApproval?: PendingApproval;
  readonly contribCount: number;
  /** True when costUsd/min over the last minute exceeded the spike threshold. */
  readonly costSpike: boolean;
  /** True when contextPercent >= contextPctCritical. */
  readonly contextHot: boolean;
}

export interface FleetSummary {
  readonly total: number;
  readonly byState: Readonly<Record<AgentState, number>>;
  readonly approvalsPending: number;
  readonly costUsd: number;
  readonly costHot: number;
  readonly contextHot: number;
}
