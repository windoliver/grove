import type { Panel as PanelValue } from "../hooks/use-panel-focus.js";
import defaultKeymapRaw from "../keymaps/default.json" with { type: "json" };
import powerUserKeymapRaw from "../keymaps/power-user.json" with { type: "json" };
import { BUILT_IN_PANEL_IDS, type BuiltInPanelId, idToPanel } from "../panels/panel-ids.js";

export type KeymapPresetName = "default" | "power-user";

export type KeyToken = string;
export type KeySequence = readonly KeyToken[];
export type KeymapLayer = "normal" | "leader" | "panel";
export type KeySequenceMatch = "exact" | "prefix" | "none";

export type PanelKeymapId = BuiltInPanelId;

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

export const NON_PANEL_TARGET_ACTION_IDS: readonly NonPanelTargetActionId[] = [
  "quit",
  "help",
  "palette",
  "refresh",
  "zoom_cycle",
  "zoom_reset",
  "layout_toggle",
  "view_cycle",
  "cycle_panel_next",
  "cycle_panel_prev",
  "search_start",
  "terminal_input",
  "compare_toggle",
  "artifact_prev",
  "artifact_next",
  "artifact_diff",
  "approve",
  "deny",
  "broadcast",
  "direct_message",
  "cursor_down",
  "cursor_up",
  "select",
  "page_next",
  "page_prev",
  "vfs_navigate",
  "terminal_scroll_up",
  "terminal_scroll_down",
  "terminal_scroll_bottom",
  "frontier_tab_next",
  "frontier_tab_prev",
  "frontier_adopt",
  "compare_select",
  "compare_adopt_a",
  "compare_adopt_b",
] as const;

export const KEY_BINDING_IDS: readonly KeyBindingId[] = Object.freeze([
  ...NON_PANEL_TARGET_ACTION_IDS,
  ...BUILT_IN_PANEL_IDS.flatMap((panelId) => [
    `focus_panel:${panelId}` as const,
    `toggle_panel:${panelId}` as const,
  ]),
]) as readonly KeyBindingId[];

const KEY_BINDING_ID_SET: ReadonlySet<string> = new Set(KEY_BINDING_IDS);

export function isKeyBindingId(id: string): id is KeyBindingId {
  return KEY_BINDING_ID_SET.has(id);
}

function isPanelTargetBindingId(id: KeyBindingId): id is PanelTargetBindingId {
  return id.startsWith("focus_panel:") || id.startsWith("toggle_panel:");
}

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

export type KeymapOverrides = Readonly<Record<string, string>>;

interface RawKeyBinding {
  readonly id: string;
  readonly action: TuiActionId;
  readonly sequence: string | readonly string[];
  readonly label: string;
  readonly context: KeyBindingContext;
  readonly layer: KeymapLayer;
  readonly panel?: string | undefined;
  readonly preferred?: boolean | undefined;
}

interface RawBuiltinKeymap {
  readonly extends?: KeymapPresetName | undefined;
  readonly bindings: readonly RawKeyBinding[];
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

const PANEL_KEYMAP_IDS: ReadonlySet<string> = new Set(BUILT_IN_PANEL_IDS);

function isPanelKeymapId(id: string): id is PanelKeymapId {
  return PANEL_KEYMAP_IDS.has(id);
}

function panelForKeymapId(id: PanelKeymapId): PanelValue {
  const panel = idToPanel(id);
  if (panel === undefined) throw new Error(`Unknown built-in panel id: ${id}`);
  return panel;
}

export const PANEL_BY_KEYMAP_ID: Readonly<Record<PanelKeymapId, PanelValue>> = Object.freeze(
  Object.fromEntries(BUILT_IN_PANEL_IDS.map((id) => [id, panelForKeymapId(id)])) as Record<
    PanelKeymapId,
    PanelValue
  >,
);

const BUILTIN_KEYMAPS: Readonly<Record<KeymapPresetName, RawBuiltinKeymap>> = {
  default: defaultKeymapRaw as RawBuiltinKeymap,
  "power-user": powerUserKeymapRaw as RawBuiltinKeymap,
};

const EMPTY_KEYMAP_CONFLICTS: readonly KeymapConflict[] = Object.freeze([]);

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

function rawBindingsForPreset(preset: KeymapPresetName): readonly RawKeyBinding[] {
  const raw = BUILTIN_KEYMAPS[preset];
  if (raw.extends === undefined) return raw.bindings;
  return [...rawBindingsForPreset(raw.extends), ...raw.bindings];
}

function resolveRawPanel(raw: RawKeyBinding): PanelValue | undefined {
  const panelId = raw.panel;
  if (panelId === undefined) return undefined;
  if (!isPanelKeymapId(panelId)) {
    throw new Error(`Key binding "${raw.id}" references unknown panel id "${panelId}"`);
  }
  return PANEL_BY_KEYMAP_ID[panelId];
}

function resolvePanelTargetBinding(
  raw: RawKeyBinding,
  action: PanelTargetActionId,
): PanelTargetKeyBinding {
  const panelId = raw.panel;
  if (panelId === undefined) {
    throw new Error(`Panel target key binding "${raw.id}" is missing a panel`);
  }
  if (!isPanelKeymapId(panelId)) {
    throw new Error(`Panel target key binding "${raw.id}" references unknown panel "${panelId}"`);
  }

  const id = `${action}:${panelId}` as PanelTargetBindingId;
  if (raw.id !== id) {
    throw new Error(`Panel target key binding "${raw.id}" must use id "${id}"`);
  }

  return Object.freeze({
    id,
    action,
    sequence: createKeySequence(raw.sequence),
    label: raw.label,
    context: raw.context,
    layer: raw.layer,
    panel: PANEL_BY_KEYMAP_ID[panelId],
    preferred: raw.preferred ?? true,
  });
}

function resolveActionBinding(
  raw: RawKeyBinding,
  action: NonPanelTargetActionId,
): ActionKeyBinding {
  if (raw.id !== action) {
    throw new Error(`Key binding "${raw.id}" must match non-panel action "${action}"`);
  }

  const panel = resolveRawPanel(raw);
  const binding = {
    id: action,
    action,
    sequence: createKeySequence(raw.sequence),
    label: raw.label,
    context: raw.context,
    layer: raw.layer,
    preferred: raw.preferred ?? true,
    ...(panel === undefined ? {} : { panel }),
  };
  return Object.freeze(binding);
}

function resolveRawBinding(raw: RawKeyBinding): KeyBinding {
  if (raw.action === "focus_panel" || raw.action === "toggle_panel") {
    return resolvePanelTargetBinding(raw, raw.action);
  }
  return resolveActionBinding(raw, raw.action);
}

export function resolveBuiltinKeymap(preset: KeymapPresetName): ResolvedKeymap {
  return Object.freeze({
    preset,
    bindings: Object.freeze(rawBindingsForPreset(preset).map(resolveRawBinding)),
    conflicts: EMPTY_KEYMAP_CONFLICTS,
  });
}

function actionFromBindingId(id: KeyBindingId): TuiActionId {
  if (id.startsWith("focus_panel:")) return "focus_panel";
  if (id.startsWith("toggle_panel:")) return "toggle_panel";
  return id as NonPanelTargetActionId;
}

function panelFromBindingId(id: KeyBindingId): PanelValue | undefined {
  const [, rawPanelId] = id.split(":");
  if (rawPanelId === undefined || !isPanelKeymapId(rawPanelId)) return undefined;
  return PANEL_BY_KEYMAP_ID[rawPanelId];
}

function findTemplateBinding(
  id: KeyBindingId,
  bindings: readonly KeyBinding[],
): KeyBinding | undefined {
  return bindings.find((binding) => binding.id === id);
}

function conflictScope(binding: KeyBinding): string {
  return binding.layer === "panel" ? `${binding.layer}:${binding.panel ?? ""}` : binding.layer;
}

function conflictKey(binding: KeyBinding): string {
  return `${conflictScope(binding)}:${binding.sequence.join("\u0000")}`;
}

function bindingsConflict(a: KeyBinding, b: KeyBinding): boolean {
  return (
    conflictScope(a) === conflictScope(b) &&
    (sequenceStartsWith(a.sequence, b.sequence) || sequenceStartsWith(b.sequence, a.sequence))
  );
}

function dedupeConflicts(bindings: readonly KeyBinding[]): {
  readonly bindings: readonly KeyBinding[];
  readonly conflicts: readonly KeymapConflict[];
} {
  const seen = new Map<string, KeyBinding>();
  const kept: KeyBinding[] = [];
  const conflicts: KeymapConflict[] = [];
  for (const binding of bindings) {
    const key = conflictKey(binding);
    const winner = seen.get(key) ?? kept.find((candidate) => bindingsConflict(candidate, binding));
    if (winner !== undefined) {
      conflicts.push({
        sequence: binding.sequence,
        winner: winner.id,
        loser: binding.id,
      });
      continue;
    }
    seen.set(key, binding);
    kept.push(binding);
  }
  return { bindings: Object.freeze(kept), conflicts: Object.freeze(conflicts) };
}

function resolveOverrideBinding(
  id: KeyBindingId,
  sequence: string,
  base: readonly KeyBinding[],
): KeyBinding {
  const action = actionFromBindingId(id);
  const template = findTemplateBinding(id, base);
  const common = {
    sequence: createKeySequence(sequence),
    label: template?.label ?? id,
    context: template?.context ?? "global",
    layer: template?.layer ?? "normal",
    preferred: true,
  };

  if (isPanelTargetBindingId(id)) {
    const targetAction: PanelTargetActionId = id.startsWith("focus_panel:")
      ? "focus_panel"
      : "toggle_panel";
    const panel = panelFromBindingId(id);
    if (panel === undefined) {
      throw new Error(`Panel target key binding "${id}" is missing a valid panel`);
    }
    return Object.freeze({
      id,
      action: targetAction,
      ...common,
      panel,
    });
  }

  const panel = template?.panel;
  const nonPanelAction = action as NonPanelTargetActionId;
  return Object.freeze({
    id,
    action: nonPanelAction,
    ...common,
    ...(panel === undefined ? {} : { panel }),
  });
}

export function resolveKeymapWithOverrides(
  preset: KeymapPresetName,
  overrides: KeymapOverrides,
): ResolvedKeymap {
  const base = resolveBuiltinKeymap(preset).bindings;
  const validOverrideIds = Object.keys(overrides).filter(isKeyBindingId);
  const overriddenIds = new Set<KeyBindingId>(validOverrideIds);
  const retained = base.filter((binding) => !overriddenIds.has(binding.id));
  const overrideBindings = validOverrideIds.map((id) =>
    resolveOverrideBinding(id, overrides[id] ?? "", base),
  );
  const deduped = dedupeConflicts([...retained, ...overrideBindings]);

  return Object.freeze({
    preset,
    bindings: deduped.bindings,
    conflicts: deduped.conflicts,
  });
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
