/**
 * Extracted keyboard handler for the TUI.
 *
 * Pure routing function exported separately from the React hook
 * for testability (same pattern as use-panel-focus.ts).
 */

import type { KeyEvent } from "@opentui/core";
import type { ActionRegistry } from "../actions/registry.js";
import { type ActionContext, resolveEnabled } from "../actions/types.js";
import {
  type KeyBinding,
  keyEventToToken,
  type ResolvedKeymap,
  resolveKeySequence,
} from "../keymap/keymap.js";
import { bindingToActionId } from "../keymap/keymap-action-map.js";
import type { ZoomLevel } from "../panels/panel-manager.js";
import { PANEL_REGISTRY } from "../panels/panel-registry.js";
import { isHelpToggleKey } from "./shared-keyboard-core.js";
import type { NavigationActions } from "./use-navigation.js";
import { InputMode, Panel, type PanelFocusActions } from "./use-panel-focus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All the mutable actions the keyboard handler can trigger. */
export interface KeyboardActions {
  readonly panels: PanelFocusActions;
  readonly nav: NavigationActions;
  readonly onQuit: () => void;
  readonly onSpawnPalette: () => void;
  /** Opens the command palette pre-filtered to slash actions (Normal-mode `/`). */
  readonly onSlashPaletteOpen: () => void;
  /** Called whenever the command palette is dismissed (any path). Clears
   *  adoptContext + palette state so leftover targets don't leak into the
   *  next unrelated spawn. */
  readonly onPaletteClose: () => void;
  readonly onVfsNavigate: () => void;
  readonly onArtifactPrev: () => void;
  readonly onArtifactNext: () => void;
  readonly onArtifactDiffToggle: () => void;
  readonly onArtifactDiffModeToggle: () => void;
  readonly onCompareToggle: () => void;
  readonly onCompareSelect: (cid: string) => void;
  readonly onCompareAdopt: (side: "a" | "b") => void;
  readonly onSearchStart: () => void;
  readonly onSearchSubmit: () => void;
  readonly onSearchChar: (char: string) => void;
  readonly onSearchBackspace: () => void;
  readonly onMessageSubmit: () => void;
  readonly onMessageChar: (char: string) => void;
  readonly onMessageBackspace: () => void;
  readonly onBroadcastMode: () => void;
  readonly onDirectMessageMode: () => void;
  readonly onGoalSubmit: () => void;
  readonly onGoalChar: (char: string) => void;
  readonly onGoalBackspace: () => void;
  /** Opens the dedicated `:` slash command-line (Normal-mode `:`). */
  readonly onSlashCommandOpen: () => void;
  readonly onSlashSubmit: () => void;
  readonly onSlashChar: (char: string) => void;
  readonly onSlashBackspace: () => void;
  readonly onApproveQuestion: () => void;
  readonly onDenyQuestion: () => void;
  readonly onSendKeys: (key: string) => void;
  readonly onPaletteUp: () => void;
  readonly onPaletteDown: (maxIndex: number) => void;
  readonly onPaletteSelect: () => void;
  readonly onPaletteChar: (char: string) => void;
  readonly onPaletteBackspace: () => void;
  readonly onDetailSectionNext: () => void;
  readonly onDetailSectionPrev: () => void;
  readonly onZoomCycle: () => void;
  readonly onZoomReset: () => void;
  readonly onTerminalScrollUp: () => void;
  readonly onTerminalScrollDown: () => void;
  readonly onTerminalScrollBottom: () => void;
  readonly onLayoutToggle: () => void;
  readonly onRefresh: () => void;
  readonly onSelect: (index: number) => void;
  readonly rowCount: number;
  readonly pageSize: number;
  readonly paletteItemCount: number;
  readonly onFrontierTabNext: () => void;
  readonly onFrontierTabPrev: () => void;
  readonly onFrontierAdopt: (cid: string, summary: string) => void;
  /** Entries (cid + summary) for the currently visible frontier slice.
   *  Resolved on each call so the value reflects the latest slice nav,
   *  even if it happened in the same JS tick before React committed. */
  readonly frontierEntries: () => ReadonlyArray<{ cid: string; summary: string }>;
  readonly compareMode: boolean;
  /** Cids for the currently visible frontier slice. Function form so the
   *  keyboard handler reads the latest ref-backed value (slice nav clears
   *  the ref synchronously; state-based array would lag by a render). */
  readonly frontierCids: () => readonly string[];
  readonly selectedSession: string | undefined;
  readonly hasTmux: boolean;
  readonly resolvedKeymap?: ResolvedKeymap | undefined;
  readonly keymapPrefix?: readonly string[] | undefined;
  readonly onKeymapPrefixChange?: (prefix: readonly string[]) => void;
  /** Registry that resolves a keymap binding to an action (#275). */
  readonly registry: ActionRegistry;
  /** Context the resolved action runs against (read state + capabilities). */
  readonly actionContext: ActionContext;
  /** Reports an error thrown by an async action's run(). */
  readonly onActionError: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Pure routing function
// ---------------------------------------------------------------------------

/** Zoom level cycle: normal → half → full → normal. */
export function nextZoom(current: ZoomLevel): ZoomLevel {
  switch (current) {
    case "normal":
      return "half";
    case "half":
      return "full";
    case "full":
      return "normal";
  }
}

/**
 * Resolve a keymap binding to its registry action and run it.
 *
 * Returns true if the binding was handled. A binding is treated as UNHANDLED
 * (returns false) when:
 *   - no action is registered for its id,
 *   - the action's `available` focus gate is not met (preserving the old
 *     switch's focus-gate fall-through, e.g. artifact_next off the Artifact
 *     panel), or
 *   - the action is disabled.
 * `byId` does NOT filter by `available`, so the gate is checked here explicitly.
 */
export function dispatchKeymapBinding(
  binding: KeyBinding,
  registry: ActionRegistry,
  ctx: ActionContext,
  onError: (message: string) => void,
): boolean {
  const id = bindingToActionId(binding);
  const action = registry.byId(id, ctx);
  if (action === undefined) return false;
  if (action.available && !action.available(ctx)) return false; // focus gate not met → unhandled
  if (!resolveEnabled(action, ctx).enabled) return false;
  void Promise.resolve(action.run(ctx)).catch((e) =>
    onError(e instanceof Error ? e.message : "Action failed"),
  );
  return true;
}

/**
 * Route a key event to the appropriate action.
 *
 * Returns true if the key was handled, false otherwise.
 * This is a pure function — all side effects go through the actions object.
 */
export function routeKey(key: KeyEvent, actions: KeyboardActions): boolean {
  const input = key.name;
  const isCtrl = key.ctrl;
  const mode = actions.panels.state.mode;
  const focused = actions.panels.state.focused;
  const keymapPrefix = actions.keymapPrefix ?? [];

  // Command palette toggle (works in all modes except help). Both
  // dismissal AND opening route through onPaletteClose / onSpawnPalette
  // (which also clears adoptContext) to ensure a stale adopt target from
  // a prior 'a'-on-Frontier press cannot leak into the next spawn.
  if (isCtrl && input === "p") {
    if (mode === InputMode.CommandPalette) {
      actions.onPaletteClose();
      actions.panels.setMode(InputMode.Normal);
    } else {
      actions.onSpawnPalette();
      actions.panels.setMode(InputMode.CommandPalette);
    }
    return true;
  }

  // Escape: one effect per keypress, highest-priority first.
  // Priority: (1) exit mode → (2) pop detail → (3) reset zoom
  if (input === "escape") {
    if (mode === InputMode.Normal && keymapPrefix.length > 0) {
      actions.onKeymapPrefixChange?.([]);
      return true;
    }
    if (mode !== InputMode.Normal) {
      // Leaving CommandPalette via Esc must clear adoptContext (set by the
      // 'a' Frontier-row keypress) and reset palette state — otherwise the
      // next unrelated palette open inherits a stale adopt target.
      if (mode === InputMode.CommandPalette) {
        actions.onPaletteClose();
      }
      actions.panels.setMode(InputMode.Normal);
      return true;
    }
    if (actions.nav.isDetailView) {
      actions.nav.popDetail();
      return true;
    }
    // Reset zoom to normal (not cycle — Escape is "go back", not "go forward")
    actions.onZoomReset();
    return true;
  }

  // In help mode, help-toggle key exits; all other keys are consumed.
  if (mode === InputMode.Help) {
    if (isHelpToggleKey(key)) {
      actions.panels.setMode(InputMode.Normal);
    }
    return true;
  }

  // In terminal input mode, forward keystrokes to tmux
  if (mode === InputMode.TerminalInput) {
    if (actions.hasTmux && actions.selectedSession && input) {
      actions.onSendKeys(input);
    }
    return true;
  }

  // Command palette navigation + fuzzy filter
  if (mode === InputMode.CommandPalette) {
    if (input === "j" || input === "down") {
      actions.onPaletteDown(Math.max(0, actions.paletteItemCount - 1));
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onPaletteUp();
      return true;
    }
    if (input === "return") {
      actions.onPaletteSelect();
      return true;
    }
    if (input === "backspace") {
      actions.onPaletteBackspace();
      return true;
    }
    // Single printable characters → build fuzzy query
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      actions.onPaletteChar(input);
      return true;
    }
    return true;
  }

  // Search input mode
  if (mode === InputMode.SearchInput) {
    if (input === "return") {
      actions.onSearchSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onSearchBackspace();
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onSearchChar(input);
      return true;
    }
    return true;
  }

  // Message input mode
  if (mode === InputMode.MessageInput) {
    if (input === "return") {
      actions.onMessageSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onMessageBackspace();
      return true;
    }
    if (input === "space") {
      actions.onMessageChar(" ");
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onMessageChar(input);
      return true;
    }
    return true;
  }

  // Goal input mode
  if (mode === InputMode.GoalInput) {
    if (input === "return") {
      actions.onGoalSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onGoalBackspace();
      return true;
    }
    if (input === "space") {
      actions.onGoalChar(" ");
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onGoalChar(input);
      return true;
    }
    return true;
  }

  // Slash command-line mode (`:` prompt) — mirrors the GoalInput block.
  if (mode === InputMode.SlashCommand) {
    if (input === "return") {
      actions.onSlashSubmit();
      return true;
    }
    if (input === "backspace") {
      actions.onSlashBackspace();
      return true;
    }
    if (input === "space") {
      actions.onSlashChar(" ");
      return true;
    }
    if (input && input.length === 1 && !isCtrl) {
      actions.onSlashChar(input);
      return true;
    }
    return true;
  }

  const resolvedKeymap = actions.resolvedKeymap;
  if (mode === InputMode.Normal && resolvedKeymap !== undefined) {
    const token = keyEventToToken(key);
    if (token !== undefined) {
      const nextPrefix = Object.freeze([...keymapPrefix, token]);
      const result = resolveKeySequence(resolvedKeymap.bindings, nextPrefix, {
        focusedPanel: focused,
      });
      switch (result.kind) {
        case "pending":
          actions.onKeymapPrefixChange?.(result.prefix);
          return true;
        case "match":
          actions.onKeymapPrefixChange?.([]);
          if (
            dispatchKeymapBinding(
              result.binding,
              actions.registry,
              actions.actionContext,
              actions.onActionError,
            )
          )
            return true;
          if (keymapPrefix.length > 0) return true;
          break;
        case "miss":
          if (keymapPrefix.length > 0) {
            actions.onKeymapPrefixChange?.([]);
            return true;
          }
          return false;
      }
    }
  }

  // Help overlay toggle
  if (isHelpToggleKey(key)) {
    actions.panels.setMode(InputMode.Help);
    return true;
  }

  // Normal mode keybindings
  if (input === "q") {
    actions.onQuit();
    return true;
  }

  // Frontier panel: slice nav + adopt. Uses '[' / ']' for prev/next slice
  // (vim-style next-tab) so global Tab + 1-9 (panel cycle / panel focus)
  // remain available — keyboard-only operators must always be able to leave
  // the Frontier panel without resorting to the mouse.
  if (focused === Panel.Frontier) {
    if (input === "]") {
      actions.onFrontierTabNext();
      return true;
    }
    if (input === "[") {
      actions.onFrontierTabPrev();
      return true;
    }
    if (input === "a" && !actions.compareMode) {
      const entries = actions.frontierEntries();
      if (entries.length > 0 && actions.nav.state.cursor < entries.length) {
        const entry = entries[actions.nav.state.cursor];
        if (entry) {
          actions.onFrontierAdopt(entry.cid, entry.summary);
          return true;
        }
      }
    }
  }

  // Panel dispatch: driven by PANEL_REGISTRY (Issue 4A — eliminates DRY violation
  // and enables config-driven keybindings in the future).
  for (const def of PANEL_REGISTRY) {
    if (input === def.keybinding) {
      if (def.kind === "core") {
        actions.panels.focus(def.panel);
      } else {
        actions.panels.toggle(def.panel);
      }
      return true;
    }
  }

  // Tab/Shift+Tab: cycle focus (global — only reached when Frontier is not focused)
  if (input === "tab") {
    if (key.shift) {
      actions.panels.cyclePrev();
    } else {
      actions.panels.cycleNext();
    }
    return true;
  }

  // Layout toggle: + key (tab <-> grid)
  if (input === "+" || (key.shift && input === "=")) {
    actions.onLayoutToggle();
    return true;
  }

  // View mode cycle: V key (item 11 — grid ↔ pipeline)
  if (input === "V" || (key.shift && input === "v")) {
    actions.panels.cycleViewMode();
    return true;
  }

  // Terminal input mode entry
  if (input === "i" && focused === Panel.Terminal) {
    actions.panels.setMode(InputMode.TerminalInput);
    return true;
  }

  // Slash command palette entry: `/` in Normal mode off the Search panel opens
  // the palette pre-filtered to slash actions. Placed BEFORE the search-panel
  // `/` so the search behavior is preserved when the Search panel is focused.
  if (input === "/" && mode === InputMode.Normal && focused !== Panel.Search) {
    actions.onSlashPaletteOpen();
    return true;
  }

  // Search input mode entry
  if (input === "/" && focused === Panel.Search) {
    actions.onSearchStart();
    return true;
  }

  // Dedicated slash command-line entry: `:` in Normal mode opens the `:` prompt
  // (vim-style). Submit prepends `/` and resolves via the slash index. `:` is
  // not bound in the default keymap, so the keymap dispatch above returns a
  // miss and falls through here.
  if (input === ":" && mode === InputMode.Normal) {
    actions.onSlashCommandOpen();
    return true;
  }

  // Panel-specific keys — must be checked BEFORE global keys like "b"/"d"
  // because they are more specific (panel + mode gated).

  // Terminal panel: j/k scroll output, G un-pins (item 9)
  if (focused === Panel.Terminal) {
    if (input === "j" || input === "down") {
      actions.onTerminalScrollDown();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onTerminalScrollUp();
      return true;
    }
    if (input === "G" || (key.shift && input === "g")) {
      actions.onTerminalScrollBottom();
      return true;
    }
  }

  // Artifact panel: adopt compared contribution (a/b)
  if (focused === Panel.Artifact && actions.compareMode) {
    if (input === "a") {
      actions.onCompareAdopt("a");
      return true;
    }
    if (input === "b") {
      actions.onCompareAdopt("b");
      return true;
    }
  }
  if (focused === Panel.Artifact) {
    if (input === "h" || input === "left") {
      actions.onArtifactPrev();
      return true;
    }
    if (input === "l" || input === "right") {
      actions.onArtifactNext();
      return true;
    }
    if (input === "d") {
      actions.onArtifactDiffToggle();
      return true;
    }
    if (input === "s") {
      actions.onArtifactDiffModeToggle();
      return true;
    }
  }

  // Approve/Deny pending question (Decisions panel)
  if (input === "a" && focused === Panel.Decisions) {
    actions.onApproveQuestion();
    return true;
  }
  if (input === "d" && focused === Panel.Decisions) {
    actions.onDenyQuestion();
    return true;
  }

  // Compare artifacts (Frontier panel)
  if (input === "C" && focused === Panel.Frontier) {
    actions.onCompareToggle();
    return true;
  }

  // Global keys — only reached if no panel-specific handler matched

  // Broadcast message
  if (input === "b") {
    actions.onBroadcastMode();
    return true;
  }

  // Direct message
  if (input === "@") {
    actions.onDirectMessageMode();
    return true;
  }

  // MCP/ask-user manager
  if (input === "m") {
    actions.onSpawnPalette();
    actions.panels.setMode(InputMode.CommandPalette);
    return true;
  }

  // Detail section navigation — no-keymap fallback only (reached when no
  // resolvedKeymap is present, so the cursor_down/up specialization above
  // didn't run). Gated on the Detail panel being focused + showing a
  // contribution.
  if (actions.nav.isDetailView && focused === Panel.Detail) {
    if (input === "j" || input === "down") {
      actions.onDetailSectionNext();
      return true;
    }
    if (input === "k" || input === "up") {
      actions.onDetailSectionPrev();
      return true;
    }
  }

  // Within-panel navigation
  if (input === "j" || input === "down") {
    actions.nav.cursorDown(Math.max(0, actions.rowCount - 1));
    return true;
  }
  if (input === "k" || input === "up") {
    actions.nav.cursorUp();
    return true;
  }

  if (input === "return") {
    if (focused === Panel.Vfs) {
      actions.onVfsNavigate();
      return true;
    }
    if (actions.compareMode && focused === Panel.Frontier) {
      const cids = actions.frontierCids();
      if (cids.length > 0) {
        const cid = cids[actions.nav.state.cursor];
        if (cid) actions.onCompareSelect(cid);
        return true;
      }
    }
    const isClaimsPanel = focused === Panel.Claims;
    if (!actions.nav.isDetailView && !isClaimsPanel && actions.rowCount > 0) {
      actions.onSelect(actions.nav.state.cursor);
    }
    return true;
  }

  if (input === "n") {
    const hasFullPage = actions.rowCount >= actions.pageSize;
    const totalItems = hasFullPage
      ? actions.nav.state.pageOffset + actions.rowCount + 1
      : actions.nav.state.pageOffset + actions.rowCount;
    actions.nav.nextPage(actions.pageSize, totalItems);
    return true;
  }
  if (input === "p") {
    actions.nav.prevPage(actions.pageSize);
    return true;
  }

  if (input === "r") {
    actions.onRefresh();
    return true;
  }

  return false;
}
