/**
 * Comprehensive unit tests for routeRunningKey() and panel state transitions.
 *
 * Covers:
 *   - All key bindings in normal mode (~15 keys)
 *   - Prompt input mode (swallows all keys)
 *   - Help overlay mode (swallows all keys)
 *   - Mode × key interaction matrix
 *   - Panel expand/collapse/fullscreen state transitions
 *   - f-key fullscreen transition table
 *   - j/k cursor routing
 *   - Escape layered dismissal priority
 */

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import {
  collapsePanel,
  expandPanel,
  RUNNING_PANEL_LABELS,
  type RunningKeyboardActions,
  type RunningKeyboardState,
  RunningPanel,
  routeRunningKey,
  toggleFullscreen,
} from "./running-keyboard.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function keyEvent(
  name: string,
  opts?: { ctrl?: boolean; shift?: boolean; sequence?: string },
): KeyEvent {
  return {
    name,
    ctrl: opts?.ctrl ?? false,
    shift: opts?.shift ?? false,
    meta: false,
    alt: false,
    option: false,
    sequence: opts?.sequence ?? name,
    raw: name,
    eventType: "keypress",
    preventDefault: () => {
      /* noop */
    },
    stopPropagation: () => {
      /* noop */
    },
  } as unknown as KeyEvent;
}

interface ActionLog {
  calls: string[];
  args: Record<string, unknown[]>;
}

function defaultState(overrides?: Partial<RunningKeyboardState>): RunningKeyboardState {
  return {
    expandedPanel: null,
    zoomLevel: "normal",
    showHelp: false,
    showVfs: false,
    confirmQuit: false,
    promptMode: false,
    promptText: "",
    cmdMode: "none",
    cmdText: "",
    filterQuery: "",
    confirmModalOpen: false,
    logFilterMode: false,
    ...overrides,
  };
}

function mockActions(overrides?: {
  hasPermissions?: boolean;
  hasActiveRoles?: boolean;
  hasSendToAgent?: boolean;
  feedLength?: number;
  hasAskUser?: boolean;
  logViewActive?: boolean;
}): { actions: RunningKeyboardActions; log: ActionLog } {
  const log: ActionLog = { calls: [], args: {} };

  function record(name: string, ...args: unknown[]): void {
    log.calls.push(name);
    log.args[name] = args;
  }

  const actions: RunningKeyboardActions = {
    expandPanel: (p) => record("expandPanel", p),
    collapsePanel: () => record("collapsePanel"),
    toggleFullscreen: () => record("toggleFullscreen"),
    toggleHelp: () => record("toggleHelp"),
    dismissHelp: () => record("dismissHelp"),
    toggleVfs: () => record("toggleVfs"),
    dismissVfs: () => record("dismissVfs"),
    setConfirmQuit: (v) => record("setConfirmQuit", v),
    enterPromptMode: () => record("enterPromptMode"),
    exitPromptMode: () => record("exitPromptMode"),
    appendPromptChar: (c) => record("appendPromptChar", c),
    deletePromptChar: () => record("deletePromptChar"),
    cyclePromptTarget: () => record("cyclePromptTarget"),
    submitPrompt: () => record("submitPrompt"),
    enterGotoMode: () => record("enterGotoMode"),
    enterFilterMode: () => record("enterFilterMode"),
    cmdAppendChar: (c: string) => record("cmdAppendChar", c),
    cmdDeleteChar: () => record("cmdDeleteChar"),
    cmdTabComplete: () => record("cmdTabComplete"),
    cmdSubmit: () => record("cmdSubmit"),
    cmdClearText: () => record("cmdClearText"),
    cmdExit: () => record("cmdExit"),
    clearFilterQuery: () => record("clearFilterQuery"),
    feedCursorDown: () => record("feedCursorDown"),
    feedCursorUp: () => record("feedCursorUp"),
    feedScrollToBottom: () => record("feedScrollToBottom"),
    scrollToAskUser: () => record("scrollToAskUser"),
    traceSelectDown: () => record("traceSelectDown"),
    traceSelectUp: () => record("traceSelectUp"),
    traceScrollDown: () => record("traceScrollDown"),
    traceScrollUp: () => record("traceScrollUp"),
    traceScrollToBottom: () => record("traceScrollToBottom"),
    traceScrollToTop: () => record("traceScrollToTop"),
    traceCycleAgent: () => record("traceCycleAgent"),
    handoffCursorDown: () => record("handoffCursorDown"),
    handoffCursorUp: () => record("handoffCursorUp"),
    resendSelectedHandoff: () => record("resendSelectedHandoff"),
    rerouteSelectedHandoff: () => record("rerouteSelectedHandoff"),
    cancelSelectedHandoff: () => record("cancelSelectedHandoff"),
    manualResolveSelectedHandoff: () => record("manualResolveSelectedHandoff"),
    logTogglePause: () => record("logTogglePause"),
    logScrollDown: () => record("logScrollDown"),
    logScrollUp: () => record("logScrollUp"),
    logScrollToBottom: () => record("logScrollToBottom"),
    logScrollToTop: () => record("logScrollToTop"),
    logEnterFilterMode: () => record("logEnterFilterMode"),
    logCommitFilter: () => record("logCommitFilter"),
    logCancelFilter: () => record("logCancelFilter"),
    logFilterAppend: (c: string) => record("logFilterAppend", c),
    logFilterBackspace: () => record("logFilterBackspace"),
    openDetail: () => record("openDetail"),
    enterInspect: () => record("enterInspect"),
    openPulse: () => record("openPulse"),
    quit: () => record("quit"),
    showQuitDialog: () => record("showQuitDialog"),
    approvePermission: () => record("approvePermission"),
    denyPermission: () => record("denyPermission"),
    hasPermissions: overrides?.hasPermissions ?? false,
    hasActiveRoles: overrides?.hasActiveRoles ?? false,
    hasSendToAgent: overrides?.hasSendToAgent ?? false,
    feedLength: overrides?.feedLength ?? 10,
    hasAskUser: overrides?.hasAskUser ?? false,
    logViewActive: overrides?.logViewActive ?? false,
  };

  return { actions, log };
}

function mockActionsWithHandoffs(): { actions: RunningKeyboardActions; log: ActionLog } {
  const { actions, log } = mockActions();
  const withHandoffs = {
    ...actions,
    handoffCursorDown: () => {
      log.calls.push("handoffCursorDown");
    },
    handoffCursorUp: () => {
      log.calls.push("handoffCursorUp");
    },
    resendSelectedHandoff: () => {
      log.calls.push("resendSelectedHandoff");
    },
    rerouteSelectedHandoff: () => {
      log.calls.push("rerouteSelectedHandoff");
    },
    cancelSelectedHandoff: () => {
      log.calls.push("cancelSelectedHandoff");
    },
    manualResolveSelectedHandoff: () => {
      log.calls.push("manualResolveSelectedHandoff");
    },
  } as RunningKeyboardActions;
  return { actions: withHandoffs, log };
}

// ===========================================================================
// Pure state transitions
// ===========================================================================

describe("expandPanel", () => {
  test("expanding from null goes to half-screen", () => {
    const result = expandPanel(null, "normal", RunningPanel.Dag);
    expect(result.expandedPanel).toBe(RunningPanel.Dag);
    expect(result.zoomLevel).toBe("half");
  });

  test("expanding same panel collapses it", () => {
    const result = expandPanel(RunningPanel.Dag, "half", RunningPanel.Dag);
    expect(result.expandedPanel).toBeNull();
    expect(result.zoomLevel).toBe("normal");
  });

  test("switching panels preserves zoom level", () => {
    const result = expandPanel(RunningPanel.Dag, "full", RunningPanel.Terminal);
    expect(result.expandedPanel).toBe(RunningPanel.Terminal);
    expect(result.zoomLevel).toBe("full");
  });

  test("switching panels from half stays half", () => {
    const result = expandPanel(RunningPanel.Feed, "half", RunningPanel.Agents);
    expect(result.expandedPanel).toBe(RunningPanel.Agents);
    expect(result.zoomLevel).toBe("half");
  });
});

describe("toggleFullscreen", () => {
  test("no panel expanded → no-op", () => {
    const result = toggleFullscreen(null, "normal");
    expect(result.expandedPanel).toBeNull();
    expect(result.zoomLevel).toBe("normal");
  });

  test("half → full", () => {
    const result = toggleFullscreen(RunningPanel.Dag, "half");
    expect(result.expandedPanel).toBe(RunningPanel.Dag);
    expect(result.zoomLevel).toBe("full");
  });

  test("full → half", () => {
    const result = toggleFullscreen(RunningPanel.Dag, "full");
    expect(result.expandedPanel).toBe(RunningPanel.Dag);
    expect(result.zoomLevel).toBe("half");
  });

  test("normal with panel → full", () => {
    const result = toggleFullscreen(RunningPanel.Terminal, "normal");
    expect(result.expandedPanel).toBe(RunningPanel.Terminal);
    expect(result.zoomLevel).toBe("full");
  });
});

describe("collapsePanel", () => {
  test("always returns null panel and normal zoom", () => {
    const result = collapsePanel();
    expect(result.expandedPanel).toBeNull();
    expect(result.zoomLevel).toBe("normal");
  });
});

// ===========================================================================
// f-key fullscreen transition table (Issue 11)
// ===========================================================================

describe("f-key fullscreen transition table", () => {
  const table: Array<{
    desc: string;
    panel: RunningPanel | null;
    zoom: "normal" | "half" | "full";
    expectPanel: RunningPanel | null;
    expectZoom: "normal" | "half" | "full";
  }> = [
    {
      desc: "no panel → no-op",
      panel: null,
      zoom: "normal",
      expectPanel: null,
      expectZoom: "normal",
    },
    {
      desc: "half → full",
      panel: RunningPanel.Dag,
      zoom: "half",
      expectPanel: RunningPanel.Dag,
      expectZoom: "full",
    },
    {
      desc: "full → half",
      panel: RunningPanel.Dag,
      zoom: "full",
      expectPanel: RunningPanel.Dag,
      expectZoom: "half",
    },
    {
      desc: "normal with panel → full",
      panel: RunningPanel.Terminal,
      zoom: "normal",
      expectPanel: RunningPanel.Terminal,
      expectZoom: "full",
    },
    {
      desc: "half feed → full feed",
      panel: RunningPanel.Feed,
      zoom: "half",
      expectPanel: RunningPanel.Feed,
      expectZoom: "full",
    },
    {
      desc: "full agents → half agents",
      panel: RunningPanel.Agents,
      zoom: "full",
      expectPanel: RunningPanel.Agents,
      expectZoom: "half",
    },
  ];

  for (const { desc, panel, zoom, expectPanel, expectZoom } of table) {
    test(desc, () => {
      const result = toggleFullscreen(panel, zoom);
      expect(result.expandedPanel).toBe(expectPanel);
      expect(result.zoomLevel).toBe(expectZoom);
    });
  }
});

// ===========================================================================
// Normal mode — panel keys (Issue 9)
// ===========================================================================

describe("routeRunningKey — normal mode panel keys", () => {
  test("1 expands Feed panel", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("1"), defaultState(), actions);
    expect(handled).toBe(true);
    expect(log.args.expandPanel).toEqual([RunningPanel.Feed]);
  });

  test("e expands Trace panel", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("e"), defaultState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).toContain("expandPanel");
    expect(log.args.expandPanel).toEqual([RunningPanel.Trace]);
  });

  test("2 expands Agents panel", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("2"), defaultState(), actions);
    expect(log.args.expandPanel).toEqual([RunningPanel.Agents]);
  });

  test("3 expands DAG panel", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("3"), defaultState(), actions);
    expect(log.args.expandPanel).toEqual([RunningPanel.Dag]);
  });

  test("4 expands Terminal panel", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("4"), defaultState(), actions);
    expect(log.args.expandPanel).toEqual([RunningPanel.Terminal]);
  });
});

// ===========================================================================
// Normal mode — f key (Issue 4A)
// ===========================================================================

describe("routeRunningKey — f key fullscreen", () => {
  test("f with expanded panel toggles fullscreen", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ expandedPanel: RunningPanel.Dag, zoomLevel: "half" });
    const handled = routeRunningKey(keyEvent("f"), state, actions);
    expect(handled).toBe(true);
    expect(log.calls).toContain("toggleFullscreen");
  });

  test("f with no expanded panel is not handled", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("f"), defaultState(), actions);
    expect(handled).toBe(false);
    expect(log.calls).not.toContain("toggleFullscreen");
  });
});

// ===========================================================================
// Normal mode — misc keys
// ===========================================================================

describe("routeRunningKey — normal mode misc", () => {
  test("q shows quit dialog", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("q"), defaultState(), actions);
    expect(log.calls).toContain("showQuitDialog");
  });

  test("? toggles help", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("?"), defaultState(), actions);
    expect(log.calls).toContain("toggleHelp");
  });

  test("Ctrl+F toggles VFS", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("f", { ctrl: true }), defaultState(), actions);
    expect(log.calls).toContain("toggleVfs");
  });

  test("Ctrl+G calls enterInspect", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("g", { ctrl: true }), defaultState(), actions);
    expect(log.calls).toContain("enterInspect");
  });

  test("Ctrl+A no longer calls enterInspect", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("a", { ctrl: true }), defaultState(), actions);
    expect(log.calls).not.toContain("enterInspect");
  });

  test("Enter does NOT open inspect when feed has items (#191 round 3)", () => {
    // Enter used to call openDetail which was wired to onEnterInspect,
    // giving it an accidental inspect-entry path. Until a real
    // contribution-detail route exists, Enter on a feed item is a no-op
    // and must not enter inspect.
    const { actions, log } = mockActions({ feedLength: 5 });
    const handled = routeRunningKey(keyEvent("return"), defaultState(), actions);
    expect(handled).toBe(false);
    expect(log.calls).not.toContain("enterInspect");
    expect(log.calls).not.toContain("openDetail");
  });

  test("Enter does nothing when feed is empty", () => {
    const { actions, log } = mockActions({ feedLength: 0 });
    const handled = routeRunningKey(keyEvent("return"), defaultState(), actions);
    expect(handled).toBe(false);
    expect(log.calls).not.toContain("openDetail");
  });

  test("r scrolls to ask_user when present", () => {
    const { actions, log } = mockActions({ hasAskUser: true });
    routeRunningKey(keyEvent("r"), defaultState(), actions);
    expect(log.calls).toContain("scrollToAskUser");
  });

  test("r does nothing when no ask_user", () => {
    const { actions } = mockActions({ hasAskUser: false });
    const handled = routeRunningKey(keyEvent("r"), defaultState(), actions);
    expect(handled).toBe(false);
  });

  test("unhandled key returns false", () => {
    const { actions } = mockActions();
    const handled = routeRunningKey(keyEvent("z"), defaultState(), actions);
    expect(handled).toBe(false);
  });
});

// ===========================================================================
// Pulse hotkey (#308)
// ===========================================================================

describe("Pulse hotkey (#308)", () => {
  test("'p' in normal mode invokes openPulse and is handled", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("p"), defaultState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).toContain("openPulse");
  });

  test("'p' is NOT routed to openPulse when prompt mode is active", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ promptMode: true });
    routeRunningKey(keyEvent("p"), state, actions);
    expect(log.calls).not.toContain("openPulse");
  });
});

// ===========================================================================
// Normal mode — j/k cursor routing (Issue 12)
// ===========================================================================

describe("routeRunningKey — j/k cursor routing", () => {
  test("j moves feed cursor down", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("j"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorDown");
  });

  test("k moves feed cursor up", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("k"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorUp");
  });

  test("down arrow moves feed cursor down", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("down"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorDown");
  });

  test("up arrow moves feed cursor up", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("up"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorUp");
  });

  test("G (Shift+G) scrolls feed to bottom in normal mode", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("g", { shift: true, sequence: "G" }), defaultState(), actions);
    expect(log.calls).toContain("feedScrollToBottom");
  });

  test("j works with panel expanded (feed still scrollable)", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ expandedPanel: RunningPanel.Dag, zoomLevel: "half" });
    routeRunningKey(keyEvent("j"), state, actions);
    expect(log.calls).toContain("feedCursorDown");
  });

  test("j works with panel fullscreen", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ expandedPanel: RunningPanel.Terminal, zoomLevel: "full" });
    routeRunningKey(keyEvent("j"), state, actions);
    expect(log.calls).toContain("feedCursorDown");
  });
});

describe("routeRunningKey — handoff panel recovery keys", () => {
  const handoffsState = defaultState({
    expandedPanel: RunningPanel.Handoffs,
    zoomLevel: "half",
  });

  test("j/k navigate handoff rows instead of the feed", () => {
    const { actions, log } = mockActionsWithHandoffs();

    routeRunningKey(keyEvent("j"), handoffsState, actions);
    routeRunningKey(keyEvent("k"), handoffsState, actions);

    expect(log.calls).toContain("handoffCursorDown");
    expect(log.calls).toContain("handoffCursorUp");
    expect(log.calls).not.toContain("feedCursorDown");
    expect(log.calls).not.toContain("feedCursorUp");
  });

  test("s/r/x/v invoke selected handoff recovery actions", () => {
    const { actions, log } = mockActionsWithHandoffs();

    routeRunningKey(keyEvent("s"), handoffsState, actions);
    routeRunningKey(keyEvent("r"), handoffsState, actions);
    routeRunningKey(keyEvent("x"), handoffsState, actions);
    routeRunningKey(keyEvent("v"), handoffsState, actions);

    expect(log.calls).toContain("resendSelectedHandoff");
    expect(log.calls).toContain("rerouteSelectedHandoff");
    expect(log.calls).toContain("cancelSelectedHandoff");
    expect(log.calls).toContain("manualResolveSelectedHandoff");
  });
});

// ===========================================================================
// Normal mode — permission keys
// ===========================================================================

describe("routeRunningKey — permission keys", () => {
  test("y approves permission when pending", () => {
    const { actions, log } = mockActions({ hasPermissions: true });
    routeRunningKey(keyEvent("y"), defaultState(), actions);
    expect(log.calls).toContain("approvePermission");
  });

  test("y does nothing when no permissions", () => {
    const { actions } = mockActions({ hasPermissions: false });
    const handled = routeRunningKey(keyEvent("y"), defaultState(), actions);
    expect(handled).toBe(false);
  });

  test("n denies permission when pending", () => {
    const { actions, log } = mockActions({ hasPermissions: true });
    routeRunningKey(keyEvent("n"), defaultState(), actions);
    expect(log.calls).toContain("denyPermission");
  });

  test("n does nothing when no permissions", () => {
    const { actions } = mockActions({ hasPermissions: false });
    const handled = routeRunningKey(keyEvent("n"), defaultState(), actions);
    expect(handled).toBe(false);
  });
});

// ===========================================================================
// Normal mode — prompt entry
// ===========================================================================

describe("routeRunningKey — prompt entry", () => {
  test("m enters prompt mode when agent messaging available", () => {
    const { actions, log } = mockActions({ hasSendToAgent: true, hasActiveRoles: true });
    routeRunningKey(keyEvent("m"), defaultState(), actions);
    expect(log.calls).toContain("enterPromptMode");
  });

  test(": enters goto mode (C2)", () => {
    const { actions, log } = mockActions({ hasSendToAgent: true, hasActiveRoles: true });
    routeRunningKey(keyEvent(":", { sequence: ":" }), defaultState(), actions);
    expect(log.calls).toContain("enterGotoMode");
    expect(log.calls).not.toContain("enterPromptMode");
  });

  test("m does NOT enter prompt when no sendToAgent", () => {
    const { actions, log } = mockActions({ hasSendToAgent: false, hasActiveRoles: true });
    routeRunningKey(keyEvent("m"), defaultState(), actions);
    // m is unhandled if no sendToAgent
    expect(log.calls).not.toContain("enterPromptMode");
  });
});

// ===========================================================================
// Escape layered dismissal (Issue 10)
// ===========================================================================

describe("routeRunningKey — Escape layered dismissal", () => {
  test("Escape dismisses VFS overlay first", () => {
    const { actions, log } = mockActions();
    const state = defaultState({
      showVfs: true,
      expandedPanel: RunningPanel.Dag,
      zoomLevel: "half",
      confirmQuit: true,
    });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.calls).toContain("dismissVfs");
    expect(log.calls).not.toContain("collapsePanel");
    expect(log.calls).not.toContain("setConfirmQuit");
  });

  test("Escape cancels quit confirm second", () => {
    const { actions, log } = mockActions();
    const state = defaultState({
      confirmQuit: true,
      expandedPanel: RunningPanel.Dag,
      zoomLevel: "half",
    });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.args.setConfirmQuit).toEqual([false]);
    expect(log.calls).not.toContain("collapsePanel");
  });

  test("Escape clears retained filterQuery before collapsing panel", () => {
    const { actions, log } = mockActions();
    const state = defaultState({
      filterQuery: "foo",
      expandedPanel: RunningPanel.Agents,
      zoomLevel: "half",
    });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.calls).toContain("clearFilterQuery");
    expect(log.calls).not.toContain("collapsePanel");
  });

  test("Escape collapses expanded panel third", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ expandedPanel: RunningPanel.Terminal, zoomLevel: "half" });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.calls).toContain("collapsePanel");
  });

  test("Escape with nothing active is still handled (no-op)", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("escape"), defaultState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).toEqual([]); // handled but no action
  });
});

// ===========================================================================
// q key with VFS overlay
// ===========================================================================

describe("routeRunningKey — q key with overlays", () => {
  test("q dismisses VFS instead of quit-confirming", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("q"), defaultState({ showVfs: true }), actions);
    expect(log.calls).toContain("dismissVfs");
    expect(log.calls).not.toContain("setConfirmQuit");
  });
});

// ===========================================================================
// Prompt input mode (Issue 10 — mode × key matrix)
// ===========================================================================

describe("routeRunningKey — prompt mode", () => {
  const promptState = defaultState({ promptMode: true, promptText: "hello" });

  test("Escape exits prompt mode", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("escape"), promptState, actions);
    expect(log.calls).toContain("exitPromptMode");
  });

  test("Enter submits prompt when text is non-empty", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("return"), promptState, actions);
    expect(log.calls).toContain("submitPrompt");
  });

  test("Enter does NOT submit when prompt text is empty", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(
      keyEvent("return"),
      defaultState({ promptMode: true, promptText: "" }),
      actions,
    );
    expect(handled).toBe(true); // swallowed
    expect(log.calls).not.toContain("submitPrompt");
  });

  test("Tab cycles prompt target", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("tab"), promptState, actions);
    expect(log.calls).toContain("cyclePromptTarget");
  });

  test("backspace deletes character", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("backspace"), promptState, actions);
    expect(log.calls).toContain("deletePromptChar");
  });

  test("regular character appends", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("a", { sequence: "a" }), promptState, actions);
    expect(log.args.appendPromptChar).toEqual(["a"]);
  });

  test("space appends space", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("space"), promptState, actions);
    expect(log.args.appendPromptChar).toEqual([" "]);
  });

  test("number keys are swallowed (NOT panel expand)", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("1", { sequence: "1" }), promptState, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("expandPanel");
    expect(log.args.appendPromptChar).toEqual(["1"]);
  });

  test("f is swallowed (NOT fullscreen toggle)", () => {
    const { actions, log } = mockActions();
    const state = defaultState({
      promptMode: true,
      promptText: "hi",
      expandedPanel: RunningPanel.Dag,
      zoomLevel: "half",
    });
    const handled = routeRunningKey(keyEvent("f", { sequence: "f" }), state, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("toggleFullscreen");
  });

  test("Ctrl+G is swallowed in prompt mode", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("g", { ctrl: true }), promptState, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("enterInspect");
  });
});

// ===========================================================================
// Help mode (Issue 10 — mode × key matrix)
// ===========================================================================

describe("routeRunningKey — help mode", () => {
  const helpState = defaultState({ showHelp: true });

  test("? dismisses help", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("?"), helpState, actions);
    expect(log.calls).toContain("dismissHelp");
  });

  test("Escape dismisses help", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("escape"), helpState, actions);
    expect(log.calls).toContain("dismissHelp");
  });

  test("number keys are swallowed (NOT panel expand)", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("3"), helpState, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("expandPanel");
  });

  test("j/k are swallowed (NOT feed scroll)", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("j"), helpState, actions);
    expect(log.calls).not.toContain("feedCursorDown");
  });

  test("q is swallowed (NOT quit)", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("q"), helpState, actions);
    expect(log.calls).not.toContain("quit");
    expect(log.calls).not.toContain("setConfirmQuit");
  });

  test("f is swallowed (NOT fullscreen)", () => {
    const { actions, log } = mockActions();
    const state = {
      ...helpState,
      expandedPanel: RunningPanel.Dag as RunningPanel | null,
      zoomLevel: "half" as const,
    };
    routeRunningKey(keyEvent("f"), state, actions);
    expect(log.calls).not.toContain("toggleFullscreen");
  });
});

// ===========================================================================
// Trace panel mode (issue #183)
// ===========================================================================

describe("Trace panel mode", () => {
  const traceState = () => defaultState({ expandedPanel: RunningPanel.Trace, zoomLevel: "half" });

  test("e toggles Trace panel open", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("e"), defaultState(), actions);
    expect(log.calls).toContain("expandPanel");
    expect(log.args.expandPanel).toEqual([RunningPanel.Trace]);
  });

  test("e toggles Trace panel closed when already open", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("e"), traceState(), actions);
    expect(log.calls).toContain("expandPanel");
    expect(log.args.expandPanel).toEqual([RunningPanel.Trace]);
  });

  test("j routes to traceSelectDown when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("j"), traceState(), actions);
    expect(log.calls).toContain("traceSelectDown");
    expect(log.calls).not.toContain("feedCursorDown");
  });

  test("k routes to traceSelectUp when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("k"), traceState(), actions);
    expect(log.calls).toContain("traceSelectUp");
    expect(log.calls).not.toContain("feedCursorUp");
  });

  test("down arrow routes to traceSelectDown when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("down"), traceState(), actions);
    expect(log.calls).toContain("traceSelectDown");
  });

  test("up arrow routes to traceSelectUp when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("up"), traceState(), actions);
    expect(log.calls).toContain("traceSelectUp");
  });

  test("J (shift+j) routes to traceScrollDown", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("j", { shift: true, sequence: "J" }), traceState(), actions);
    expect(log.calls).toContain("traceScrollDown");
  });

  test("K (shift+k) routes to traceScrollUp", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("k", { shift: true, sequence: "K" }), traceState(), actions);
    expect(log.calls).toContain("traceScrollUp");
  });

  test("G (shift+g) routes to traceScrollToBottom", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("g", { shift: true, sequence: "G" }), traceState(), actions);
    expect(log.calls).toContain("traceScrollToBottom");
  });

  test("g routes to traceScrollToTop", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("g"), traceState(), actions);
    expect(log.calls).toContain("traceScrollToTop");
  });

  test("Tab routes to traceCycleAgent", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("tab"), traceState(), actions);
    expect(log.calls).toContain("traceCycleAgent");
  });

  test("f toggles fullscreen when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("f"), traceState(), actions);
    expect(log.calls).toContain("toggleFullscreen");
  });

  test("Escape collapses Trace panel", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("escape"), traceState(), actions);
    expect(log.calls).toContain("collapsePanel");
  });

  test("j routes to feedCursorDown when Trace is NOT expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("j"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorDown");
    expect(log.calls).not.toContain("traceSelectDown");
  });

  test("k routes to feedCursorUp when Trace is NOT expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("k"), defaultState(), actions);
    expect(log.calls).toContain("feedCursorUp");
    expect(log.calls).not.toContain("traceSelectUp");
  });

  test("j routes to feedCursorDown when other panel (Feed) is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(
      keyEvent("j"),
      defaultState({ expandedPanel: RunningPanel.Feed, zoomLevel: "half" }),
      actions,
    );
    expect(log.calls).toContain("feedCursorDown");
  });

  test("? still opens help when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("?", { shift: true, sequence: "?" }), traceState(), actions);
    expect(log.calls).toContain("toggleHelp");
  });

  test("Ctrl+G still enters inspect when Trace is expanded", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("g", { ctrl: true }), traceState(), actions);
    expect(log.calls).toContain("enterInspect");
  });
});

// ===========================================================================
// C2 keyboard routing (Task 11)
// ===========================================================================

describe("C2 keyboard routing", () => {
  test("':' enters goto mode (NOT message mode)", () => {
    const { actions, log } = mockActions({ hasSendToAgent: true, hasActiveRoles: true });
    routeRunningKey(keyEvent(":", { sequence: ":" }), defaultState(), actions);
    expect(log.calls).toContain("enterGotoMode");
    expect(log.calls).not.toContain("enterPromptMode");
  });

  test("'m' still enters message mode", () => {
    const { actions, log } = mockActions({ hasSendToAgent: true, hasActiveRoles: true });
    routeRunningKey(keyEvent("m"), defaultState(), actions);
    expect(log.calls).toContain("enterPromptMode");
  });

  test("'/' enters filter mode", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("/", { sequence: "/" }), defaultState(), actions);
    expect(log.calls).toContain("enterFilterMode");
  });
});

// ===========================================================================
// C2 prompt-mode key routing (Task 12)
// ===========================================================================

describe("C2 prompt-mode key routing", () => {
  test("typing in cmdMode appends char", () => {
    const { actions, log } = mockActions();
    routeRunningKey(
      keyEvent("a", { sequence: "a" }),
      defaultState({ cmdMode: "goto", cmdText: "" }),
      actions,
    );
    expect(log.calls).toContain("cmdAppendChar");
  });

  test("Tab in goto mode triggers cmdTabComplete", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("tab"), defaultState({ cmdMode: "goto", cmdText: "a" }), actions);
    expect(log.calls).toContain("cmdTabComplete");
  });

  test("Enter in cmdMode triggers cmdSubmit", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("return"), defaultState({ cmdMode: "goto", cmdText: "a" }), actions);
    expect(log.calls).toContain("cmdSubmit");
  });

  test("Esc with non-empty text clears text", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("escape"), defaultState({ cmdMode: "goto", cmdText: "abc" }), actions);
    expect(log.calls).toContain("cmdClearText");
    expect(log.calls).not.toContain("cmdExit");
  });

  test("Esc with empty text exits cmdMode", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("escape"), defaultState({ cmdMode: "goto", cmdText: "" }), actions);
    expect(log.calls).toContain("cmdExit");
    expect(log.calls).not.toContain("cmdClearText");
  });

  test("backspace in cmdMode triggers cmdDeleteChar", () => {
    const { actions, log } = mockActions();
    routeRunningKey(
      keyEvent("backspace"),
      defaultState({ cmdMode: "goto", cmdText: "ab" }),
      actions,
    );
    expect(log.calls).toContain("cmdDeleteChar");
  });

  test("Tab does NOT trigger cmdTabComplete in filter mode", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("tab"), defaultState({ cmdMode: "filter", cmdText: "" }), actions);
    expect(log.calls).not.toContain("cmdTabComplete");
  });
});

// ===========================================================================
// stripAnsi (shared utility)
// ===========================================================================

describe("stripAnsi", () => {
  test("strips CSI sequences", async () => {
    const { stripAnsi } = await import("../../shared/format.js");
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  test("strips OSC sequences", async () => {
    const { stripAnsi } = await import("../../shared/format.js");
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  test("handles plain text", async () => {
    const { stripAnsi } = await import("../../shared/format.js");
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

// ===========================================================================
// RunningPanel new entries
// ===========================================================================

describe("RunningPanel new entries", () => {
  test("Sessions/Tasks/Reviews panels are defined", () => {
    expect(RunningPanel.Sessions).toBe(6);
    expect(RunningPanel.Tasks).toBe(7);
    expect(RunningPanel.Reviews).toBe(8);
  });

  test("RUNNING_PANEL_LABELS includes new panels", () => {
    expect(RUNNING_PANEL_LABELS[RunningPanel.Sessions]).toBe("Sessions");
    expect(RUNNING_PANEL_LABELS[RunningPanel.Tasks]).toBe("Tasks");
    expect(RUNNING_PANEL_LABELS[RunningPanel.Reviews]).toBe("Reviews");
  });
});

// ===========================================================================
// LogView keyboard routing (#310)
// ===========================================================================

describe("routeRunningKey — LogView mode (#310)", () => {
  const logActiveState = () =>
    defaultState({
      expandedPanel: RunningPanel.Terminal,
      zoomLevel: "half",
      logFilterMode: false,
    });
  const logFilterState = () =>
    defaultState({
      expandedPanel: RunningPanel.Terminal,
      zoomLevel: "half",
      logFilterMode: true,
    });

  test("space toggles pause when LogView is active", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    const handled = routeRunningKey(keyEvent("space"), logActiveState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).toContain("logTogglePause");
  });

  test("'/' enters filter mode (overrides global C2 filter)", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    const handled = routeRunningKey(keyEvent("/", { sequence: "/" }), logActiveState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).toContain("logEnterFilterMode");
    expect(log.calls).not.toContain("enterFilterMode");
  });

  test("j scrolls log down", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("j"), logActiveState(), actions);
    expect(log.calls).toContain("logScrollDown");
    expect(log.calls).not.toContain("feedCursorDown");
  });

  test("k scrolls log up", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("k"), logActiveState(), actions);
    expect(log.calls).toContain("logScrollUp");
    expect(log.calls).not.toContain("feedCursorUp");
  });

  test("down/up arrows scroll log", () => {
    const { actions: a1, log: l1 } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("down"), logActiveState(), a1);
    expect(l1.calls).toContain("logScrollDown");

    const { actions: a2, log: l2 } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("up"), logActiveState(), a2);
    expect(l2.calls).toContain("logScrollUp");
  });

  test("Shift+G jumps to bottom (resume tail)", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("g", { shift: true, sequence: "G" }), logActiveState(), actions);
    expect(log.calls).toContain("logScrollToBottom");
    expect(log.calls).not.toContain("logScrollToTop");
  });

  test("g jumps to top", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("g"), logActiveState(), actions);
    expect(log.calls).toContain("logScrollToTop");
  });

  test("in filter mode, Enter commits filter", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("return"), logFilterState(), actions);
    expect(log.calls).toContain("logCommitFilter");
  });

  test("in filter mode, Escape cancels filter (does not collapse panel)", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("escape"), logFilterState(), actions);
    expect(log.calls).toContain("logCancelFilter");
    expect(log.calls).not.toContain("collapsePanel");
  });

  test("in filter mode, backspace drops last char", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("backspace"), logFilterState(), actions);
    expect(log.calls).toContain("logFilterBackspace");
  });

  test("in filter mode, printable keys append to filter buffer", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    const handled = routeRunningKey(keyEvent("a", { sequence: "a" }), logFilterState(), actions);
    expect(handled).toBe(true);
    expect(log.args.logFilterAppend).toEqual(["a"]);
  });

  test("in filter mode, non-printable keys are swallowed (not routed to feed)", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    // 'tab' is not handled by the filter-mode branch; it should be swallowed.
    const handled = routeRunningKey(keyEvent("tab"), logFilterState(), actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("feedCursorDown");
    expect(log.calls).not.toContain("traceCycleAgent");
  });

  test("LogView keys are inert when logViewActive is false", () => {
    const { actions, log } = mockActions({ logViewActive: false });
    const handled = routeRunningKey(keyEvent("space"), logActiveState(), actions);
    // 'space' has no global handler outside LogView/cmd-mode → returns false.
    expect(handled).toBe(false);
    expect(log.calls).not.toContain("logTogglePause");
  });

  test("LogView keys are inert when Terminal panel is not expanded", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    const state = defaultState({ expandedPanel: RunningPanel.Dag, zoomLevel: "half" });
    routeRunningKey(keyEvent("space"), state, actions);
    expect(log.calls).not.toContain("logTogglePause");
  });

  test("panel-switch shortcuts still work over LogView (fallthrough)", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("3"), logActiveState(), actions);
    expect(log.args.expandPanel).toEqual([RunningPanel.Dag]);
  });

  test("? still toggles help when LogView is active", () => {
    const { actions, log } = mockActions({ logViewActive: true });
    routeRunningKey(keyEvent("?", { shift: true, sequence: "?" }), logActiveState(), actions);
    expect(log.calls).toContain("toggleHelp");
  });
});
