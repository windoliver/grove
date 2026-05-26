import { Panel, type Panel as PanelValue } from "../hooks/use-panel-focus.js";

export type KeymapPresetName = "default" | "power-user";

export type KeyToken = string;
export type KeySequence = readonly KeyToken[];
export type KeymapLayer = "normal" | "leader" | "panel";
export type KeySequenceMatch = "exact" | "prefix" | "none";

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
  | "direct_message"
  | "cursor_down"
  | "cursor_up"
  | "select"
  | "page_next"
  | "page_prev"
  | "vfs_navigate"
  | "terminal_scroll_up"
  | "terminal_scroll_down"
  | "terminal_scroll_bottom"
  | "frontier_tab_next"
  | "frontier_tab_prev"
  | "frontier_adopt"
  | "compare_select"
  | "compare_adopt_a"
  | "compare_adopt_b";

export type PanelTargetActionId = "focus_panel" | "toggle_panel";
export type NonPanelTargetActionId = Exclude<TuiActionId, PanelTargetActionId>;
export type PanelTargetBindingId = `focus_panel:${PanelKeymapId}` | `toggle_panel:${PanelKeymapId}`;
export type KeyBindingId = NonPanelTargetActionId | PanelTargetBindingId;

export type KeyBindingContext = "global" | "navigation" | "panel" | "messaging";

interface KeyBindingBase {
  readonly id: KeyBindingId;
  readonly action: TuiActionId;
  readonly sequence: KeySequence;
  readonly label: string;
  readonly context: KeyBindingContext;
  readonly layer: KeymapLayer;
  readonly panel?: PanelValue | undefined;
  readonly preferred: boolean;
}

export interface ActionKeyBinding extends KeyBindingBase {
  readonly id: NonPanelTargetActionId;
  readonly action: NonPanelTargetActionId;
}

export interface PanelTargetKeyBinding extends Omit<KeyBindingBase, "id" | "action" | "panel"> {
  readonly id: PanelTargetBindingId;
  readonly action: PanelTargetActionId;
  readonly panel: PanelValue;
}

export type KeyBinding = ActionKeyBinding | PanelTargetKeyBinding;

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
  | { readonly kind: "pending"; readonly prefix: KeySequence }
  | { readonly kind: "match"; readonly binding: KeyBinding }
  | { readonly kind: "miss" };

export type KeyDispatchResult = KeymapResolution;

export interface KeyTokenEvent {
  readonly name?: string | undefined;
  readonly sequence?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly shift?: boolean | undefined;
}

export interface KeymapResolveOptions {
  readonly focusedPanel?: PanelValue | undefined;
}

export const PANEL_BY_KEYMAP_ID: Readonly<Record<PanelKeymapId, PanelValue>> = {
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
  "shift+tab": "Shift+Tab",
};

const SHIFTED_PRINTABLE_BY_NAME: Readonly<Record<string, string>> = {
  "/": "?",
  "=": "+",
  v: "V",
  z: "Z",
  g: "G",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "`": "~",
};

export function normalizeKeyToken(token: string): KeyToken {
  const trimmed = token.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "space") return "space";
  if (lower === "esc" || lower === "escape") return "escape";
  if (lower === "enter" || lower === "return") return "return";
  if (lower === "tab") return "tab";
  if (lower === "shift+tab") return "shift+tab";
  if (lower.startsWith("ctrl+")) return `ctrl+${lower.slice("ctrl+".length)}`;
  return trimmed;
}

export function createKeySequence(sequence: string | readonly string[]): KeySequence {
  const source =
    typeof sequence === "string"
      ? sequence
          .trim()
          .split(/\s+/)
          .filter((token) => token.length > 0)
      : sequence;
  const tokens = source.map(normalizeKeyToken);
  return Object.freeze(tokens);
}

export function normalizeKeySequence(sequence: string | readonly string[]): KeySequence {
  return createKeySequence(sequence);
}

export function parseKeySequence(sequence: string): KeySequence {
  return createKeySequence(sequence);
}

export function formatKeySequence(sequence: KeySequence): string {
  return sequence
    .map((token) => {
      if (token.startsWith("ctrl+")) return `Ctrl+${token.slice("ctrl+".length).toUpperCase()}`;
      return DISPLAY_BY_TOKEN[token] ?? token;
    })
    .join(" ");
}

export function keyEventToToken(event: KeyTokenEvent): KeyToken | undefined {
  const name = event.name;
  const sequence = event.sequence;
  const ctrlName = name ?? sequence;
  if (event.ctrl === true && ctrlName !== undefined) return `ctrl+${ctrlName.toLowerCase()}`;
  if (event.shift === true && name === "tab") return "shift+tab";
  if (sequence === " ") return "space";
  if (sequence !== undefined && sequence.length === 1 && event.meta !== true) {
    return normalizeKeyToken(sequence);
  }
  if (!name) return undefined;
  if (event.shift === true) return SHIFTED_PRINTABLE_BY_NAME[name] ?? normalizeKeyToken(name);
  return normalizeKeyToken(name);
}

function sequenceEquals(a: KeySequence, b: KeySequence): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function sequenceStartsWith(sequence: KeySequence, prefix: KeySequence): boolean {
  return prefix.every((token, index) => sequence[index] === token);
}

export function matchesKeySequence(sequence: KeySequence, prefix: KeySequence): KeySequenceMatch {
  if (!sequenceStartsWith(sequence, prefix)) return "none";
  return sequence.length === prefix.length ? "exact" : "prefix";
}

function bindingApplies(binding: KeyBinding, options: KeymapResolveOptions): boolean {
  if (binding.layer !== "panel") return true;
  return options.focusedPanel !== undefined && binding.panel === options.focusedPanel;
}

function findExactBinding(
  bindings: readonly KeyBinding[],
  prefix: KeySequence,
  options: KeymapResolveOptions,
): KeyBinding | undefined {
  const exact = bindings.filter(
    (binding) => bindingApplies(binding, options) && sequenceEquals(binding.sequence, prefix),
  );
  return exact.find((binding) => binding.layer === "panel") ?? exact[0];
}

export function resolveKeyBinding(
  bindings: readonly KeyBinding[],
  prefix: KeySequence,
  options: KeymapResolveOptions = {},
): KeyDispatchResult {
  const exact = findExactBinding(bindings, prefix, options);
  if (exact !== undefined) return { kind: "match", binding: exact };
  const hasChild = bindings.some(
    (binding) =>
      bindingApplies(binding, options) &&
      binding.sequence.length > prefix.length &&
      sequenceStartsWith(binding.sequence, prefix),
  );
  if (hasChild) return { kind: "pending", prefix: Object.freeze([...prefix]) };
  return { kind: "miss" };
}

export function resolveKeySequence(
  bindings: readonly KeyBinding[],
  prefix: KeySequence,
  options: KeymapResolveOptions = {},
): KeymapResolution {
  return resolveKeyBinding(bindings, prefix, options);
}
