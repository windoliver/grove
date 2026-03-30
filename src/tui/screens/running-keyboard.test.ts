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
  type RunningKeyboardActions,
  type RunningKeyboardState,
  RunningPanel,
  collapsePanel,
  expandPanel,
  routeRunningKey,
  toggleFullscreen,
} from "./running-keyboard.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function keyEvent(name: string, opts?: { ctrl?: boolean; shift?: boolean; sequence?: string }): KeyEvent {
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
    preventDefault: () => {},
    stopPropagation: () => {},
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
    ...overrides,
  };
}

function mockActions(overrides?: {
  hasPermissions?: boolean;
  hasActiveRoles?: boolean;
  hasSendToAgent?: boolean;
  feedLength?: number;
  hasAskUser?: boolean;
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
    feedCursorDown: () => record("feedCursorDown"),
    feedCursorUp: () => record("feedCursorUp"),
    scrollToAskUser: () => record("scrollToAskUser"),
    openDetail: () => record("openDetail"),
    toggleAdvanced: () => record("toggleAdvanced"),
    quit: () => record("quit"),
    approvePermission: () => record("approvePermission"),
    denyPermission: () => record("denyPermission"),
    hasPermissions: overrides?.hasPermissions ?? false,
    hasActiveRoles: overrides?.hasActiveRoles ?? false,
    hasSendToAgent: overrides?.hasSendToAgent ?? false,
    feedLength: overrides?.feedLength ?? 10,
    hasAskUser: overrides?.hasAskUser ?? false,
  };

  return { actions, log };
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
    { desc: "no panel → no-op", panel: null, zoom: "normal", expectPanel: null, expectZoom: "normal" },
    { desc: "half → full", panel: RunningPanel.Dag, zoom: "half", expectPanel: RunningPanel.Dag, expectZoom: "full" },
    { desc: "full → half", panel: RunningPanel.Dag, zoom: "full", expectPanel: RunningPanel.Dag, expectZoom: "half" },
    { desc: "normal with panel → full", panel: RunningPanel.Terminal, zoom: "normal", expectPanel: RunningPanel.Terminal, expectZoom: "full" },
    { desc: "half feed → full feed", panel: RunningPanel.Feed, zoom: "half", expectPanel: RunningPanel.Feed, expectZoom: "full" },
    { desc: "full agents → half agents", panel: RunningPanel.Agents, zoom: "full", expectPanel: RunningPanel.Agents, expectZoom: "half" },
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
  test("q sets confirm quit", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("q"), defaultState(), actions);
    expect(log.args.setConfirmQuit).toEqual([true]);
  });

  test("q with confirmQuit=true quits", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("q"), defaultState({ confirmQuit: true }), actions);
    expect(log.calls).toContain("quit");
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

  test("Ctrl+A toggles advanced", () => {
    const { actions, log } = mockActions();
    routeRunningKey(keyEvent("a", { ctrl: true }), defaultState(), actions);
    expect(log.calls).toContain("toggleAdvanced");
  });

  test("Enter opens detail when feed has items", () => {
    const { actions, log } = mockActions({ feedLength: 5 });
    routeRunningKey(keyEvent("return"), defaultState(), actions);
    expect(log.calls).toContain("openDetail");
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
    const { actions, log } = mockActions({ hasAskUser: false });
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
    const { actions, log } = mockActions({ hasPermissions: false });
    const handled = routeRunningKey(keyEvent("y"), defaultState(), actions);
    expect(handled).toBe(false);
  });

  test("n denies permission when pending", () => {
    const { actions, log } = mockActions({ hasPermissions: true });
    routeRunningKey(keyEvent("n"), defaultState(), actions);
    expect(log.calls).toContain("denyPermission");
  });

  test("n does nothing when no permissions", () => {
    const { actions, log } = mockActions({ hasPermissions: false });
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

  test(": enters prompt mode when agent messaging available", () => {
    const { actions, log } = mockActions({ hasSendToAgent: true, hasActiveRoles: true });
    routeRunningKey(keyEvent(":", { sequence: ":" }), defaultState(), actions);
    expect(log.calls).toContain("enterPromptMode");
  });

  test("m does NOT enter prompt when no sendToAgent", () => {
    const { actions, log } = mockActions({ hasSendToAgent: false, hasActiveRoles: true });
    const handled = routeRunningKey(keyEvent("m"), defaultState(), actions);
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
    const state = defaultState({ showVfs: true, expandedPanel: RunningPanel.Dag, zoomLevel: "half", confirmQuit: true });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.calls).toContain("dismissVfs");
    expect(log.calls).not.toContain("collapsePanel");
    expect(log.calls).not.toContain("setConfirmQuit");
  });

  test("Escape cancels quit confirm second", () => {
    const { actions, log } = mockActions();
    const state = defaultState({ confirmQuit: true, expandedPanel: RunningPanel.Dag, zoomLevel: "half" });
    routeRunningKey(keyEvent("escape"), state, actions);
    expect(log.args.setConfirmQuit).toEqual([false]);
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
    const handled = routeRunningKey(keyEvent("return"), defaultState({ promptMode: true, promptText: "" }), actions);
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
    const state = defaultState({ promptMode: true, promptText: "hi", expandedPanel: RunningPanel.Dag, zoomLevel: "half" });
    const handled = routeRunningKey(keyEvent("f", { sequence: "f" }), state, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("toggleFullscreen");
  });

  test("Ctrl+A is swallowed in prompt mode", () => {
    const { actions, log } = mockActions();
    const handled = routeRunningKey(keyEvent("a", { ctrl: true }), promptState, actions);
    expect(handled).toBe(true);
    expect(log.calls).not.toContain("toggleAdvanced");
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
    const state = { ...helpState, expandedPanel: RunningPanel.Dag as RunningPanel | null, zoomLevel: "half" as const };
    routeRunningKey(keyEvent("f"), state, actions);
    expect(log.calls).not.toContain("toggleFullscreen");
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
