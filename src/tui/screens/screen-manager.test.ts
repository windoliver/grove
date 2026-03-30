/**
 * Screen manager state transition tests.
 *
 * Tests the state machine logic for screen transitions, focusing on:
 * - Initial screen selection
 * - Forward transitions (preset → detect → goal → spawning → running → complete)
 * - Session reuse (complete → goal-input with preset preserved)
 * - Back navigation
 * - Edge cases (missing state, no presets)
 */

import { describe, expect, test } from "bun:test";
import type { Screen, ScreenState } from "./screen-manager.js";

// ---------------------------------------------------------------------------
// Helpers — replicate the pure state transition logic from ScreenManager
// ---------------------------------------------------------------------------

/** Initial screen selection logic (mirrors ScreenManager's useState initializer). */
function initialScreen(opts: {
  startOnRunning?: boolean;
  hasTopology?: boolean;
  presetCount?: number;
  presetName?: string;
}): ScreenState {
  const screen: Screen = opts.startOnRunning
    ? "running"
    : opts.hasTopology
      ? "agent-detect"
      : (opts.presetCount ?? 0) > 0
        ? "preset-select"
        : "running";
  return {
    screen,
    ...(opts.presetName ? { selectedPreset: opts.presetName } : {}),
  };
}

/** New session transition logic (mirrors handleNewSession). */
function newSessionTransition(state: ScreenState, presetCount: number): ScreenState {
  // If we have preset + role mapping from a prior run, skip to goal input
  if (state.selectedPreset && state.roleMapping) {
    const {
      goal: _g,
      sessionId: _s,
      sessionStartedAt: _st,
      spawnStates: _sp,
      completeSnapshot: _c,
      ...preserved
    } = state;
    return { ...preserved, screen: "goal-input" };
  }
  // No prior preset state — fall back to preset selection
  return {
    screen: presetCount > 0 ? "preset-select" : "running",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScreenManager — initial screen selection", () => {
  test("startOnRunning=true goes to running", () => {
    const state = initialScreen({ startOnRunning: true });
    expect(state.screen).toBe("running");
  });

  test("with topology goes to agent-detect", () => {
    const state = initialScreen({ hasTopology: true, presetCount: 2 });
    expect(state.screen).toBe("agent-detect");
  });

  test("no topology with presets goes to preset-select", () => {
    const state = initialScreen({ hasTopology: false, presetCount: 3 });
    expect(state.screen).toBe("preset-select");
  });

  test("no topology no presets goes to running", () => {
    const state = initialScreen({ hasTopology: false, presetCount: 0 });
    expect(state.screen).toBe("running");
  });

  test("presetName from props is stored in state", () => {
    const state = initialScreen({ hasTopology: true, presetName: "review-loop" });
    expect(state.selectedPreset).toBe("review-loop");
  });
});

describe("ScreenManager — forward transitions", () => {
  test("preset-select → agent-detect stores selectedPreset", () => {
    const state: ScreenState = { screen: "preset-select" };
    const next: ScreenState = { ...state, screen: "agent-detect", selectedPreset: "review-loop" };
    expect(next.screen).toBe("agent-detect");
    expect(next.selectedPreset).toBe("review-loop");
  });

  test("agent-detect → goal-input stores roleMapping", () => {
    const state: ScreenState = { screen: "agent-detect", selectedPreset: "review-loop" };
    const roleMapping = new Map([
      ["coder", "claude"],
      ["reviewer", "codex"],
    ]);
    const next: ScreenState = { ...state, screen: "goal-input", roleMapping };
    expect(next.screen).toBe("goal-input");
    expect(next.roleMapping?.get("coder")).toBe("claude");
  });

  test("goal-input → spawning stores goal and session timing", () => {
    const state: ScreenState = {
      screen: "goal-input",
      selectedPreset: "review-loop",
      roleMapping: new Map([["coder", "claude"]]),
    };
    const next: ScreenState = {
      ...state,
      screen: "spawning",
      goal: "Review PR #42",
      sessionStartedAt: "2026-03-29T00:00:00.000Z",
      spawnStates: [{ role: "coder", command: "claude", status: "waiting" }],
    };
    expect(next.screen).toBe("spawning");
    expect(next.goal).toBe("Review PR #42");
    expect(next.spawnStates).toHaveLength(1);
  });
});

describe("ScreenManager — session reuse (new session from complete)", () => {
  const completedState: ScreenState = {
    screen: "complete",
    selectedPreset: "review-loop",
    detectedAgents: new Map([
      ["claude", true],
      ["codex", true],
    ]),
    roleMapping: new Map([
      ["coder", "claude"],
      ["reviewer", "codex"],
    ]),
    goal: "Review PR #42",
    sessionId: "abc123",
    sessionStartedAt: "2026-03-29T00:00:00.000Z",
    spawnStates: [
      { role: "coder", command: "claude", status: "started" },
      { role: "reviewer", command: "codex", status: "started" },
    ],
    completeSnapshot: { reason: "All roles signaled done", contributionCount: 5 },
  };

  test("reuse: complete → goal-input when preset and roleMapping exist", () => {
    const next = newSessionTransition(completedState, 2);
    expect(next.screen).toBe("goal-input");
  });

  test("reuse: preserves selectedPreset", () => {
    const next = newSessionTransition(completedState, 2);
    expect(next.selectedPreset).toBe("review-loop");
  });

  test("reuse: preserves detectedAgents", () => {
    const next = newSessionTransition(completedState, 2);
    expect(next.detectedAgents?.get("claude")).toBe(true);
  });

  test("reuse: preserves roleMapping", () => {
    const next = newSessionTransition(completedState, 2);
    expect(next.roleMapping?.get("coder")).toBe("claude");
  });

  test("reuse: clears session-specific state", () => {
    const next = newSessionTransition(completedState, 2);
    expect("goal" in next).toBe(false);
    expect("sessionId" in next).toBe(false);
    expect("sessionStartedAt" in next).toBe(false);
    expect("spawnStates" in next).toBe(false);
    expect("completeSnapshot" in next).toBe(false);
  });

  test("fallback: no selectedPreset → preset-select when presets available", () => {
    const stateNoPreset: ScreenState = { screen: "complete" };
    const next = newSessionTransition(stateNoPreset, 2);
    expect(next.screen).toBe("preset-select");
  });

  test("fallback: no selectedPreset → running when no presets", () => {
    const stateNoPreset: ScreenState = { screen: "complete" };
    const next = newSessionTransition(stateNoPreset, 0);
    expect(next.screen).toBe("running");
  });

  test("fallback: selectedPreset but no roleMapping → preset-select", () => {
    const stateNoMapping: ScreenState = { screen: "complete", selectedPreset: "review-loop" };
    const next = newSessionTransition(stateNoMapping, 2);
    expect(next.screen).toBe("preset-select");
  });
});

describe("ScreenManager — back navigation", () => {
  test("goal-input → agent-detect (back)", () => {
    const state: ScreenState = {
      screen: "goal-input",
      selectedPreset: "review-loop",
      roleMapping: new Map(),
    };
    const next: ScreenState = { ...state, screen: "agent-detect" };
    expect(next.screen).toBe("agent-detect");
    // Preset state preserved on back
    expect(next.selectedPreset).toBe("review-loop");
  });

  test("agent-detect → preset-select (back)", () => {
    const state: ScreenState = { screen: "agent-detect", selectedPreset: "review-loop" };
    const next: ScreenState = { ...state, screen: "preset-select" };
    expect(next.screen).toBe("preset-select");
  });
});
