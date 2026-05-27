/**
 * Status bar component shown at the bottom of the TUI.
 *
 * Displays context-sensitive keyboard shortcuts based on the focused panel,
 * current input mode, agent count, and session cost.
 */

import React from "react";
import { type InputMode, Panel, type ViewMode } from "../hooks/use-panel-focus.js";
import {
  formatKeySequence,
  type KeyBinding,
  type KeySequence,
  type ResolvedKeymap,
  type TuiActionId,
} from "../keymap/keymap.js";
import { theme } from "../theme.js";

/** Which top-level screen the user is on — shown in status bar for orientation. */
export type ScreenContext = "running" | "inspect";

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Current input mode. */
  readonly mode: InputMode;
  /** Which top-level screen is active (session vs. inspect overlay). */
  readonly screenContext?: ScreenContext | undefined;
  /** Whether we're in a detail view within a panel. */
  readonly isDetailView?: boolean | undefined;
  /** Error message to display, if any. */
  readonly error?: string | undefined;
  /** Session cost label (e.g. "$1.23 / 45k tokens"), shown on the right when available. */
  readonly costLabel?: string | undefined;
  /** Currently focused panel for context-sensitive hints. */
  readonly focusedPanel?: Panel | undefined;
  /** Number of active agents. */
  readonly agentCount?: number | undefined;
  /** Current view mode (grid or pipeline). */
  readonly viewMode?: ViewMode | undefined;
  /** Current goal text to display in the status bar. */
  readonly goalLabel?: string | undefined;
  /** Resolved active keymap for compact keybinding hints. */
  readonly resolvedKeymap?: ResolvedKeymap | undefined;
  /** Pending keymap prefix, if the user is entering a leader sequence. */
  readonly keymapPrefix?: readonly string[] | undefined;
}

/** Mode labels for the status bar. */
const MODE_LABELS: Record<InputMode, string> = {
  normal: "NORMAL",
  terminal_input: "TERMINAL",
  command_palette: "CMD",
  search_input: "SEARCH",
  message_input: "MESSAGE",
  goal_input: "GOAL",
  help: "HELP",
};

/** Context-sensitive keybinding hints per panel. */
function panelHints(panel: Panel | undefined, isDetailView: boolean | undefined): string {
  if (isDetailView) return " Esc:back  j/k:scroll  r:refresh  ?:help  q:quit";

  // Panel-specific hints — use Panel enum constants (never magic numbers)
  switch (panel) {
    case Panel.Terminal:
      return " i:input  Esc:exit  j/k:scroll  Tab:cycle  ?:help  q:quit";
    case Panel.Frontier:
      return " C:compare  j/k:nav  Enter:detail  +/Esc:zoom  ?:help  q:quit";
    case Panel.Artifact:
      return " h/l:cycle  d:diff  j/k:scroll  +/Esc:zoom  ?:help  q:quit";
    case Panel.Search:
      return " /:search  j/k:nav  Enter:detail  ?:help  q:quit";
    case Panel.Vfs:
      return " j/k:nav  Enter:browse  Esc:back  ?:help  q:quit";
    case Panel.Decisions:
      return " a:approve  d:deny  j/k:nav  ?:help  q:quit";
    case Panel.Inbox:
      return " b:broadcast  @:direct  j/k:nav  ?:help  q:quit";
    default:
      return " panel keys:focus/toggle  Tab:cycle  j/k:nav  Enter:select  Ctrl+P:spawn  +/Esc:zoom  ?:help  q:quit";
  }
}

function joinHints(hints: readonly (string | undefined)[]): string {
  return hints.filter((hint) => hint !== undefined && hint.length > 0).join("  ");
}

function compactBinding(bindings: readonly KeyBinding[]): KeyBinding | undefined {
  return [...bindings].sort((a, b) => compactScore(a) - compactScore(b))[0];
}

function compactScore(binding: KeyBinding): number {
  const layerScore = binding.layer === "normal" ? 0 : binding.layer === "leader" ? 20 : 10;
  const preferredScore = binding.preferred ? 0 : 5;
  return layerScore + preferredScore + binding.sequence.length;
}

function bindingKey(binding: KeyBinding | undefined, fallback?: string): string | undefined {
  if (binding === undefined) return fallback;
  return formatKeySequence(binding.sequence);
}

function actionKey(
  keymap: ResolvedKeymap,
  action: TuiActionId,
  fallback?: string,
): string | undefined {
  return bindingKey(
    compactBinding(keymap.bindings.filter((binding) => binding.action === action)),
    fallback,
  );
}

function panelKey(keymap: ResolvedKeymap, panel: Panel | undefined): string | undefined {
  if (panel === undefined) return undefined;
  return bindingKey(
    compactBinding(
      keymap.bindings.filter(
        (binding) =>
          binding.context === "panel" &&
          binding.panel === panel &&
          (binding.action === "focus_panel" || binding.action === "toggle_panel"),
      ),
    ),
  );
}

function actionPair(
  keymap: ResolvedKeymap,
  first: TuiActionId,
  second: TuiActionId,
  fallback?: string,
): string | undefined {
  const firstKey = actionKey(keymap, first);
  const secondKey = actionKey(keymap, second);
  if (firstKey === undefined || secondKey === undefined) return fallback;
  return `${firstKey}/${secondKey}`;
}

function leaderKey(keymap: ResolvedKeymap): string | undefined {
  const leaderBinding = keymap.bindings.find(
    (binding) => binding.layer === "leader" && binding.sequence.length > 0,
  );
  if (leaderBinding === undefined) return undefined;
  return formatKeySequence([leaderBinding.sequence[0]] as KeySequence);
}

function keymapHints(
  keymap: ResolvedKeymap,
  panel: Panel | undefined,
  isDetailView: boolean | undefined,
  keymapPrefix: readonly string[] | undefined,
): string {
  if (keymapPrefix !== undefined && keymapPrefix.length > 0) {
    return joinHints([`${formatKeySequence(keymapPrefix)} ...`, "Esc:cancel"]);
  }

  const help = actionKey(keymap, "help", "?");
  const nav = actionPair(keymap, "cursor_down", "cursor_up", "j/k");
  const panelSwitch = panelKey(keymap, panel);

  if (isDetailView) {
    return joinHints([
      "Esc:back",
      `${nav}:scroll`,
      `${actionKey(keymap, "refresh", "r")}:refresh`,
      `${help}:help`,
    ]);
  }

  switch (panel) {
    case Panel.Terminal:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionKey(keymap, "terminal_input", "i")}:input`,
        `${actionPair(keymap, "terminal_scroll_down", "terminal_scroll_up", "j/k")}:scroll`,
        `${help}:help`,
      ]);
    case Panel.Search:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionKey(keymap, "search_start", "/")}:search`,
        `${nav}:nav`,
        `${help}:help`,
      ]);
    case Panel.Frontier:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionKey(keymap, "compare_toggle", "C")}:compare`,
        `${nav}:nav`,
        `${actionKey(keymap, "select", "Enter")}:select`,
        `${help}:help`,
      ]);
    case Panel.Artifact:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionPair(keymap, "artifact_prev", "artifact_next", "h/l")}:cycle`,
        `${actionKey(keymap, "artifact_diff", "d")}:diff`,
        `${help}:help`,
      ]);
    case Panel.Vfs:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${nav}:nav`,
        `${actionKey(keymap, "vfs_navigate", "Enter")}:browse`,
        `${help}:help`,
      ]);
    case Panel.Decisions:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionKey(keymap, "approve", "a")}:approve`,
        `${actionKey(keymap, "deny", "d")}:deny`,
        `${nav}:nav`,
        `${help}:help`,
      ]);
    case Panel.Inbox:
      return joinHints([
        panelSwitch === undefined ? undefined : `${panelSwitch}:panel`,
        `${actionKey(keymap, "broadcast", "b")}:broadcast`,
        `${actionKey(keymap, "direct_message", "@")}:direct`,
        `${nav}:nav`,
        `${help}:help`,
      ]);
    default:
      return joinHints([
        leaderKey(keymap) === undefined ? undefined : `${leaderKey(keymap)}:leader`,
        `${actionKey(keymap, "cycle_panel_next", "Tab")}:cycle`,
        `${nav}:nav`,
        `${actionKey(keymap, "select", "Enter")}:select`,
        `${help}:help`,
      ]);
  }
}

/** Screen context labels for the status bar. */
const SCREEN_CONTEXT_LABELS: Record<ScreenContext, string> = {
  running: "RUNNING",
  inspect: "INSPECT",
};

/** Bottom status bar with context-sensitive keybinding hints. */
export const StatusBar: React.NamedExoticComponent<StatusBarProps> = React.memo(function StatusBar({
  mode,
  screenContext,
  isDetailView,
  error,
  costLabel,
  focusedPanel,
  agentCount,
  viewMode,
  goalLabel,
  resolvedKeymap,
  keymapPrefix,
}: StatusBarProps): React.ReactNode {
  const modeLabel = MODE_LABELS[mode];
  const hints =
    resolvedKeymap === undefined
      ? panelHints(focusedPanel, isDetailView)
      : keymapHints(resolvedKeymap, focusedPanel, isDetailView, keymapPrefix);
  const agentLabel =
    agentCount !== undefined && agentCount > 0 ? `${String(agentCount)} agents` : undefined;

  return (
    <box flexDirection="column">
      {goalLabel && (
        <box>
          <text color={theme.secondary}>Goal: {goalLabel}</text>
        </box>
      )}
      {error && (
        <box>
          <text color={theme.error}>Error: {error}</text>
        </box>
      )}
      <box flexDirection="row">
        <text color={theme.focus}>[{modeLabel}]</text>
        {screenContext && (
          <text color={theme.secondary}> [{SCREEN_CONTEXT_LABELS[screenContext]}]</text>
        )}
        {viewMode === "pipeline" && <text color={theme.warning}> [PIPELINE]</text>}
        <text opacity={0.5}>{hints}</text>
        {agentLabel && (
          <text color={theme.secondary}>
            {"  "}
            {agentLabel}
          </text>
        )}
        {costLabel && (
          <text color={theme.secondary}>
            {"  "}
            {costLabel}
          </text>
        )}
      </box>
    </box>
  );
});
