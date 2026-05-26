import { Panel } from "../hooks/use-panel-focus.js";

export type KeymapPresetName = "default" | "power-user";

export type PanelKeymapId =
  | "dag"
  | "detail"
  | "frontier"
  | "claims"
  | "agents"
  | "terminal"
  | "artifact"
  | "vfs"
  | "activity"
  | "search"
  | "threads"
  | "outcomes"
  | "bounties"
  | "gossip"
  | "inbox"
  | "decisions"
  | "github"
  | "plan";

export type TuiActionId =
  | "quit"
  | "help"
  | "palette"
  | "refresh"
  | "zoom_cycle"
  | "zoom_reset"
  | "layout_toggle"
  | "view_cycle"
  | "focus_panel"
  | "toggle_panel"
  | "cycle_panel_next"
  | "cycle_panel_prev"
  | "search_start"
  | "terminal_input"
  | "compare_toggle"
  | "artifact_prev"
  | "artifact_next"
  | "artifact_diff"
  | "approve"
  | "deny"
  | "broadcast"
  | "direct_message";

export type KeyBindingId =
  | TuiActionId
  | `focus_panel:${PanelKeymapId}`
  | `toggle_panel:${PanelKeymapId}`;

export type KeyBindingContext = "global" | "navigation" | "panel" | "messaging";

export interface KeyBinding {
  readonly id: string;
  readonly action: TuiActionId;
  readonly sequence: readonly string[];
  readonly label: string;
  readonly context: KeyBindingContext;
  readonly panel?: Panel | undefined;
  readonly preferred: boolean;
}

export interface ResolvedKeymap {
  readonly preset: KeymapPresetName;
  readonly bindings: readonly KeyBinding[];
  readonly conflicts: readonly KeymapConflict[];
}

export interface KeymapConflict {
  readonly sequence: readonly string[];
  readonly winner: string;
  readonly loser: string;
}

export type KeymapResolution =
  | { readonly kind: "pending"; readonly prefix: readonly string[] }
  | { readonly kind: "match"; readonly binding: KeyBinding }
  | { readonly kind: "miss" };

export interface KeyTokenEvent {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
}

export const PANEL_BY_KEYMAP_ID: Readonly<Record<PanelKeymapId, Panel>> = {
  dag: Panel.Dag,
  detail: Panel.Detail,
  frontier: Panel.Frontier,
  claims: Panel.Claims,
  agents: Panel.AgentList,
  terminal: Panel.Terminal,
  artifact: Panel.Artifact,
  vfs: Panel.Vfs,
  activity: Panel.Activity,
  search: Panel.Search,
  threads: Panel.Threads,
  outcomes: Panel.Outcomes,
  bounties: Panel.Bounties,
  gossip: Panel.Gossip,
  inbox: Panel.Inbox,
  decisions: Panel.Decisions,
  github: Panel.GitHub,
  plan: Panel.Plan,
};

const DISPLAY_BY_TOKEN: Readonly<Record<string, string>> = {
  space: "Space",
  escape: "Esc",
  return: "Enter",
  tab: "Tab",
};

export function normalizeKeyToken(token: string): string {
  const trimmed = token.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "space") return "space";
  if (lower === "esc" || lower === "escape") return "escape";
  if (lower === "enter" || lower === "return") return "return";
  if (lower === "tab") return "tab";
  if (lower.startsWith("ctrl+")) return `ctrl+${lower.slice("ctrl+".length)}`;
  return trimmed;
}

export function parseKeySequence(sequence: string): readonly string[] {
  const tokens = sequence
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(normalizeKeyToken);
  return Object.freeze(tokens);
}

export function formatKeySequence(sequence: readonly string[]): string {
  return sequence
    .map((token) => {
      if (token.startsWith("ctrl+")) return `Ctrl+${token.slice("ctrl+".length).toUpperCase()}`;
      return DISPLAY_BY_TOKEN[token] ?? token;
    })
    .join(" ");
}

export function keyEventToToken(event: KeyTokenEvent): string | undefined {
  const name = event.name;
  if (!name) return undefined;
  if (event.ctrl === true) return `ctrl+${name.toLowerCase()}`;
  return normalizeKeyToken(name);
}

function sequenceEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function sequenceStartsWith(sequence: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((token, index) => sequence[index] === token);
}

export function resolveKeySequence(
  bindings: readonly KeyBinding[],
  prefix: readonly string[],
): KeymapResolution {
  const exact = bindings.find((binding) => sequenceEquals(binding.sequence, prefix));
  if (exact !== undefined) return { kind: "match", binding: exact };
  const hasChild = bindings.some(
    (binding) =>
      binding.sequence.length > prefix.length && sequenceStartsWith(binding.sequence, prefix),
  );
  if (hasChild) return { kind: "pending", prefix: Object.freeze([...prefix]) };
  return { kind: "miss" };
}
