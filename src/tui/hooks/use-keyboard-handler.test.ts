/**
 * Comprehensive unit tests for routeKey() — the single source of truth
 * for TUI keyboard handling.
 *
 * Tests every key binding, mode transition, and edge case.
 */

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { KeyboardActions } from "./use-keyboard-handler.js";
import { nextZoom, routeKey } from "./use-keyboard-handler.js";
import { InputMode, Panel, type PanelFocusState } from "./use-panel-focus.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal KeyEvent for testing. */
function keyEvent(name: string, opts?: { ctrl?: boolean; shift?: boolean }): KeyEvent {
  return {
    name,
    ctrl: opts?.ctrl ?? false,
    shift: opts?.shift ?? false,
    meta: false,
    alt: false,
    option: false,
    sequence: name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent;
}

/** Recording of action calls for assertions. */
interface ActionLog {
  calls: string[];
  args: Record<string, unknown[]>;
}

/** Create a mock KeyboardActions that records calls. */
function mockActions(overrides?: {
  mode?: InputMode;
  focused?: Panel;
  compareMode?: boolean;
  frontierCids?: readonly string[];
  paletteItemCount?: number;
  rowCount?: number;
  selectedSession?: string;
  hasTmux?: boolean;
  isDetailView?: boolean;
}): { actions: KeyboardActions; log: ActionLog } {
  const log: ActionLog = { calls: [], args: {} };

  function record(name: string, ...args: unknown[]): void {
    log.calls.push(name);
    log.args[name] = args;
  }

  const panelState: PanelFocusState = {
    focused: overrides?.focused ?? Panel.Dag,
    visibleOperator: new Set(),
    mode: overrides?.mode ?? InputMode.Normal,
    viewMode: "grid",
  };

  const actions: KeyboardActions = {
    panels: {
      state: panelState,
      focus: (p) => record("panels.focus", p),
      toggle: (p) => record("panels.toggle", p),
      cycleNext: () => record("panels.cycleNext"),
      cyclePrev: () => record("panels.cyclePrev"),
      setMode: (m) => record("panels.setMode", m),
      cycleViewMode: () => record("panels.cycleViewMode"),
      isVisible: () => true,
      visiblePanels: [],
    },
    nav: {
      state: { activeTab: 0, cursor: 0, pageOffset: 0, detailStack: [] },
      isDetailView: overrides?.isDetailView ?? false,
      detailCid: undefined,
      switchTab: (tab) => record("nav.switchTab", tab),
      cursorDown: (max) => record("nav.cursorDown", max),
      cursorUp: () => record("nav.cursorUp"),
      pushDetail: (cid) => record("nav.pushDetail", cid),
      popDetail: () => record("nav.popDetail"),
      resetCursor: () => record("nav.resetCursor"),
      nextPage: (size, total) => record("nav.nextPage", size, total),
      prevPage: (size) => record("nav.prevPage", size),
    },
    onQuit: () => record("onQuit"),
    onSpawnPalette: () => record("onSpawnPalette"),
    onVfsNavigate: () => record("onVfsNavigate"),
    onArtifactPrev: () => record("onArtifactPrev"),
    onArtifactNext: () => record("onArtifactNext"),
    onArtifactDiffToggle: () => record("onArtifactDiffToggle"),
    onCompareToggle: () => record("onCompareToggle"),
    onCompareSelect: (cid) => record("onCompareSelect", cid),
    onCompareAdopt: (side) => record("onCompareAdopt", side),
    onSearchStart: () => record("onSearchStart"),
    onSearchSubmit: () => record("onSearchSubmit"),
    onSearchChar: (char) => record("onSearchChar", char),
    onSearchBackspace: () => record("onSearchBackspace"),
    onMessageSubmit: () => record("onMessageSubmit"),
    onMessageChar: (char) => record("onMessageChar", char),
    onMessageBackspace: () => record("onMessageBackspace"),
    onBroadcastMode: () => record("onBroadcastMode"),
    onDirectMessageMode: () => record("onDirectMessageMode"),
    onApproveQuestion: () => record("onApproveQuestion"),
    onDenyQuestion: () => record("onDenyQuestion"),
    onSendKeys: (key) => record("onSendKeys", key),
    onPaletteUp: () => record("onPaletteUp"),
    onPaletteDown: (max) => record("onPaletteDown", max),
    onPaletteSelect: () => record("onPaletteSelect"),
    onZoomCycle: () => record("onZoomCycle"),
    onZoomReset: () => record("onZoomReset"),
    onTerminalScrollUp: () => record("onTerminalScrollUp"),
    onTerminalScrollDown: () => record("onTerminalScrollDown"),
    onTerminalScrollBottom: () => record("onTerminalScrollBottom"),
    onSelect: (index) => record("onSelect", index),
    rowCount: overrides?.rowCount ?? 10,
    pageSize: 20,
    paletteItemCount: overrides?.paletteItemCount ?? 5,
    compareMode: overrides?.compareMode ?? false,
    frontierCids: overrides?.frontierCids ?? [],
    selectedSession: overrides?.selectedSession,
    hasTmux: overrides?.hasTmux ?? false,
  };

  return { actions, log };
}

// ---------------------------------------------------------------------------
// nextZoom
// ---------------------------------------------------------------------------

describe("nextZoom", () => {
  test("cycles normal → half → full → normal", () => {
    expect(nextZoom("normal")).toBe("half");
    expect(nextZoom("half")).toBe("full");
    expect(nextZoom("full")).toBe("normal");
  });

  test("full cycle returns to start", () => {
    let zoom = nextZoom("normal");
    zoom = nextZoom(zoom);
    zoom = nextZoom(zoom);
    expect(zoom).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// Normal mode — panel focus and toggle
// ---------------------------------------------------------------------------

describe("routeKey — normal mode panel keys", () => {
  test("1-4 focus core panels", () => {
    const panelKeys = [
      { key: "1", panel: Panel.Dag },
      { key: "2", panel: Panel.Detail },
      { key: "3", panel: Panel.Frontier },
      { key: "4", panel: Panel.Claims },
    ];
    for (const { key, panel } of panelKeys) {
      const { actions, log } = mockActions();
      const handled = routeKey(keyEvent(key), actions);
      expect(handled).toBe(true);
      expect(log.calls).toContain("panels.focus");
      expect(log.args["panels.focus"]).toEqual([panel]);
    }
  });

  test("5-] toggle operator panels", () => {
    const toggleKeys = [
      { key: "5", panel: Panel.AgentList },
      { key: "6", panel: Panel.Terminal },
      { key: "7", panel: Panel.Artifact },
      { key: "8", panel: Panel.Vfs },
      { key: "9", panel: Panel.Activity },
      { key: "0", panel: Panel.Search },
      { key: "-", panel: Panel.Threads },
      { key: "=", panel: Panel.Outcomes },
      { key: "[", panel: Panel.Bounties },
      { key: "]", panel: Panel.Gossip },
      { key: "\\", panel: Panel.Inbox },
      { key: ";", panel: Panel.Decisions },
      { key: "'", panel: Panel.GitHub },
    ];
    for (const { key, panel } of toggleKeys) {
      const { actions, log } = mockActions();
      const handled = routeKey(keyEvent(key), actions);
      expect(handled).toBe(true);
      expect(log.calls).toContain("panels.toggle");
      expect(log.args["panels.toggle"]).toEqual([panel]);
    }
  });

  test("Tab cycles next, Shift+Tab cycles prev", () => {
    const { actions: a1, log: l1 } = mockActions();
    routeKey(keyEvent("tab"), a1);
    expect(l1.calls).toContain("panels.cycleNext");

    const { actions: a2, log: l2 } = mockActions();
    routeKey(keyEvent("tab", { shift: true }), a2);
    expect(l2.calls).toContain("panels.cyclePrev");
  });
});

// ---------------------------------------------------------------------------
// Normal mode — misc keys
// ---------------------------------------------------------------------------

describe("routeKey — normal mode misc", () => {
  test("q quits", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("q"), actions);
    expect(log.calls).toContain("onQuit");
  });

  test("? enters help mode", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("?"), actions);
    expect(log.args["panels.setMode"]).toEqual([InputMode.Help]);
  });

  test("+ cycles zoom", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("+"), actions);
    expect(log.calls).toContain("onZoomCycle");
  });

  test("j/k navigate cursor", () => {
    const { actions: a1, log: l1 } = mockActions({ rowCount: 5 });
    routeKey(keyEvent("j"), a1);
    expect(l1.calls).toContain("nav.cursorDown");
    expect(l1.args["nav.cursorDown"]).toEqual([4]); // rowCount - 1

    const { actions: a2, log: l2 } = mockActions();
    routeKey(keyEvent("k"), a2);
    expect(l2.calls).toContain("nav.cursorUp");
  });

  test("n/p navigate pages", () => {
    const { actions: a1, log: l1 } = mockActions({ rowCount: 20 });
    routeKey(keyEvent("n"), a1);
    expect(l1.calls).toContain("nav.nextPage");

    const { actions: a2, log: l2 } = mockActions();
    routeKey(keyEvent("p"), a2);
    expect(l2.calls).toContain("nav.prevPage");
  });

  test("r returns true (handled) but no action", () => {
    const { actions, log } = mockActions();
    const handled = routeKey(keyEvent("r"), actions);
    expect(handled).toBe(true);
    expect(log.calls).toEqual([]);
  });

  test("unhandled key returns false", () => {
    const { actions } = mockActions();
    const handled = routeKey(keyEvent("z"), actions);
    expect(handled).toBe(false);
  });

  test("Ctrl+P opens command palette", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("p", { ctrl: true }), actions);
    expect(log.calls).toContain("onSpawnPalette");
    expect(log.args["panels.setMode"]).toEqual([InputMode.CommandPalette]);
  });

  test("Ctrl+P in command palette mode exits to normal", () => {
    const { actions, log } = mockActions({ mode: InputMode.CommandPalette });
    routeKey(keyEvent("p", { ctrl: true }), actions);
    expect(log.args["panels.setMode"]).toEqual([InputMode.Normal]);
  });

  test("b enters broadcast mode", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("b"), actions);
    expect(log.calls).toContain("onBroadcastMode");
  });

  test("@ enters direct message mode", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("@"), actions);
    expect(log.calls).toContain("onDirectMessageMode");
  });

  test("m opens command palette", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("m"), actions);
    expect(log.calls).toContain("onSpawnPalette");
    expect(log.args["panels.setMode"]).toEqual([InputMode.CommandPalette]);
  });
});

// ---------------------------------------------------------------------------
// Escape key priority (6A)
// ---------------------------------------------------------------------------

describe("routeKey — Escape key priority", () => {
  test("Escape in non-normal mode → exits mode (highest priority)", () => {
    const { actions, log } = mockActions({ mode: InputMode.SearchInput });
    routeKey(keyEvent("escape"), actions);
    expect(log.args["panels.setMode"]).toEqual([InputMode.Normal]);
    expect(log.calls).not.toContain("nav.popDetail");
    expect(log.calls).not.toContain("onZoomReset");
  });

  test("Escape in normal mode with detail view → pops detail", () => {
    const { actions, log } = mockActions({ isDetailView: true });
    routeKey(keyEvent("escape"), actions);
    expect(log.calls).toContain("nav.popDetail");
    expect(log.calls).not.toContain("onZoomReset");
  });

  test("Escape in normal mode, no detail → resets zoom", () => {
    const { actions, log } = mockActions();
    routeKey(keyEvent("escape"), actions);
    expect(log.calls).toContain("onZoomReset");
    expect(log.calls).not.toContain("nav.popDetail");
  });
});

// ---------------------------------------------------------------------------
// Terminal input mode
// ---------------------------------------------------------------------------

describe("routeKey — terminal input mode", () => {
  test("forwards keys to tmux when available", () => {
    const { actions, log } = mockActions({
      mode: InputMode.TerminalInput,
      hasTmux: true,
      selectedSession: "grove-test",
    });
    routeKey(keyEvent("a"), actions);
    expect(log.calls).toContain("onSendKeys");
    expect(log.args.onSendKeys).toEqual(["a"]);
  });

  test("does nothing without tmux", () => {
    const { actions, log } = mockActions({
      mode: InputMode.TerminalInput,
      hasTmux: false,
    });
    routeKey(keyEvent("a"), actions);
    expect(log.calls).not.toContain("onSendKeys");
  });
});

// ---------------------------------------------------------------------------
// Command palette mode
// ---------------------------------------------------------------------------

describe("routeKey — command palette mode", () => {
  test("j/down navigates down with correct maxIndex", () => {
    const { actions, log } = mockActions({
      mode: InputMode.CommandPalette,
      paletteItemCount: 5,
    });
    routeKey(keyEvent("j"), actions);
    expect(log.calls).toContain("onPaletteDown");
    expect(log.args.onPaletteDown).toEqual([4]); // paletteItemCount - 1
  });

  test("k/up navigates up", () => {
    const { actions, log } = mockActions({ mode: InputMode.CommandPalette });
    routeKey(keyEvent("k"), actions);
    expect(log.calls).toContain("onPaletteUp");
  });

  test("Enter selects palette item", () => {
    const { actions, log } = mockActions({ mode: InputMode.CommandPalette });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onPaletteSelect");
  });

  test("other keys are consumed but not acted on", () => {
    const { actions, log } = mockActions({ mode: InputMode.CommandPalette });
    const handled = routeKey(keyEvent("x"), actions);
    expect(handled).toBe(true);
    expect(log.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Search input mode
// ---------------------------------------------------------------------------

describe("routeKey — search input mode", () => {
  test("Enter submits search", () => {
    const { actions, log } = mockActions({ mode: InputMode.SearchInput });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onSearchSubmit");
  });

  test("backspace removes char", () => {
    const { actions, log } = mockActions({ mode: InputMode.SearchInput });
    routeKey(keyEvent("backspace"), actions);
    expect(log.calls).toContain("onSearchBackspace");
  });

  test("single char adds to search", () => {
    const { actions, log } = mockActions({ mode: InputMode.SearchInput });
    routeKey(keyEvent("a"), actions);
    expect(log.calls).toContain("onSearchChar");
    expect(log.args.onSearchChar).toEqual(["a"]);
  });

  test("/ in Search panel starts search mode", () => {
    const { actions, log } = mockActions({ focused: Panel.Search });
    routeKey(keyEvent("/"), actions);
    expect(log.calls).toContain("onSearchStart");
  });
});

// ---------------------------------------------------------------------------
// Message input mode
// ---------------------------------------------------------------------------

describe("routeKey — message input mode", () => {
  test("Enter submits message", () => {
    const { actions, log } = mockActions({ mode: InputMode.MessageInput });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onMessageSubmit");
  });

  test("backspace removes char", () => {
    const { actions, log } = mockActions({ mode: InputMode.MessageInput });
    routeKey(keyEvent("backspace"), actions);
    expect(log.calls).toContain("onMessageBackspace");
  });

  test("single char adds to message", () => {
    const { actions, log } = mockActions({ mode: InputMode.MessageInput });
    routeKey(keyEvent("x"), actions);
    expect(log.calls).toContain("onMessageChar");
    expect(log.args.onMessageChar).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// Help mode
// ---------------------------------------------------------------------------

describe("routeKey — help mode", () => {
  test("? exits help mode", () => {
    const { actions, log } = mockActions({ mode: InputMode.Help });
    routeKey(keyEvent("?"), actions);
    expect(log.args["panels.setMode"]).toEqual([InputMode.Normal]);
  });

  test("other keys are consumed in help mode", () => {
    const { actions, log } = mockActions({ mode: InputMode.Help });
    const handled = routeKey(keyEvent("j"), actions);
    expect(handled).toBe(true);
    expect(log.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Panel-specific keys
// ---------------------------------------------------------------------------

describe("routeKey — panel-specific keys", () => {
  test("i in Terminal panel enters input mode", () => {
    const { actions, log } = mockActions({ focused: Panel.Terminal });
    routeKey(keyEvent("i"), actions);
    expect(log.args["panels.setMode"]).toEqual([InputMode.TerminalInput]);
  });

  test("C in Frontier panel toggles compare mode", () => {
    const { actions, log } = mockActions({ focused: Panel.Frontier });
    routeKey(keyEvent("C"), actions);
    expect(log.calls).toContain("onCompareToggle");
  });

  test("Enter in Frontier + compare mode selects CID", () => {
    const { actions, log } = mockActions({
      focused: Panel.Frontier,
      compareMode: true,
      frontierCids: ["cid-0", "cid-1", "cid-2"],
    });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onCompareSelect");
    expect(log.args.onCompareSelect).toEqual(["cid-0"]);
  });

  test("Enter in VFS panel triggers navigate", () => {
    const { actions, log } = mockActions({ focused: Panel.Vfs });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onVfsNavigate");
  });

  test("a/d in Decisions panel approve/deny", () => {
    const { actions: a1, log: l1 } = mockActions({ focused: Panel.Decisions });
    routeKey(keyEvent("a"), a1);
    expect(l1.calls).toContain("onApproveQuestion");

    const { actions: a2, log: l2 } = mockActions({ focused: Panel.Decisions });
    routeKey(keyEvent("d"), a2);
    expect(l2.calls).toContain("onDenyQuestion");
  });

  test("h/l in Artifact panel navigates artifacts", () => {
    const { actions: a1, log: l1 } = mockActions({ focused: Panel.Artifact });
    routeKey(keyEvent("h"), a1);
    expect(l1.calls).toContain("onArtifactPrev");

    const { actions: a2, log: l2 } = mockActions({ focused: Panel.Artifact });
    routeKey(keyEvent("l"), a2);
    expect(l2.calls).toContain("onArtifactNext");
  });

  test("d in Artifact panel toggles diff", () => {
    const { actions, log } = mockActions({ focused: Panel.Artifact });
    routeKey(keyEvent("d"), actions);
    expect(log.calls).toContain("onArtifactDiffToggle");
  });

  test("a/b in Artifact compare mode adopts side", () => {
    const { actions: a1, log: l1 } = mockActions({
      focused: Panel.Artifact,
      compareMode: true,
    });
    routeKey(keyEvent("a"), a1);
    expect(l1.calls).toContain("onCompareAdopt");
    expect(l1.args.onCompareAdopt).toEqual(["a"]);

    const { actions: a2, log: l2 } = mockActions({
      focused: Panel.Artifact,
      compareMode: true,
    });
    routeKey(keyEvent("b"), a2);
    expect(l2.calls).toContain("onCompareAdopt");
    expect(l2.args.onCompareAdopt).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Enter selects contribution
// ---------------------------------------------------------------------------

describe("routeKey — Enter key", () => {
  test("Enter selects contribution in DAG panel", () => {
    const { actions, log } = mockActions({ focused: Panel.Dag, rowCount: 5 });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).toContain("onSelect");
    expect(log.args.onSelect).toEqual([0]);
  });

  test("Enter does not select in Claims panel", () => {
    const { actions, log } = mockActions({ focused: Panel.Claims, rowCount: 5 });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).not.toContain("onSelect");
  });

  test("Enter does not select when in detail view", () => {
    const { actions, log } = mockActions({
      focused: Panel.Dag,
      rowCount: 5,
      isDetailView: true,
    });
    routeKey(keyEvent("return"), actions);
    expect(log.calls).not.toContain("onSelect");
  });
});

// ---------------------------------------------------------------------------
// TUI reducer tests (imported async because app.tsx has async deps)
// ---------------------------------------------------------------------------

describe("tuiReducer", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import in test
  let tuiReducer: any;

  // Load the module once before tests
  test("loads tuiReducer", async () => {
    const mod = await import("../app.js");
    tuiReducer = mod.tuiReducer;
    expect(typeof tuiReducer).toBe("function");
  });

  const initial = {
    vfsNavigateTrigger: 0,
    artifactIndex: 0,
    showArtifactDiff: false,
    paletteIndex: 0,
    searchQuery: "",
    searchBuffer: "",
    messageBuffer: "",
    messageRecipients: "",
    compareMode: false,
    compareCids: [] as readonly string[],
    zoomLevel: "normal" as const,
  };

  test("ZOOM_CYCLE cycles through levels", () => {
    let state = tuiReducer(initial, { type: "ZOOM_CYCLE" });
    expect(state.zoomLevel).toBe("half");
    state = tuiReducer(state, { type: "ZOOM_CYCLE" });
    expect(state.zoomLevel).toBe("full");
    state = tuiReducer(state, { type: "ZOOM_CYCLE" });
    expect(state.zoomLevel).toBe("normal");
  });

  test("ZOOM_RESET returns to normal", () => {
    const zoomed = { ...initial, zoomLevel: "full" as const };
    const state = tuiReducer(zoomed, { type: "ZOOM_RESET" });
    expect(state.zoomLevel).toBe("normal");
  });

  test("ZOOM_RESET is no-op when already normal", () => {
    const state = tuiReducer(initial, { type: "ZOOM_RESET" });
    expect(state).toBe(initial);
  });

  test("SEARCH_START copies current query to buffer", () => {
    const withQuery = { ...initial, searchQuery: "test" };
    const state = tuiReducer(withQuery, { type: "SEARCH_START", currentQuery: "test" });
    expect(state.searchBuffer).toBe("test");
  });

  test("SEARCH_CHAR appends to buffer", () => {
    const state = tuiReducer(initial, { type: "SEARCH_CHAR", char: "a" });
    expect(state.searchBuffer).toBe("a");
    const state2 = tuiReducer(state, { type: "SEARCH_CHAR", char: "b" });
    expect(state2.searchBuffer).toBe("ab");
  });

  test("SEARCH_SUBMIT copies buffer to query", () => {
    const withBuffer = { ...initial, searchBuffer: "hello" };
    const state = tuiReducer(withBuffer, { type: "SEARCH_SUBMIT" });
    expect(state.searchQuery).toBe("hello");
  });

  test("COMPARE_TOGGLE resets CIDs when entering compare mode", () => {
    const withCids = { ...initial, compareCids: ["a", "b"] as readonly string[] };
    const state = tuiReducer(withCids, { type: "COMPARE_TOGGLE" });
    expect(state.compareMode).toBe(true);
    expect(state.compareCids).toEqual([]);
  });

  test("COMPARE_SELECT adds CID up to 2", () => {
    let state = tuiReducer(initial, { type: "COMPARE_SELECT", cid: "a" });
    expect(state.compareCids).toEqual(["a"]);
    state = tuiReducer(state, { type: "COMPARE_SELECT", cid: "b" });
    expect(state.compareCids).toEqual(["a", "b"]);
    state = tuiReducer(state, { type: "COMPARE_SELECT", cid: "c" });
    expect(state.compareCids).toEqual(["b", "c"]);
  });

  test("COMPARE_SELECT deselects if already selected", () => {
    const withCid = { ...initial, compareCids: ["a", "b"] as readonly string[] };
    const state = tuiReducer(withCid, { type: "COMPARE_SELECT", cid: "a" });
    expect(state.compareCids).toEqual(["b"]);
  });

  test("PALETTE_DOWN respects maxIndex", () => {
    const state = tuiReducer(initial, { type: "PALETTE_DOWN", maxIndex: 2 });
    expect(state.paletteIndex).toBe(1);
    const state2 = tuiReducer(
      { ...initial, paletteIndex: 2 },
      { type: "PALETTE_DOWN", maxIndex: 2 },
    );
    expect(state2.paletteIndex).toBe(2);
  });

  test("PALETTE_UP doesn't go below 0", () => {
    const state = tuiReducer(initial, { type: "PALETTE_UP" });
    expect(state.paletteIndex).toBe(0);
  });

  test("BROADCAST_MODE sets up broadcast state", () => {
    const state = tuiReducer(initial, { type: "BROADCAST_MODE" });
    expect(state.messageBuffer).toBe("");
    expect(state.messageRecipients).toBe("@all");
  });

  test("DIRECT_MESSAGE_MODE sets up DM state", () => {
    const state = tuiReducer(initial, { type: "DIRECT_MESSAGE_MODE" });
    expect(state.messageBuffer).toBe("@");
    expect(state.messageRecipients).toBe("@direct");
  });
});
