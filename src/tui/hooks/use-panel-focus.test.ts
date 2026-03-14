/**
 * Tests for the panel focus state machine (pure transitions).
 */

import { describe, expect, test } from "bun:test";
import {
  getVisiblePanels,
  InputMode,
  initialPanelState,
  isPanelVisible,
  Panel,
  panelCycleNext,
  panelCyclePrev,
  panelFocus,
  panelSetMode,
  panelToggle,
} from "./use-panel-focus.js";

describe("initialPanelState", () => {
  test("defaults to DAG focused, no operator panels, normal mode", () => {
    const s = initialPanelState();
    expect(s.focused).toBe(Panel.Dag);
    expect(s.visibleOperator.size).toBe(0);
    expect(s.mode).toBe(InputMode.Normal);
  });
});

describe("panelFocus", () => {
  test("focuses a core panel", () => {
    const s = panelFocus(initialPanelState(), Panel.Frontier);
    expect(s.focused).toBe(Panel.Frontier);
  });

  test("ignores focus on hidden operator panel", () => {
    const s = panelFocus(initialPanelState(), Panel.AgentList);
    expect(s.focused).toBe(Panel.Dag); // unchanged
  });

  test("focuses a visible operator panel", () => {
    let s = panelToggle(initialPanelState(), Panel.Terminal);
    s = panelFocus(s, Panel.Terminal);
    expect(s.focused).toBe(Panel.Terminal);
  });

  test("returns same state if already focused", () => {
    const s = initialPanelState();
    const s2 = panelFocus(s, Panel.Dag);
    expect(s2).toBe(s); // referential equality
  });
});

describe("panelToggle", () => {
  test("shows an operator panel and focuses it", () => {
    const s = panelToggle(initialPanelState(), Panel.AgentList);
    expect(s.visibleOperator.has(Panel.AgentList)).toBe(true);
    expect(s.focused).toBe(Panel.AgentList);
  });

  test("hides an operator panel and refocuses to DAG", () => {
    let s = panelToggle(initialPanelState(), Panel.AgentList);
    s = panelToggle(s, Panel.AgentList);
    expect(s.visibleOperator.has(Panel.AgentList)).toBe(false);
    expect(s.focused).toBe(Panel.Dag);
  });

  test("hiding a non-focused panel preserves focus", () => {
    let s = panelToggle(initialPanelState(), Panel.AgentList);
    s = panelFocus(s, Panel.Frontier);
    s = panelToggle(s, Panel.AgentList);
    expect(s.focused).toBe(Panel.Frontier);
  });

  test("ignores toggle on core panel", () => {
    const original = initialPanelState();
    const s = panelToggle(original, Panel.Dag);
    expect(s).toBe(original); // referential equality — no change
  });
});

describe("panelCycleNext / panelCyclePrev", () => {
  test("cycles through core panels only when no operator panels visible", () => {
    let s = initialPanelState(); // focused: DAG
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Detail);
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Frontier);
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Claims);
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Dag); // wraps
  });

  test("cycles backward", () => {
    let s = initialPanelState(); // focused: DAG
    s = panelCyclePrev(s);
    expect(s.focused).toBe(Panel.Claims); // wraps to last
    s = panelCyclePrev(s);
    expect(s.focused).toBe(Panel.Frontier);
  });

  test("includes visible operator panels in cycle", () => {
    let s = panelToggle(initialPanelState(), Panel.Terminal);
    s = panelFocus(s, Panel.Claims); // focus Claims, Terminal is visible
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Terminal); // operator panel after core
    s = panelCycleNext(s);
    expect(s.focused).toBe(Panel.Dag); // wraps
  });
});

describe("panelSetMode", () => {
  test("changes input mode", () => {
    const s = panelSetMode(initialPanelState(), InputMode.CommandPalette);
    expect(s.mode).toBe(InputMode.CommandPalette);
  });

  test("returns same state if mode unchanged", () => {
    const s = initialPanelState();
    const s2 = panelSetMode(s, InputMode.Normal);
    expect(s2).toBe(s);
  });

  test("enters Help mode", () => {
    const s = panelSetMode(initialPanelState(), InputMode.Help);
    expect(s.mode).toBe(InputMode.Help);
  });

  test("exits Help mode back to Normal", () => {
    let s = panelSetMode(initialPanelState(), InputMode.Help);
    s = panelSetMode(s, InputMode.Normal);
    expect(s.mode).toBe(InputMode.Normal);
  });
});

describe("isPanelVisible", () => {
  test("core panels are always visible", () => {
    const s = initialPanelState();
    expect(isPanelVisible(s, Panel.Dag)).toBe(true);
    expect(isPanelVisible(s, Panel.Detail)).toBe(true);
    expect(isPanelVisible(s, Panel.Frontier)).toBe(true);
    expect(isPanelVisible(s, Panel.Claims)).toBe(true);
  });

  test("operator panels are hidden by default", () => {
    const s = initialPanelState();
    expect(isPanelVisible(s, Panel.AgentList)).toBe(false);
    expect(isPanelVisible(s, Panel.Terminal)).toBe(false);
  });
});

describe("getVisiblePanels", () => {
  test("returns only core panels by default", () => {
    const panels = getVisiblePanels(initialPanelState());
    expect(panels).toEqual([Panel.Dag, Panel.Detail, Panel.Frontier, Panel.Claims]);
  });

  test("includes toggled operator panels", () => {
    let s = panelToggle(initialPanelState(), Panel.Terminal);
    s = panelToggle(s, Panel.Artifact);
    const panels = getVisiblePanels(s);
    expect(panels).toEqual([
      Panel.Dag,
      Panel.Detail,
      Panel.Frontier,
      Panel.Claims,
      Panel.Terminal,
      Panel.Artifact,
    ]);
  });
});
