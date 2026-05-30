import { PANEL_LABELS } from "../hooks/use-panel-focus.js";
import {
  formatKeySequence,
  type KeyBinding,
  type ResolvedKeymap,
  type TuiActionId,
} from "./keymap.js";

/** Non-panel TuiActionId → registry action id. */
const ACTION_ID_BY_TUI: Readonly<
  Record<Exclude<TuiActionId, "focus_panel" | "toggle_panel">, string>
> = {
  quit: "view.quit",
  help: "view.help",
  palette: "view.palette",
  refresh: "view.refresh",
  zoom_cycle: "view.zoom",
  zoom_reset: "view.zoom-reset",
  layout_toggle: "view.layout",
  view_cycle: "view.view-mode",
  cycle_panel_next: "nav.panel.next",
  cycle_panel_prev: "nav.panel.prev",
  search_start: "view.search",
  terminal_input: "nav.terminal.input",
  compare_toggle: "workflow.compare",
  artifact_prev: "artifact.prev",
  artifact_next: "artifact.next",
  artifact_diff: "artifact.diff",
  artifact_diff_mode: "artifact.diff-mode",
  approve: "workflow.approve-question",
  deny: "workflow.deny-question",
  broadcast: "agent.broadcast",
  direct_message: "agent.direct-message",
  cursor_down: "nav.cursor-down",
  cursor_up: "nav.cursor-up",
  select: "nav.select",
  page_next: "nav.page-next",
  page_prev: "nav.page-prev",
  vfs_navigate: "nav.vfs-navigate",
  terminal_scroll_up: "nav.terminal.scroll-up",
  terminal_scroll_down: "nav.terminal.scroll-down",
  terminal_scroll_bottom: "nav.terminal.scroll-bottom",
  frontier_tab_next: "nav.frontier.next-slice",
  frontier_tab_prev: "nav.frontier.prev-slice",
  frontier_adopt: "contrib.frontier-adopt",
  compare_select: "workflow.compare-select",
  compare_adopt_a: "workflow.compare-adopt-a",
  compare_adopt_b: "workflow.compare-adopt-b",
};

export function bindingToActionId(binding: KeyBinding): string {
  if (binding.action === "focus_panel" || binding.action === "toggle_panel") {
    const label = PANEL_LABELS[binding.panel];
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `nav.panel.${key}`; // matches navigationActions() id derivation
  }
  return ACTION_ID_BY_TUI[binding.action];
}

/** id → human keybind label, first-writer-wins on duplicate ids. */
export function resolvedKeymapBindings(keymap: ResolvedKeymap): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const binding of keymap.bindings) {
    if (!binding.preferred) continue;
    const id = bindingToActionId(binding);
    if (!map.has(id)) map.set(id, formatKeySequence(binding.sequence));
  }
  return map;
}
