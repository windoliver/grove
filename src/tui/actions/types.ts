import type { Claim } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import type { Panel } from "../hooks/use-panel-focus.js";

/** Top-level grouping for palette actions. */
export type ActionGroup =
  | "Navigation"
  | "Agents"
  | "Workflow"
  | "View"
  | "Contributions"
  | "Plugins";

/** Fixed display order for groups when no query is active. */
export const GROUP_ORDER: readonly ActionGroup[] = [
  "Navigation",
  "Agents",
  "Workflow",
  "View",
  "Contributions",
  "Plugins",
];

/** An agent profile loaded from .grove/agents.json. */
export interface LoadedProfile {
  readonly name: string;
  readonly role: string;
  readonly platform: string;
  readonly command?: string | undefined;
}

/** A gossip peer with free agent capacity. */
export interface GossipPeerSlot {
  readonly peerId: string;
  readonly address: string;
  readonly freeSlots: number;
}

/**
 * Rich, internal context handed to built-in actions. Holds read-only state for
 * enumeration/gating plus imperative capabilities closed over app machinery.
 * Plugins never see this — see `plugin-adapter.ts`.
 */
export interface ActionContext {
  // --- read state ---
  readonly topology?: AgentTopology | undefined;
  readonly sessions: readonly string[];
  readonly profiles: readonly LoadedProfile[];
  readonly gossipPeers: readonly GossipPeerSlot[];
  /** Active claims, or null when scoped session can't see them. */
  readonly claims: readonly Claim[] | null;
  readonly selectedSession?: string | undefined;
  readonly selectedCid?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly pendingQuestionCount: number;
  readonly hasGoals: boolean;
  readonly canSpawn: boolean;
  readonly canDelegate: boolean;
  readonly isPanelVisible: (panel: Panel) => boolean;
  /** Currently focused panel — drives focused-panel-sensitive actions. */
  readonly focusedPanel: Panel;
  /** Number of frontier slice tabs — frontier-slice nav needs more than one. */
  readonly frontierSliceCount: number;

  // --- capabilities ---
  readonly focusPanel: (panel: Panel) => void;
  readonly togglePanel: (panel: Panel) => void;
  readonly openContribution: (cid: string) => void;
  readonly jumpToSession: (session: string) => void;
  readonly enterGoalMode: () => void;
  readonly enterCompareMode: () => void;
  readonly addToCompare: (cid: string) => void;
  readonly adoptContribution: (cid: string, summary: string) => void;
  readonly answerPendingQuestion: (verdict: "approve" | "deny") => void;
  readonly registerAgentProfile: () => void;
  readonly spawn: (roleId: string, command: string, parentAgentId?: string) => void;
  readonly kill: (session: string) => void;
  readonly delegate: (peerAddress: string) => void;
  // Messaging
  readonly broadcastMessage: () => void;
  readonly directMessage: () => void;
  // View / system
  readonly refresh: () => void;
  readonly enterSearch: () => void;
  readonly cycleZoom: () => void;
  readonly resetZoom: () => void;
  readonly toggleLayout: () => void;
  readonly cycleViewMode: () => void;
  readonly quit: () => void;
  // Focused-panel-sensitive
  readonly nextFrontierSlice: () => void;
  readonly prevFrontierSlice: () => void;
  readonly scrollTerminalToBottom: () => void;
  readonly showMessage: (message: string) => void;
}

/** A single unified palette action. */
export interface Action {
  /** Stable, unique id, e.g. "nav.panel.terminal", "agent.spawn.reviewer". */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: ActionGroup;
  /** Extra fuzzy-match terms beyond the label. */
  readonly keywords?: readonly string[] | undefined;
  /** Relevance gate. False → item is HIDDEN entirely. Default: visible. */
  readonly available?: ((ctx: ActionContext) => boolean) | undefined;
  /** Capability gate. False → item shown but GREYED and not executable. */
  readonly enabled?: ((ctx: ActionContext) => boolean) | undefined;
  readonly run: (ctx: ActionContext) => void | Promise<void>;
}
