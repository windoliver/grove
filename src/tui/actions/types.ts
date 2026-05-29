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
  | "Prompts"
  | "Skills"
  | "Plugins";

/** Fixed display order for groups when no query is active. */
export const GROUP_ORDER: readonly ActionGroup[] = [
  "Navigation",
  "Agents",
  "Workflow",
  "View",
  "Contributions",
  "Prompts",
  "Skills",
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
  /** CID of the highlighted contribution (cursor row), or the open detail. */
  readonly selectedCid?: string | undefined;
  /** CID of the currently-open detail view, if any (distinct from selectedCid). */
  readonly detailCid?: string | undefined;
  readonly parentAgentId?: string | undefined;
  readonly pendingQuestionCount: number;
  /** CID of the sole pending question (only when exactly one) — pins approve/deny. */
  readonly pendingQuestionCid?: string | undefined;
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
  readonly cyclePanelNext: () => void;
  readonly cyclePanelPrev: () => void;
  readonly openContribution: (cid: string) => void;
  readonly jumpToSession: (session: string) => void;
  readonly enterGoalMode: () => void;
  readonly enterCompareMode: () => void;
  readonly addToCompare: (cid: string) => void;
  /** Begin adopting a contribution; the summary is resolved from the cid. */
  readonly adoptContribution: (cid: string) => void;
  readonly answerPendingQuestion: (verdict: "approve" | "deny", expectedCid?: string) => void;
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
  readonly showHelp: () => void;
  readonly quit: () => void;
  // Focused-panel-sensitive
  readonly nextFrontierSlice: () => void;
  readonly prevFrontierSlice: () => void;
  readonly scrollTerminalToBottom: () => void;
  readonly showMessage: (message: string) => void;

  // Keymap-migrated capabilities (#275)
  readonly enterTerminalInput: () => void;
  readonly artifactPrev: () => void;
  readonly artifactNext: () => void;
  readonly artifactDiffToggle: () => void;
  readonly artifactDiffModeToggle: () => void;
  readonly cursorDown: () => void;
  readonly cursorUp: () => void;
  readonly selectRow: () => void;
  readonly pageNext: () => void;
  readonly pagePrev: () => void;
  readonly vfsNavigate: () => void;
  readonly terminalScrollUp: () => void;
  readonly terminalScrollDown: () => void;
  readonly compareSelect: () => void;
  readonly compareAdoptA: () => void;
  readonly compareAdoptB: () => void;
  readonly frontierAdopt: () => void;
  readonly openPalette: () => void;
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
  /** Slash trigger, e.g. "/cancel". Source of truth for the slash surfaces. */
  readonly slash?: string | undefined;
  /** Palette shows suggested actions first when the filter is empty. */
  readonly suggested?: boolean | undefined;
  /** Filled by the registry from the resolved keymap — never authored here. */
  readonly keybind?: string | undefined;
  /** Relevance gate. False → item is HIDDEN entirely. Default: visible. */
  readonly available?: ((ctx: ActionContext) => boolean) | undefined;
  /** Capability gate. boolean OR { enabled, reason } for a greyed footer note. */
  readonly enabled?:
    | ((ctx: ActionContext) => boolean | { enabled: boolean; reason?: string })
    | undefined;
  readonly run: (ctx: ActionContext, args?: readonly string[]) => void | Promise<void>;
}

/** Normalize the boolean | object `enabled` union to a single shape. */
export function resolveEnabled(
  action: Action,
  ctx: ActionContext,
): { enabled: boolean; reason?: string } {
  const result = action.enabled?.(ctx);
  if (result === undefined) return { enabled: true };
  if (typeof result === "boolean") return { enabled: result };
  return result;
}

/** A dynamic source of actions resolved at invocation time. */
export type DynamicSource = (ctx: ActionContext) => readonly Action[];
